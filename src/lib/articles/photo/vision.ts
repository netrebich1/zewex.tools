/**
 * Vision-часть фото-цепочки статей.
 *
 *  1. Бесплатный пиксельный анализ файла — порт `_shared/photoVision.ts` (коллажи, плашки с текстом,
 *     dHash, резкость, метки ИИ в метаданных). Декодирование — через `sharp` вместо jpeg-js/upng/jsquash.
 *  2. Подготовка картинок для vision-модели (уменьшенные копии ≤1024 px, JPEG q80 — аудит 02 п.7.5:
 *     оригиналы до 5 МБ в base64 расточительны) и единый вызов `visionJson` через `aiChat` (слот vision).
 *  3. Тренд-бриф для промтов оценки/отбора — порт `_shared/trendBrief.ts` (бриф берётся из `facts.trendBrief`
 *     шага поиска, иначе встроенный по нише).
 */
import sharp from "sharp";
import { readFile } from "fs/promises";
import type { ArtPhotoCandidate } from "@prisma/client";
import { aiChat, imagePart, type AiCtx, type ContentPart } from "@/lib/articles/ai";
import { absPath } from "@/lib/articles/storage";
import { SLOTS, type ArticleFacts } from "@/lib/articles/types";
import { AiError } from "@/lib/pins/ai/errors";
import { parseJsonLenient } from "@/lib/pins/ai/json";

// ─────────────────────────────────────────────────────────────
// 1. Пиксельный анализ (оригинал: _shared/photoVision.ts)
// ─────────────────────────────────────────────────────────────

export interface PixelVerdict {
  /** фото нужно отбраковать */
  reject: boolean;
  /** причина на русском (для rejectReason) */
  reason: string | null;
  /** удалось ли декодировать изображение */
  decoded: boolean;
  /** перцептивный отпечаток (dHash, 16 hex-символов) — для похожих кадров */
  phash?: string | null;
  /** резкость кадра (дисперсия лапласиана), чем больше — тем резче */
  sharpness?: number | null;
  /** бесплатные метрики картинки для рейтинга «красоты» */
  stats?: ImageStats | null;
}

/** Контраст, насыщенность и яркость кадра — для технического балла качества. */
export interface ImageStats {
  /** стандартное отклонение яркости, 0–100 */
  contrast: number;
  /** средняя насыщенность, 0–100 */
  colorfulness: number;
  /** средняя яркость, 0–255 */
  brightness: number;
}

interface Bitmap {
  w: number;
  h: number;
  /** RGB, 3 байта на пиксель, уже уменьшенная сетка */
  px: Uint8Array;
  /** тонкие однотонные перемычки на «полном» разрешении (не видны после уменшения до 160 px) */
  dividers?: number;
}

/** Сторона уменьшенной сетки для всех метрик (оригинал: photoVision.ts:43). */
const TARGET = 160;
/**
 * Разрешение для поиска тонких перемычек коллажа. Оригинал смотрел полный кадр; у нас — ≤800 px по длинной
 * стороне (аудит 02 §8: порог «≤2.5 % кадра» масштабируется, память экономится).
 */
const DIVIDER_SIDE = 800;
/** Очень большие файлы не декодируем (оригинал: 6 МБ для edge-рантайма; у нас памяти больше). */
const MAX_DECODE_BYTES = 12 * 1024 * 1024;

async function decode(bytes: Buffer | Uint8Array): Promise<Bitmap | null> {
  try {
    if (bytes.length > MAX_DECODE_BYTES) return null;
    const base = sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { limitInputPixels: 80_000_000 }).rotate();
    const full = await base
      .resize({ width: DIVIDER_SIDE, height: DIVIDER_SIDE, fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = full.info.width;
    const height = full.info.height;
    const stride = full.info.channels;
    const data = new Uint8Array(full.data.buffer, full.data.byteOffset, full.data.byteLength);
    if (!data.length || !width || !height) return null;
    const dividers = findThinDividers(data, width, height, stride);

    // оригинал: photoVision.ts:81-96 — равномерная выборка пикселей в сетку ≤160 px
    const scale = Math.max(1, Math.round(Math.max(width, height) / TARGET));
    const w = Math.max(8, Math.floor(width / scale));
    const h = Math.max(8, Math.floor(height / scale));
    const px = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(height - 1, y * scale);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(width - 1, x * scale);
        const si = (sy * width + sx) * stride;
        const di = (y * w + x) * 3;
        px[di] = data[si];
        px[di + 1] = data[si + 1];
        px[di + 2] = data[si + 2];
      }
    }
    return { w, h, px, dividers };
  } catch {
    return null;
  }
}

/** Тонкая однотонная перемычка между панелями коллажа (оригинал: photoVision.ts:102-178, 1:1). */
function findThinDividers(data: Uint8Array, width: number, height: number, stride: number): number {
  const col = (axis: "v" | "h", i: number): [number, number, number] | null => {
    const m = axis === "v" ? height : width;
    const step = Math.max(1, Math.floor(m / 300));
    let n = 0, sr = 0, sg = 0, sb = 0;
    const pts: number[] = [];
    for (let j = 0; j < m; j += step) {
      const k = axis === "v" ? (j * width + i) * stride : (i * width + j) * stride;
      pts.push(k); sr += data[k]; sg += data[k + 1]; sb += data[k + 2]; n++;
    }
    sr /= n; sg /= n; sb /= n;
    let ok = 0;
    for (const k of pts) {
      if ((Math.abs(data[k] - sr) + Math.abs(data[k + 1] - sg) + Math.abs(data[k + 2] - sb)) / 3 < 12) ok++;
    }
    return ok / n >= 0.94 ? [sr, sg, sb] : null;
  };
  const uni = (axis: "v" | "h", i: number, ref?: [number, number, number] | null): boolean => {
    const c = col(axis, i);
    if (!c) return false;
    if (!ref) return true;
    return (Math.abs(c[0] - ref[0]) + Math.abs(c[1] - ref[1]) + Math.abs(c[2] - ref[2])) / 3 < 15;
  };
  const edgeFrac = (axis: "v" | "h", _inner: number, outer: number, ref: [number, number, number]): number => {
    const span = axis === "v" ? width : height;
    if (outer < 0 || outer >= span) return 0;
    const m = axis === "v" ? height : width;
    const step = Math.max(1, Math.floor(m / 300));
    let n = 0, diff = 0;
    for (let j = 0; j < m; j += step) {
      const k = axis === "v" ? (j * width + outer) * stride : (outer * width + j) * stride;
      if ((Math.abs(data[k] - ref[0]) + Math.abs(data[k + 1] - ref[1]) + Math.abs(data[k + 2] - ref[2])) / 3 > 20) diff++;
      n++;
    }
    return n ? diff / n : 0;
  };
  const outerOf = (axis: "v" | "h", from: number, dir: 1 | -1, ref: [number, number, number], lim: number): number => {
    let k = from + dir;
    for (let s = 0; s < lim; s++, k += dir) {
      if (edgeFrac(axis, from, k, ref) >= 0.3) return k + dir;
    }
    return k;
  };
  let count = 0;
  for (const axis of ["v", "h"] as const) {
    const span = axis === "v" ? width : height;
    const from = Math.floor(span * 0.15), to = Math.ceil(span * 0.85);
    const maxRun = Math.max(2, Math.floor(span * 0.025));
    const step = Math.max(1, Math.floor(span / 800));
    let i = from;
    while (i < to) {
      const ref = col(axis, i);
      if (!ref) { i += step; continue; }
      let a = i;
      while (a - 1 >= 0 && uni(axis, a - 1, ref) && i - a <= maxRun) a--;
      let b = i;
      while (b + 1 < span && uni(axis, b + 1, ref) && b - a <= maxRun) b++;
      if (b - a + 1 <= maxRun) {
        const off = Math.max(3, Math.floor(span * 0.01));
        const l = a - off, r = b + off;
        if (l >= 0 && r < span && !uni(axis, l, ref) && !uni(axis, r, ref) &&
            edgeFrac(axis, a, outerOf(axis, a, -1, ref, maxRun), ref) >= 0.5 &&
            edgeFrac(axis, b, outerOf(axis, b, 1, ref, maxRun), ref) >= 0.5) count++;
      }
      i = b + Math.max(step, Math.floor(span * 0.05));
    }
  }
  return count;
}

function at(b: Bitmap, x: number, y: number): [number, number, number] {
  const i = (y * b.w + x) * 3;
  return [b.px[i], b.px[i + 1], b.px[i + 2]];
}

function dist(a: [number, number, number], c: [number, number, number]): number {
  return (Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2])) / 3;
}

interface SeamLine {
  axis: "v" | "h";
  idx: number;
  /** доля точек линии с резким перепадом, 0–1 */
  frac: number;
}

/** Линии-разделители панелей коллажа (оригинал: photoVision.ts:206-247). */
function findSeamLines(b: Bitmap): SeamLine[] {
  const lines: SeamLine[] = [];
  const scan = (axis: "v" | "h") => {
    const n = axis === "v" ? b.w : b.h;
    const m = axis === "v" ? b.h : b.w;
    const from = Math.floor(n * 0.12), to = Math.ceil(n * 0.88);
    const fracs = new Float64Array(n);
    for (let i = from; i < to - 1; i++) {
      let strong = 0;
      for (let j = 0; j < m; j++) {
        const a = axis === "v" ? at(b, i, j) : at(b, j, i);
        const c = axis === "v" ? at(b, i + 1, j) : at(b, j, i + 1);
        if (dist(a, c) > 26) strong++;
      }
      fracs[i] = strong / m;
    }
    for (let i = from; i < to - 1; i++) {
      if (fracs[i] < 0.9) continue;
      let localMax = true;
      for (let j = Math.max(from, i - 2); j <= Math.min(to - 2, i + 2); j++) {
        if (fracs[j] > fracs[i]) localMax = false;
      }
      if (!localMax) continue;
      lines.push({ axis, idx: i, frac: fracs[i] });
      i += 3;
    }
  };
  scan("v");
  scan("h");
  const merged: SeamLine[] = [];
  for (const l of lines) {
    const span = l.axis === "v" ? b.w : b.h;
    const near = merged.find((d) => d.axis === l.axis && Math.abs(d.idx - l.idx) <= Math.max(4, span * 0.05));
    if (near) { near.frac = Math.max(near.frac, l.frac); continue; }
    merged.push({ ...l });
  }
  return merged;
}

/** Леттербокс: два симметричных однотонных поля у краёв (оригинал: photoVision.ts:250-271). */
function isLetterbox(b: Bitmap, lines: SeamLine[]): boolean {
  if (lines.length !== 2) return false;
  const [a, c] = lines;
  if (a.axis !== c.axis) return false;
  const span = a.axis === "v" ? b.w : b.h;
  const lo = Math.min(a.idx, c.idx), hi = Math.max(a.idx, c.idx);
  if (lo > span * 0.25 || hi < span * 0.75) return false;
  const uniform = (fromIdx: number, toIdx: number) => {
    const ref = a.axis === "v" ? at(b, fromIdx, Math.floor(b.h / 2)) : at(b, Math.floor(b.w / 2), fromIdx);
    let flat = 0, total = 0;
    for (let i = fromIdx; i < toIdx; i++) {
      const m = a.axis === "v" ? b.h : b.w;
      for (let j = 0; j < m; j += 4) {
        const p = a.axis === "v" ? at(b, i, j) : at(b, j, i);
        if (dist(p, ref) < 24) flat++;
        total++;
      }
    }
    return total ? flat / total : 0;
  };
  return uniform(0, lo) > 0.9 && uniform(hi + 1, span) > 0.9;
}

/** Полоса-плашка с надписью (оригинал: photoVision.ts:274-319). */
function findTextBanner(b: Bitmap): { share: number; textRatio: number } {
  const rowBanner: boolean[] = [];
  const rowText: number[] = [];
  const buckets = new Uint16Array(512);
  for (let y = 0; y < b.h; y++) {
    buckets.fill(0);
    for (let x = 0; x < b.w; x++) {
      const [r, g, bl] = at(b, x, y);
      buckets[((r >> 5) << 6) | ((g >> 5) << 3) | (bl >> 5)]++;
    }
    let bestKey = 0, bestCount = 0;
    for (let k = 0; k < buckets.length; k++) {
      if (buckets[k] > bestCount) { bestKey = k; bestCount = buckets[k]; }
    }
    const modal: [number, number, number] = [
      ((bestKey >> 6) << 5) + 16,
      (((bestKey >> 3) & 7) << 5) + 16,
      ((bestKey & 7) << 5) + 16,
    ];
    let near = 0, transitions = 0;
    for (let x = 0; x < b.w; x++) {
      if (dist(at(b, x, y), modal) < 30) near++;
      if (x < b.w - 1 && dist(at(b, x, y), at(b, x + 1, y)) > 55) transitions++;
    }
    const flat = near / b.w;
    rowBanner.push(flat > 0.45 && transitions >= 4);
    rowText.push(transitions / b.w);
  }
  let best = { share: 0, textRatio: 0 };
  let run = 0, runText = 0, gap = 0;
  for (let y = 0; y <= b.h; y++) {
    if (y < b.h && (rowBanner[y] || (run > 0 && gap < 3))) {
      if (rowBanner[y]) { gap = 0; } else { gap++; }
      run++; runText += rowText[y];
      continue;
    }
    if (run >= 4) {
      const share = run / b.h;
      const textRatio = runText / run;
      if (share > best.share) best = { share, textRatio };
    }
    run = 0; runText = 0;
  }
  return best;
}

/** Метки генеративного ИИ в EXIF/XMP/C2PA (оригинал: photoVision.ts:322-331). */
const AI_MARKERS = [
  "midjourney", "stable diffusion", "stablediffusion", "stable-diffusion",
  "dall-e", "dall·e", "dalle", "openai", "sora", "firefly", "adobe firefly",
  "imagen", "nano banana", "nanobanana", "leonardo.ai", "ideogram", "recraft",
  "playground ai", "novelai", "flux.1", "black forest labs", "bfl.ai",
  "generated with ai", "ai generated", "ai-generated", "aigc", "genai",
  "trainedalgorithmicmedia", "compositewithtrainedalgorithmicmedia",
  // «c2pa» / «contentcredentials» / «digitalsourcetype» сами по себе — история правок (камеры, Photoshop), не ИИ (2026-10-15);
  // ИИ-источник в C2PA помечается значением trainedAlgorithmicMedia — оно выше в списке.
  "krea.ai", "seaart", "civitai", "grok-imagine", "gemini image",
];

/** Метка ИИ-генерации в байтах файла (оригинал: photoVision.ts:333-345). */
export function detectAiGeneratedBytes(bytes: Buffer | Uint8Array): string | null {
  const head = bytes.subarray(0, Math.min(bytes.length, 512 * 1024));
  const tail = bytes.length > 512 * 1024 ? bytes.subarray(bytes.length - 256 * 1024) : new Uint8Array();
  const text = Buffer.from(head).toString("latin1").toLowerCase() + (tail.length ? Buffer.from(tail).toString("latin1").toLowerCase() : "");
  for (const m of AI_MARKERS) if (text.includes(m)) return m;
  return null;
}

function grayGrid(b: Bitmap, gw: number, gh: number): Float64Array {
  const out = new Float64Array(gw * gh);
  const cellW = b.w / gw, cellH = b.h / gh;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0, n = 0;
      const x0 = Math.floor(gx * cellW), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cellW));
      const y0 = Math.floor(gy * cellH), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cellH));
      for (let y = y0; y < Math.min(y1, b.h); y++) {
        for (let x = x0; x < Math.min(x1, b.w); x++) {
          const [r, g, bl] = at(b, x, y);
          sum += 0.299 * r + 0.587 * g + 0.114 * bl;
          n++;
        }
      }
      out[gy * gw + gx] = n ? sum / n : 0;
    }
  }
  return out;
}

/** dHash 64 бита → 16 hex-символов (оригинал: photoVision.ts:369-381). */
function perceptualHashOf(b: Bitmap): string {
  const gw = 9, gh = 8;
  const g = grayGrid(b, gw, gh);
  let bits = "";
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw - 1; x++) {
      bits += g[y * gw + x] < g[y * gw + x + 1] ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** dHash файла (удобная обёртка для этапов, которым нужен только отпечаток). */
export async function perceptualHash(bytes: Buffer | Uint8Array): Promise<string | null> {
  const b = await decode(bytes);
  return b ? perceptualHashOf(b) : null;
}

/** Расстояние Хэмминга между двумя dHash (0 = идентичны, 64 = максимум) (оригинал: photoVision.ts:384-392). */
export function phashDistance(a?: string | null, b?: string | null): number {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** Резкость: дисперсия лапласиана по яркости (оригинал: photoVision.ts:395-411). */
function sharpnessScore(b: Bitmap): number {
  const w = Math.min(b.w, 128), h = Math.min(b.h, 128);
  const g = grayGrid(b, w, h);
  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = -4 * g[y * w + x] + g[(y - 1) * w + x] + g[(y + 1) * w + x] + g[y * w + x - 1] + g[y * w + x + 1];
      sum += v;
      sumSq += v * v;
      count++;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

/** Ниже этого значения кадр считаем размытым/мягким браком (оригинал: photoVision.ts:414). */
export const MIN_SHARPNESS = 25;

/** Контраст / насыщенность / яркость по уменьшенной сетке (оригинал: photoVision.ts:417-436). */
function imageStats(b: Bitmap): ImageStats {
  let sum = 0, sumSq = 0, sat = 0, count = 0;
  for (let i = 0; i < b.px.length; i += 3) {
    const r = b.px[i], g = b.px[i + 1], bl = b.px[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
    sum += lum;
    sumSq += lum * lum;
    const max = Math.max(r, g, bl), min = Math.min(r, g, bl);
    sat += max ? ((max - min) / max) * 100 : 0;
    count++;
  }
  if (!count) return { contrast: 0, colorfulness: 0, brightness: 0 };
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return {
    contrast: Math.round((Math.sqrt(variance) / 255) * 100 * 10) / 10,
    colorfulness: Math.round((sat / count) * 10) / 10,
    brightness: Math.round(mean * 10) / 10,
  };
}

/** Полная бесплатная проверка файла: ИИ-метки + коллаж + надписи + резкость + отпечаток (оригинал: photoVision.ts:452-504). */
export async function inspectPhotoBytes(bytes: Buffer | Uint8Array): Promise<PixelVerdict> {
  const aiMarker = detectAiGeneratedBytes(bytes);
  if (aiMarker) {
    return { reject: true, reason: `создано ИИ (метка «${aiMarker}» в метаданных)`, decoded: false };
  }
  const bmp = await decode(bytes);
  if (!bmp) return { reject: false, reason: null, decoded: false, phash: null, sharpness: null };

  const phash = perceptualHashOf(bmp);
  const sharpVal = Math.round(sharpnessScore(bmp) * 10) / 10;
  const base = { decoded: true as const, phash, sharpness: sharpVal, stats: imageStats(bmp) };

  const seams = findSeamLines(bmp);
  if (isLetterbox(bmp, seams)) {
    return { ...base, reject: true, reason: "однотонные поля по краям кадра (леттербокс)" };
  }
  const hardSeam = seams.some((s) => s.frac >= 0.97);
  if ((bmp.dividers ?? 0) >= 1) {
    return { ...base, reject: true, reason: `коллаж: кадр разделён однотонной полосой (${bmp.dividers})` };
  }
  if (seams.length >= 2 || (seams.length === 1 && hardSeam)) {
    return { ...base, reject: true, reason: `коллаж: кадр разделён на панели (${seams.length} разделитель(ей))` };
  }
  // Проверка глазами 10 статей zorvianix (2026-10-15): прежние пороги (надпись: доля ≥ 0.2 и текст ≥ 0.07; плашка ≥ 0.42)
  // отсеивали студийный однотонный фон и текстуру волос/кос/хрома — около половины таких кадров были хорошими.
  // Теперь отказ только при очень сильном сигнале; остальное решает vision-оценка (она видит текст/водяные знаки сама).
  const band = findTextBanner(bmp);
  if (band.share >= 0.35 && band.textRatio >= 0.15) {
    return { ...base, reject: true, reason: `крупная надпись/баннер поверх фото (${Math.round(band.share * 100)}% кадра)` };
  }
  if (band.share >= 0.85) {
    return { ...base, reject: true, reason: `однотонная плашка на ${Math.round(band.share * 100)}% кадра` };
  }
  if (sharpVal < MIN_SHARPNESS) {
    return { ...base, reject: true, reason: `размытое фото (резкость ${sharpVal})` };
  }
  return { ...base, reject: false, reason: null };
}

// ─────────────────────────────────────────────────────────────
// 2. Картинки для vision-модели и единый вызов
// ─────────────────────────────────────────────────────────────

/** Уменьшенная копия для подробной оценки (аудит 02 п.7.5, §8: ≤1024 px, JPEG q80 вместо оригинала до 5 МБ). */
export const VISION_MAX_SIDE = 1024;
export const VISION_JPEG_QUALITY = 80;
/** Для сравнения сеткой (rank, select) хватает миниатюры (оригинал брал thumbnail_url). */
export const VISION_THUMB_SIDE = 400;

export type VisionImage = { bytes: Buffer; mime: string };
export type VisionImageMode = "full" | "thumb";

type CandidateFiles = Pick<ArtPhotoCandidate, "path" | "thumbPath">;

/**
 * Читает файл кандидата с диска и готовит картинку для модели.
 *  full  — оригинал, уменьшенный до ≤1024 px (если оригинала нет — миниатюра);
 *  thumb — миниатюра WebP как есть (если нет — оригинал, уменьшенный до 400 px).
 * null — файлов нет (кандидат «недоступен для скачивания», как в оригинале rate:586-592).
 */
export async function loadVisionImage(c: CandidateFiles, mode: VisionImageMode = "full"): Promise<VisionImage | null> {
  const order = mode === "full" ? [c.path, c.thumbPath] : [c.thumbPath, c.path];
  for (const rel of order) {
    if (!rel) continue;
    try {
      const buf = await readFile(absPath(rel));
      if (!buf.length) continue;
      if (mode === "thumb" && rel === c.thumbPath) {
        return { bytes: buf, mime: rel.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg" };
      }
      const side = mode === "full" ? VISION_MAX_SIDE : VISION_THUMB_SIDE;
      const out = await sharp(buf).rotate().resize({ width: side, height: side, fit: "inside", withoutEnlargement: true }).jpeg({ quality: VISION_JPEG_QUALITY }).toBuffer();
      return { bytes: out, mime: "image/jpeg" };
    } catch {
      /* следующий файл */
    }
  }
  return null;
}

/** Кэш подготовленных картинок на время этапа: сетки A/B/final отбора показывают одни и те же кадры. */
export class VisionImageCache {
  private readonly m = new Map<string, Promise<VisionImage | null>>();
  get(c: CandidateFiles & { id: string }, mode: VisionImageMode): Promise<VisionImage | null> {
    const key = `${c.id}:${mode}`;
    let p = this.m.get(key);
    if (!p) {
      p = loadVisionImage(c, mode);
      this.m.set(key, p);
    }
    return p;
  }
}

/** Картинка как часть мультимодального сообщения. */
export function imageContent(img: VisionImage): ContentPart {
  return imagePart(img.bytes, img.mime);
}

export type VisionRequest = {
  /** Модель из рецепта (`provider:model`); пусто — модель правила слота */
  model?: string;
  system: string;
  parts: ContentPart[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** Системный промт одинаков между статьями — просить кэш у провайдера (`aiChat.cacheSystem`) */
  cacheSystem?: boolean;
};

export type VisionResult = { json: unknown; text: string; costUsd: number };

/** Один vision-вызов через портал (слот vision), ответ — JSON (мягкий разбор). */
export async function visionJson(ai: AiCtx, req: VisionRequest): Promise<VisionResult> {
  const r = await aiChat(ai, {
    slot: SLOTS.vision,
    model: req.model,
    system: req.system,
    user: req.parts,
    json: true,
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    timeoutMs: req.timeoutMs,
    cacheSystem: req.cacheSystem,
  });
  const json = r.json ?? parseJsonLenient(r.text);
  return { json, text: r.text, costUsd: r.costUsd ?? 0 };
}

/**
 * Какие ошибки vision-вызова этап обязан пробросить наверх:
 *  - остановка/потеря lease (signal.aborted) — всегда;
 *  - fatal_run (нет ключа/кредитов) — статья должна упасть с понятным текстом, а не молча «пропустить ранг»;
 *  - transient (429/5xx/таймаут) — раннер сделает backoff и повторит идемпотентный этап.
 * Остальное (permanent: 400/safety, пустой или неразборный ответ) этап обрабатывает сам, как оригинал.
 */
export function mustRethrow(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof AiError) return err.cls.kind === "fatal_run" || err.cls.kind === "transient";
  const msg = err instanceof Error ? err.message : String(err);
  return /lease lost|stop requested|aborted/i.test(msg);
}

/** Список `{photos:[…]}` / `{order:[…]}` и т.п. из ответа модели. */
export function listFromJson(json: unknown, keys: string[]): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  const o = json as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** Нумерованный список «n. заголовок — домен» для текстовой части запроса. */
export function numberedTitles(rows: Array<{ title?: string | null; domain?: string | null }>, withDomain = false): string {
  return rows
    .map((r, n) => `${n + 1}. ${r.title || "(no title)"}${withDomain ? ` — ${r.domain || ""}` : ""}`)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────
// 3. Тренд-бриф (оригинал: _shared/trendBrief.ts)
// ─────────────────────────────────────────────────────────────

export type TrendBrief = { window: string; in: string[]; out: string[]; photo_style_out: string[] };

export function trendYear(keyword: string): number {
  const m = String(keyword || "").match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : new Date().getUTCFullYear();
}

export function trendWindow(keyword: string): string {
  const y = trendYear(keyword);
  return `${y - 2}-${y + 2}`;
}

const strList = (v: unknown, n = 8) => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, n);

export function parseTrendBrief(raw: unknown, keyword: string): TrendBrief | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const b: TrendBrief = {
    window: String(r.window || trendWindow(keyword)).slice(0, 20),
    in: strList(r.in),
    out: strList(r.out),
    photo_style_out: strList(r.photo_style_out, 5),
  };
  return b.in.length || b.out.length ? b : null;
}

/** Встроенные брифы по нишам (оригинал: trendBrief.ts:39-46). */
const FALLBACK: Record<string, TrendBrief> = {
  nails: { window: "", in: ["short almond or soft square", "milky and chrome finishes", "sheer nude bases", "minimal fine-line art", "velvet / cat-eye effect", "3D and aura accents"], out: ["very long coffin or squoval acrylic", "chunky rhinestone overload", "airbrush gradients", "wide white french tip", "zebra and flame prints"], photo_style_out: ["harsh flash", "salon-counter clutter", "heavy vignette filter"] },
  hair: { window: "", in: ["soft face-framing layers", "curtain bangs", "lived-in colour", "glossy natural texture"], out: ["flat-ironed poker straight", "chunky highlights", "heavy side-swept emo fringe", "crunchy scrunched curls"], photo_style_out: ["harsh flash", "low-res selfie"] },
  outfits: { window: "", in: ["relaxed and wide-leg cuts", "quiet-luxury neutrals", "oversized tailoring", "texture mixing"], out: ["low-rise skinny jeans", "leggings under tunics", "peplum tops", "heavy logo belts", "infinity scarves"], photo_style_out: ["mirror selfie with flash", "dated Instagram filters"] },
  interior: { window: "", in: ["warm woods and natural textures", "earthy and muted colours", "curved furniture", "layered lighting"], out: ["grey-everything farmhouse", "glossy high-gloss cabinets", "chevron walls", "word-art signs", "tuscan brown"], photo_style_out: ["fish-eye real-estate shots", "yellow cast"] },
  makeup: { window: "", in: ["skin-like base", "soft blush draping", "glossy lips", "fluffy brows"], out: ["heavy cut crease", "instagram baking", "overdrawn matte lips", "block brows"], photo_style_out: ["heavy beauty filters", "ring-light glare"] },
  tattoo: { window: "", in: ["fine-line", "micro realism", "ornamental blackwork"], out: ["tribal armbands", "infinity symbols", "lower-back tribal"], photo_style_out: ["blurry fresh tattoo with cling film"] },
};

export function fallbackTrendBrief(niche: string | null | undefined, keyword: string): TrendBrief | null {
  const n = String(niche || "").toLowerCase();
  const key = /nail/.test(n) ? "nails" : /hair/.test(n) ? "hair" : /outfit|fashion|cloth/.test(n) ? "outfits"
    : /interior|decor|home|outdoor/.test(n) ? "interior" : /makeup/.test(n) ? "makeup" : /tattoo/.test(n) ? "tattoo" : "";
  const b = FALLBACK[key];
  return b ? { ...b, window: trendWindow(keyword) } : null;
}

export function trendBriefText(b: TrendBrief | null): string {
  if (!b) return "";
  return `TREND BRIEF for ${b.window}:\n- IN: ${b.in.join("; ")}\n- DATED: ${[...b.out, ...b.photo_style_out].join("; ")}`;
}

/** Бриф из шага поиска (`facts.trendBrief`), иначе встроенный по нише (оригинал: loadTrendBrief). */
export function resolveTrendBrief(facts: ArticleFacts | null | undefined, niche: string | null | undefined, keyword: string): TrendBrief | null {
  return parseTrendBrief(facts?.trendBrief, keyword) ?? fallbackTrendBrief(niche, keyword);
}
