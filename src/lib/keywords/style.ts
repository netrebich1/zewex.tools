/**
 * Оформление пинов топа: коллаж (несколько фото в одной картинке), фото с надписью (заголовок, плашка, текст поверх)
 * или чистое фото. Смотрит модель со зрением через слот `vision` инструмента «Подбор ключей» —
 * один запрос на снимок (до 10 картинок 236px), ~$0.001 на ключ у gemini-2.5-flash.
 */
import { prisma } from "@/lib/db";
import { resolveSlot, runSlot } from "@/lib/run";
import { parseJsonLenient } from "@/lib/pins/ai/json";
import { recomputeKeywords } from "./recompute";
import { KEYWORDS } from "./types";

export const SLOT_VISION = "vision";
export const STYLES = ["collage", "text", "photo"] as const;
export type PinStyle = (typeof STYLES)[number] | "unknown";

const PROMPT = `You classify Pinterest pin images from search results. For EACH image decide its design type:
- "collage": two or more separate photos combined in one image (grid, split, stacked photos), with or without text;
- "text": a single photo (or graphic) with overlaid text — a title, caption, banner, list, numbers, website name in large letters;
- "photo": a clean single photo without overlaid text (a tiny watermark or logo in a corner still counts as "photo").
Return JSON: {"pins":[{"n":1,"type":"photo"}, ...]} with one entry per image in the given order.`;

const MAX_BYTES = 400_000;

/** Картинка → data URL (pinimg отдаёт без авторизации; так не зависим от того, умеет ли провайдер скачивать сам). */
async function dataUrl(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") || "image/jpeg";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Кто «платит» за запрос: правила слота ищутся от имени владельца/админа (воркер работает без пользователя). */
async function actorId(): Promise<string | null> {
  const u = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return u?.id ?? null;
}

export type StyleTick = { snapshots: number; pins: number; skipped?: string };

/**
 * Один проход: до `limit` снимков, у которых есть картинки пинов без оформления. Пины без картинки (стартовые данные)
 * не трогаем — оформление у них появится после нового снимка выдачи.
 */
export async function styleTick(limit = 5): Promise<StyleTick> {
  const snaps = await prisma.kwSerpSnapshot.findMany({
    where: { pins: { some: { style: null, imageUrl: { not: null } } } },
    orderBy: { takenAt: "desc" }, take: limit,
    select: { id: true, keywordId: true, pins: { where: { style: null, imageUrl: { not: null } }, orderBy: { position: "asc" }, select: { id: true, imageUrl: true } } },
  });
  if (!snaps.length) return { snapshots: 0, pins: 0 };
  const userId = await actorId();
  if (!userId) return { snapshots: 0, pins: 0, skipped: "нет админа" };
  const resolved = await resolveSlot(userId, KEYWORDS, SLOT_VISION);
  if (!resolved.ok) return { snapshots: 0, pins: 0, skipped: resolved.status === 409 ? "ключ ИИ не подключён к «Подбору ключей» (слот vision)" : resolved.error };

  let pins = 0;
  const touched: string[] = [];
  for (const s of snaps) {
    const imgs = await Promise.all(s.pins.map(async (p) => ({ id: p.id, url: await dataUrl(p.imageUrl!) })));
    const ok = imgs.filter((x) => x.url);
    // Картинки, которые не скачались, помечаем unknown, чтобы не пытаться бесконечно.
    const dead = imgs.filter((x) => !x.url).map((x) => x.id);
    if (dead.length) await prisma.kwPin.updateMany({ where: { id: { in: dead } }, data: { style: "unknown" } });
    if (!ok.length) continue;
    const content: Array<Record<string, unknown>> = [{ type: "text", text: PROMPT }];
    ok.forEach((x, i) => {
      content.push({ type: "text", text: `Image ${i + 1}:` });
      content.push({ type: "image_url", image_url: { url: x.url } });
    });
    const res = await runSlot({
      userId, projectSlug: KEYWORDS, slotKey: SLOT_VISION, pre: resolved.value, timeoutMs: 90_000,
      payload: { messages: [{ role: "user", content }], temperature: 0, response_format: { type: "json_object" }, max_tokens: 600 },
      meta: { refId: s.keywordId },
    });
    if (!res.ok) {
      // Перегрузка, лимит, кредиты, сбой провайдера — повторим позже; иначе (модель не принимает картинки и т. п.) снимок не трогаем повторно.
      if ([402, 408, 429].includes(res.status) || res.status >= 500 || res.status === 0) throw new Error(`оформление пинов: ${res.error ?? `HTTP ${res.status}`}`);
      await prisma.kwPin.updateMany({ where: { id: { in: ok.map((x) => x.id) } }, data: { style: "unknown" } });
      continue;
    }
    const raw = (res.data as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> })?.choices?.[0]?.message?.content;
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p) => p?.text ?? "").join("") : "";
    const list = parseJsonLenient<{ pins?: Array<{ n?: unknown; type?: unknown }> }>(text)?.pins;
    if (!Array.isArray(list)) {
      await prisma.kwPin.updateMany({ where: { id: { in: ok.map((x) => x.id) } }, data: { style: "unknown" } });
      continue;
    }
    const byN = new Map(list.map((e, k) => [Number(e?.n) || k + 1, String(e?.type ?? "").toLowerCase()]));
    for (const [i, x] of ok.entries()) {
      const t = byN.get(i + 1);
      await prisma.kwPin.update({ where: { id: x.id }, data: { style: (STYLES as readonly string[]).includes(t ?? "") ? t! : "unknown" } });
      pins++;
    }
    touched.push(s.keywordId);
  }
  if (touched.length) await recomputeKeywords([...new Set(touched)]);
  return { snapshots: touched.length, pins };
}
