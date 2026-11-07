/**
 * Рамка главного объекта фото от модели со зрением (слот «быстрые тексты»: gemini-flash / gpt-mini).
 * Как дизайнер: что обязано остаться в кадре (вся причёска, руки с ногтями, блюдо…) и точка фокуса.
 * Считается один раз на фото, кэш на диске рядом с фото: pins/photos/<sha1(url)>.subject.json.
 */
import { readFile } from "fs/promises";
import { aiChat, type AiCtx } from "../ai/client";
import { SLOT_TEXT_FAST } from "../types";
import { sha1, toCleanJpeg } from "../images";
import { absPath, exists, writeFileAtomic } from "../storage";
import type { AccentType } from "./crop";

export type SubjectBox = { x0: number; y0: number; x1: number; y1: number; fx: number; fy: number };

const SUBJECT_HINT: Record<AccentType, string> = {
  auto: "the main subject of the photo",
  hair: "the head of the person including all of the hair (a high ponytail, bun or volume on top, and the full hanging length of the hair)",
  nails: "the hands with the manicured nails",
  makeup: "the whole face from the top of the hair to the chin",
  outfit: "the person from the top of the head to the shoes, including the whole outfit",
  decor: "the decorated objects or the decorated area",
  food: "the dish or the food and its plate",
  interior: "the main furniture and the decorated part of the room",
};

const clamp01 = (v: unknown, def: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : def; };

type Det = { label: string; box: [number, number, number, number] };

/** Разбор ответа детекции Gemini: json-список записей {box_2d: [ymin,xmin,ymax,xmax] 0..1000, label}; код-блоки и маски игнорируем. */
function parseDetections(text: string): Det[] {
  const m = text.replace(/```[a-z]*\n?/gi, "").match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: Det[] = [];
  for (const e of arr) {
    const o = (e && typeof e === "object" ? e : {}) as { box_2d?: unknown; label?: unknown };
    const b = Array.isArray(o.box_2d) ? o.box_2d.map(Number) : [];
    if (b.length < 4 || b.some((n) => !Number.isFinite(n))) continue;
    const k = b.some((n) => n > 1) ? 1000 : 1;
    out.push({ label: String(o.label ?? "").toLowerCase(), box: [clamp01(b[0] / k, 0), clamp01(b[1] / k, 0), clamp01(b[2] / k, 1), clamp01(b[3] / k, 1)] });
  }
  return out;
}

const PEOPLE: ReadonlySet<AccentType> = new Set(["hair", "makeup", "outfit", "auto"]);

/** Рамка объекта = запись «subject» (иначе первая), фокус = центр лица (если есть) или центр рамки. */
function pickBox(dets: Det[], accent: AccentType): SubjectBox | null {
  const subj = dets.find((d) => d.label.includes("subject")) ?? dets.find((d) => !d.label.includes("face")) ?? dets[0];
  if (!subj) return null;
  const [y0, x0, y1, x1] = subj.box;
  if (x1 - x0 < 0.05 || y1 - y0 < 0.05) return null;
  // Рамка на весь кадр — модель не нашла объект; пусть работает карта энергии.
  if (x0 <= 0.01 && y0 <= 0.01 && x1 >= 0.99 && y1 >= 0.99) return null;
  const face = PEOPLE.has(accent) ? dets.find((d) => d.label.includes("face")) : undefined;
  let fx = (x0 + x1) / 2, fy = (y0 + y1) / 2;
  if (face) { fx = (face.box[1] + face.box[3]) / 2; fy = (face.box[0] + face.box[2]) / 2; }
  return { x0, y0, x1, y1, fx: Math.max(x0, Math.min(x1, fx)), fy: Math.max(y0, Math.min(y1, fy)) };
}

/** Рамка объекта фото; null — модель не ответила (тогда работает карта энергии). Ошибки не бросает. */
export async function subjectBoxFor(ai: AiCtx, url: string, photo: Buffer, accent: AccentType, log?: (msg: string) => void): Promise<SubjectBox | null> {
  const rel = `pins/photos/${sha1(url)}.subject.json`;
  try {
    if (await exists(rel)) {
      const cached = JSON.parse(await readFile(absPath(rel), "utf8")) as { box: SubjectBox | null };
      return cached.box ?? null;
    }
  } catch { /* битый кэш — пересчитаем */ }
  let box: SubjectBox | null = null;
  try {
    const small = await toCleanJpeg(photo, { maxSide: 768, quality: 80 });
    const dataUrl = `data:image/jpeg;base64,${small.data.toString("base64")}`;
    const people = PEOPLE.has(accent);
    const res = await aiChat(ai, SLOT_TEXT_FAST, {
      user: [
        { type: "text", text: `Detect ${SUBJECT_HINT[accent] ?? SUBJECT_HINT.auto} and label it "subject".${people ? ' If a person is visible, also detect the face and label it "face".' : ""} Output a json list where each entry contains the 2D bounding box in "box_2d" as [ymin, xmin, ymax, xmax] normalized to 0-1000 and a text label in "label". Do not output masks.` },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
      temperature: 0, maxTokens: 200, timeoutMs: 40_000,
    });
    box = pickBox(parseDetections(res.text), accent);
    if (!box) log?.(`subject box: no usable detection: ${res.text.replace(/\s+/g, " ").slice(0, 120)}`);
  } catch (e) {
    log?.(`subject box failed: ${(e as Error).message}`);
    return null; // не кэшируем сбой: в следующий раз попробуем снова
  }
  await writeFileAtomic(rel, Buffer.from(JSON.stringify({ box, at: new Date().toISOString() }))).catch(() => {});
  return box;
}

/* ---------- v2: сравнительная оценка фото статьи для выбора на Canvas-пины ---------- */

export type PhotoRank = { score: number; flags: string[] };

/** Флаги, при которых фото на пин не берём, если есть из чего выбрать. */
export const BAD_PHOTO_FLAGS: ReadonlySet<string> = new Set(["text", "collage", "blurry", "offtopic", "cut", "dark"]);

/**
 * Один вызов модели со зрением на статью: все кандидаты сразу, модель сравнивает их между собой и ставит
 * оценки 1–10 + флаги. Рамки объектов здесь НЕ просим — совмещённый запрос портит детекцию;
 * рамки ищет subjectBoxFor только для выбранных фото. Кэш: pins/photos/rank-<sha1(тема|ниша|адреса)>.json.
 * null — модель не ответила (сбой не кэшируется, выбор пойдёт без оценок).
 */
export async function rankPhotos(ai: AiCtx, items: Array<{ url: string; photo: Buffer }>, accent: AccentType, topic: string, log?: (msg: string) => void): Promise<Map<string, PhotoRank> | null> {
  if (!items.length) return new Map();
  const rel = `pins/photos/rank-${sha1(`${topic}|${accent}|${items.map((i) => i.url).join("|")}`)}.json`;
  try {
    if (await exists(rel)) {
      const cached = JSON.parse(await readFile(absPath(rel), "utf8")) as Record<string, PhotoRank>;
      return new Map(Object.entries(cached));
    }
  } catch { /* битый кэш — пересчитаем */ }
  try {
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: `You are a strict photo editor choosing tiles for a Pinterest collage about "${topic.slice(0, 120)}". The main subject should be ${SUBJECT_HINT[accent] ?? SUBJECT_HINT.auto}.
Compare the ${items.length} photos below WITH EACH OTHER and score each 1-10 as a collage tile. Use the full range and spread the scores: the best photo of the set gets 9-10, an ordinary one 5-6, poor ones 1-4. Reward: sharp, well lit, attractive, clearly on-topic, subject fully visible, clean background. Penalize: blurry, dark, screenshots, big text/watermarks/logos, collages or grids, diagrams, packshots without the subject, subject cut off, off-topic, near-duplicate of a better photo in the set.
Return JSON: {"photos":[{"n":1,"score":7,"flags":[]}, ...]} with one entry per photo in order; flags only from "blurry","dark","text","collage","cut","offtopic","duplicate".` }];
    for (const [k, it] of items.entries()) {
      const small = await toCleanJpeg(it.photo, { maxSide: 512, quality: 75 });
      parts.push({ type: "text", text: `Photo ${k + 1}:` });
      parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${small.data.toString("base64")}` } });
    }
    const res = await aiChat(ai, SLOT_TEXT_FAST, { user: parts, json: true, temperature: 0, maxTokens: 900, timeoutMs: 60_000 });
    const list = (res.json as { photos?: Array<{ n?: unknown; score?: unknown; flags?: unknown }> } | null)?.photos;
    if (!Array.isArray(list) || !list.length) { log?.(`photo rank: unparsed answer: ${res.text.replace(/\s+/g, " ").slice(0, 120)}`); return null; }
    const out: Record<string, PhotoRank> = {};
    list.forEach((e, k) => {
      const n = Number(e?.n) || k + 1;
      const it = items[n - 1];
      if (!it) return;
      out[it.url] = {
        score: Math.max(1, Math.min(10, Number(e?.score) || 5)),
        flags: Array.isArray(e?.flags) ? e.flags.map((f) => String(f).toLowerCase()).filter(Boolean).slice(0, 6) : [],
      };
    });
    await writeFileAtomic(rel, Buffer.from(JSON.stringify(out))).catch(() => {});
    return new Map(Object.entries(out));
  } catch (e) {
    log?.(`photo rank failed: ${(e as Error).message}`);
    return null;
  }
}
