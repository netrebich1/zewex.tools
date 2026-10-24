/**
 * Описание фото ИИ (факты + описание).
 *  - `describePhoto` — одно фото: автопочинка перед написанием секции, если у фото нет фактов.
 *    Порт _shared/photoDescribe.ts: vision-слот, temperature 0.2, maxTokens 800, 2 попытки,
 *    принимаем только ≥8 слов описания и хоть один непустой факт.
 *  - `describePhotosBatch` — пачка до DESCRIBE_BATCH фото одним вызовом (cost-fixes-b: позднее описание итоговых фото
 *    в начале этапа plan, `photo/describeLate.ts`); тот же скелет фактов и правила, что у полной оценки.
 */
import { readFile } from "node:fs/promises";
import type { ArtPhoto } from "@prisma/client";
import { aiChat, imagePart, type AiCtx, type ContentPart } from "@/lib/articles/ai";
import { AiError } from "@/lib/pins/ai/errors";
import { SLOTS } from "@/lib/articles/types";
import { absPath, exists } from "@/lib/articles/storage";
import { photoFactRules, photoFactSkeleton, sanitizePhotoFacts, subjectLabel, type NicheProfile } from "@/lib/articles/photo/profile";
import { parseModelJsonSafe } from "./jsonRepair";

export type PhotoDescription = { description: string; facts: Record<string, unknown> };

/** Картинка для vision: локальный файл статьи, иначе публичный https-URL. */
async function photoPart(photo: Pick<ArtPhoto, "path" | "publicUrl" | "sourceUrl">): Promise<ContentPart | null> {
  if (photo.path && (await exists(photo.path))) {
    const bytes = await readFile(absPath(photo.path));
    return imagePart(bytes, "image/jpeg", "high");
  }
  const url = photo.publicUrl || photo.sourceUrl;
  if (/^https?:\/\//i.test(url)) return { type: "image_url", image_url: { url, detail: "high" } };
  return null;
}

/**
 * Возвращает null, если модель не справилась (вызывающий решает — исключить секцию, не валить пачку; аудит 03, §7.5).
 * (оригинал: photoDescribe.ts:6-35)
 */
export async function describePhoto(
  ai: AiCtx,
  profile: NicheProfile,
  keyword: string,
  photo: Pick<ArtPhoto, "path" | "publicUrl" | "sourceUrl">,
  model?: string,
): Promise<PhotoDescription | null> {
  const part = await photoPart(photo);
  if (!part) return null;
  const subject = subjectLabel(profile);
  const system = `You describe ONE editorial photo for an article about "${keyword}". A human editor already approved it — do not reject it.
Extract ON-TOPIC FACTS ONLY about ${subject}. Never mention other people, skin tone, background props, text or logos.
If a field is not visible use "" — never guess.
${photoFactRules(profile)}
Return ONLY JSON: {"facts":{${photoFactSkeleton(profile)}},"description":"30-60 words, English, factual, on-topic only"}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await aiChat(ai, {
        slot: SLOTS.vision,
        model,
        system,
        user: [{ type: "text", text: `Topic: ${keyword}` }, part],
        json: true,
        temperature: 0.2,
        maxTokens: 800,
        timeoutMs: 60_000,
      });
      const parsed = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as Record<string, unknown> | null;
      if (!parsed) continue;
      const description = String(parsed.description || "").trim().slice(0, 1200);
      // Заглушки и копии описаний полей («visible execution quality…», «none») не сохраняем (аудит text-v3).
      const facts = sanitizePhotoFacts(parsed.facts, profile);
      const hasFacts = !!facts;
      if (description.split(/\s+/).length >= 8 && hasFacts && facts) return { description, facts };
    } catch (e) {
      // fatal_run (нет ключа/кредитов) должен всплыть — остальное повторяем
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
    }
  }
  return null;
}

/** Фото в одном вызове позднего описания (как ratingBatchSize по умолчанию). */
export const DESCRIBE_BATCH = 8;

export type BatchPhoto = Pick<ArtPhoto, "id" | "path" | "publicUrl" | "sourceUrl">;
export type BatchDescribeResult = { described: Map<string, PhotoDescription>; costUsd: number; calls: number; failed: string[] };

/**
 * Описать несколько фото одним vision-вызовом: `{"photos":[{"n":1,"facts":{…},"description":"…"}]}`.
 * Фото без файла и без https-URL, а также те, по которым модель не ответила или ответила пусто, попадают в `failed`
 * (вызывающий добирает их `describePhoto` по одному). Ошибки класса fatal_run (нет ключа/кредитов) всплывают.
 */
export async function describePhotosBatch(
  ai: AiCtx,
  profile: NicheProfile,
  keyword: string,
  photos: BatchPhoto[],
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<BatchDescribeResult> {
  const out: BatchDescribeResult = { described: new Map(), costUsd: 0, calls: 0, failed: [] };
  const subject = subjectLabel(profile);
  const system = `You describe editorial photos for an article about "${keyword}". A human editor already approved every photo — never reject or judge them.
For EACH numbered photo extract ON-TOPIC FACTS ONLY about ${subject}. Never mention other people, skin tone, background props, text or logos.
If a field is not visible use "" — never guess.
${photoFactRules(profile)}
Also write "description": the same facts as dense factual prose, 30-60 words, English, on-topic only, no opinions.
Return ONLY JSON: {"photos":[{"n":1,"facts":{${photoFactSkeleton(profile)}},"description":"..."}]} — one entry per photo, same numbering.`;

  for (let i = 0; i < photos.length; i += DESCRIBE_BATCH) {
    const chunk = photos.slice(i, i + DESCRIBE_BATCH);
    const parts: ContentPart[] = [];
    const inBatch: BatchPhoto[] = [];
    for (const p of chunk) {
      const part = await photoPart(p);
      if (!part) { out.failed.push(p.id); continue; }
      inBatch.push(p);
      parts.push(part);
    }
    if (!inBatch.length) continue;
    const user: ContentPart[] = [{ type: "text", text: `Topic: ${keyword}\nPhotos (numbered in order): ${inBatch.map((_, n) => n + 1).join(", ")}` }, ...parts];
    const answered = new Set<string>();
    for (let attempt = 0; attempt < 2 && answered.size < inBatch.length; attempt++) {
      try {
        const r = await aiChat({ ...ai, signal: opts.signal ?? ai.signal }, {
          slot: SLOTS.vision,
          model: opts.model,
          system,
          user,
          json: true,
          temperature: 0.2,
          maxTokens: 600 * inBatch.length + 400,
          timeoutMs: 180_000,
        });
        out.calls++;
        out.costUsd += r.costUsd ?? 0;
        const parsed = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as Record<string, unknown> | null;
        const list = Array.isArray(parsed?.photos) ? (parsed!.photos as unknown[]) : Array.isArray(parsed?.results) ? (parsed!.results as unknown[]) : [];
        for (const raw of list) {
          const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
          const n = Number(item.n ?? item.index ?? 0);
          const photo = inBatch[n - 1];
          if (!photo || answered.has(photo.id)) continue;
          const description = String(item.description || "").trim().slice(0, 1200);
          const facts = sanitizePhotoFacts(item.facts, profile);
          if (description.split(/\s+/).length >= 8 && facts) {
            answered.add(photo.id);
            out.described.set(photo.id, { description, facts });
          }
        }
      } catch (e) {
        if (opts.signal?.aborted || (e instanceof AiError && e.cls.kind === "fatal_run")) throw e;
      }
    }
    for (const p of inBatch) if (!answered.has(p.id)) out.failed.push(p.id);
  }
  return out;
}
