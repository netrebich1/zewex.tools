/**
 * Описание одного фото ИИ (факты + описание) — автопочинка перед написанием секции, если у фото нет фактов.
 * Порт _shared/photoDescribe.ts: vision-слот, temperature 0.2, maxTokens 800, 2 попытки,
 * принимаем только ≥8 слов описания и хоть один непустой факт.
 */
import { readFile } from "node:fs/promises";
import type { ArtPhoto } from "@prisma/client";
import { aiChat, imagePart, type AiCtx, type ContentPart } from "@/lib/articles/ai";
import { AiError } from "@/lib/pins/ai/errors";
import { SLOTS } from "@/lib/articles/types";
import { absPath, exists } from "@/lib/articles/storage";
import { photoFactFields, photoFactSkeleton, subjectLabel, type NicheProfile } from "@/lib/articles/photo/profile";
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
Facts fields: {${photoFactFields(profile)}}
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
      const facts = parsed.facts && typeof parsed.facts === "object" ? (parsed.facts as Record<string, unknown>) : null;
      const hasFacts = !!facts && Object.values(facts).some((v) => String(v || "").trim());
      if (description.split(/\s+/).length >= 8 && hasFacts && facts) return { description, facts };
    } catch (e) {
      // fatal_run (нет ключа/кредитов) должен всплыть — остальное повторяем
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
    }
  }
  return null;
}
