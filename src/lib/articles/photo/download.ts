/**
 * Скачивание кандидатов и файловые отпечатки для технического фильтра.
 * Порт скачивания из stage-photo-filter/index.ts:410-441 (UA ZewexBot, 20 с, 2 попытки при 429/5xx, порядок
 * [оригинал, миниатюра Google]) + dimsFromBytes → sharp.metadata. Анализ пикселей (коллаж/плашка/резкость/dHash/метки ИИ),
 * технический балл и каталожный источник живут в общих модулях соседа — ./vision.ts, ./ranking.ts, ./authenticity.ts;
 * здесь они только реэкспортируются под именами, которыми пользуется фильтр.
 */
import { createHash } from "crypto";
import sharp from "sharp";
import { acquire } from "@/lib/pins/ai/limiter";
import { phashDistance } from "./vision";

export { inspectPhotoBytes, detectAiGeneratedBytes, phashDistance, perceptualHash, MIN_SHARPNESS, type PixelVerdict, type ImageStats } from "./vision";
export { techQualityScore, finalPhotoRank, type TechQualityInput } from "./ranking";
export { catalogueSourceSignal, type CatalogueSignal } from "./authenticity";

/** Имя из задания: расстояние Хэмминга между dHash (0..64). */
export const hammingDistance = phashDistance;

/** Порог «почти тот же кадр» внутри статьи на фильтре (stage-photo-filter/index.ts:156); на отборе — 10 (./fingerprints.ts). */
export const NEAR_DUPLICATE_DISTANCE = 8;

export const DOWNLOAD_UA = "Mozilla/5.0 (compatible; ZewexBot/1.0)";
export const DOWNLOAD_TIMEOUT_MS = 20_000;
/** Пауза перед повтором при 429/5xx (оригинал: 1200 мс, 2 попытки на URL). */
const RETRY_PAUSE_MS = 1200;
/** Лимит размера файла — в оригинале arrayBuffer() без ограничения (аудит 02, п.7.16). */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Одновременных скачиваний в процессе (семафор по ключу "download"). */
export const DOWNLOAD_CONCURRENCY = 6;

export type DownloadOk = { ok: true; bytes: Buffer; url: string; usedThumbnail: boolean; contentType: string; status: number };
export type DownloadFail = { ok: false; reason: string; status: number; contentType: string };
export type DownloadResult = DownloadOk | DownloadFail;

/** Временные отказы источника: файл ещё можно получить позже (stage-photo-filter/index.ts:103-105). */
export function isSoftFailure(reason: string): boolean {
  return /HTTP 429|HTTP 403|HTTP 5\d\d|не изображение \(text\/html|недоступно/i.test(reason);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Сигнатуры JPEG/PNG/WebP/GIF/AVIF — когда сервер врёт про content-type. */
function looksLikeImage(b: Buffer): boolean {
  if (b.length < 12) return false;
  if (b[0] === 0xff && b[1] === 0xd8) return true; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50) return true; // PNG
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return true;
  if (b.toString("ascii", 0, 3) === "GIF") return true;
  if (b.toString("ascii", 4, 8) === "ftyp") return true; // AVIF/HEIC
  return false;
}

/**
 * Скачивает первый доступный URL из списка [оригинал, миниатюра]: по каждому до 2 попыток (повтор только при 429/5xx),
 * content-type не image/* и не похоже на картинку → следующий URL.
 */
export async function downloadImage(urls: Array<string | null | undefined>, opts: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}): Promise<DownloadResult> {
  const list = [...new Set(urls.filter((u): u is string => !!u && /^https?:\/\//i.test(u)))];
  if (!list.length) return { ok: false, reason: "нет URL изображения", status: 0, contentType: "" };
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const release = await acquire("download", DOWNLOAD_CONCURRENCY);
  try {
    let lastStatus = 0;
    let lastCt = "";
    let lastErr = "";
    let sawOk = false;
    for (let i = 0; i < list.length; i++) {
      const url = list[i];
      let resp: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (opts.signal?.aborted) throw new Error("aborted");
        try {
          const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
          resp = await fetch(url, { signal, headers: { "User-Agent": DOWNLOAD_UA, Accept: "image/*,*/*;q=0.8" }, redirect: "follow" });
        } catch (e) {
          if (opts.signal?.aborted) throw new Error("aborted");
          resp = null;
          lastErr = (e as Error).message.slice(0, 80);
          break;
        }
        lastStatus = resp.status;
        if (resp.ok) break;
        if (resp.status !== 429 && resp.status < 500) break;
        if (attempt === 0) await sleep(RETRY_PAUSE_MS);
      }
      if (!resp || !resp.ok) continue;
      sawOk = true;
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      lastCt = ct;
      const declared = Number(resp.headers.get("content-length") || 0);
      if (declared > maxBytes) {
        lastErr = `файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`;
        continue;
      }
      // Тело читается потоком с обрывом на maxBytes: без content-length раньше читалось целиком без предела
      // (аудит 2026-10-14 stability §2.7), обрыв соединения посреди тела — отказ источника, а не падение этапа.
      const body = await readCapped(resp, maxBytes).catch((e: Error) => {
        if (opts.signal?.aborted) throw new Error("aborted");
        return { error: e.message.slice(0, 80) } as const;
      });
      if ("error" in body) {
        lastErr = body.error;
        continue;
      }
      if (body.tooBig) {
        lastErr = `файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`;
        continue;
      }
      const buf = body.bytes;
      if (!ct.startsWith("image/") && !looksLikeImage(buf)) continue;
      if (buf.length < 2000) {
        lastErr = "файл меньше 2000 байт";
        continue;
      }
      return { ok: true, bytes: buf, url, usedThumbnail: i > 0, contentType: ct || "image/*", status: resp.status };
    }
    if (lastErr && !sawOk) return { ok: false, reason: `недоступно: ${lastErr}`, status: lastStatus, contentType: lastCt };
    if (sawOk) return { ok: false, reason: lastErr ? `недоступно: ${lastErr}` : `не изображение (${lastCt.slice(0, 40)})`, status: lastStatus, contentType: lastCt };
    return { ok: false, reason: `HTTP ${lastStatus || 0}`, status: lastStatus, contentType: lastCt };
  } finally {
    release();
  }
}

/** Прочитать тело ответа не больше maxBytes: превышение — tooBig, остаток не скачивается. */
async function readCapped(resp: Response, maxBytes: number): Promise<{ bytes: Buffer; tooBig: false } | { tooBig: true }> {
  if (!resp.body) return { bytes: Buffer.from(await resp.arrayBuffer()), tooBig: false };
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooBig: true };
    }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks), tooBig: false };
}

/** SHA-256 файла — дубли внутри статьи и между сайтами (photoSearch.ts:613-618). */
export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Размеры с учётом EXIF-ориентации (замена dimsFromBytes, stage-photo-filter/index.ts:107-153). null — файл не декодируется. */
export async function imageDims(bytes: Buffer): Promise<{ width: number; height: number; format: string } | null> {
  try {
    const meta = await sharp(bytes, { failOn: "none" }).metadata();
    if (!meta.width || !meta.height) return null;
    const swap = (meta.orientation ?? 1) >= 5;
    return { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height, format: meta.format || "" };
  } catch {
    return null;
  }
}

/** Подробности технической проверки, которые кладутся в ArtPhotoCandidate.techDetails. */
export type TechDetails = {
  sharpness: number | null;
  contrast: number | null;
  colorfulness: number | null;
  brightness: number | null;
  decoded: boolean;
  usedThumbnail: boolean;
  format: string;
  /** в заголовке/адресе нет слов темы — решает ИИ по картинке */
  weakText?: boolean;
  /** попытка скачивания (1..3) */
  attempt?: number;
  /** отложенный повтор «мягкого» отказа источника, unix-мс */
  retryAfter?: number;
};
