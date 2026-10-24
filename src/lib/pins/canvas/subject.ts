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
