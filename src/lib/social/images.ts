/**
 * Фото статьи под формат каждой сети. Metricool принимает прямые ссылки на .jpg/.png, а у сайтов фото чаще .webp,
 * и у сетей свои пропорции — поэтому каждое фото скачивается, приводится к формату сети и отдаётся с нашего сервера
 * (<APP_URL>/files/social/runs/<прогон>/…jpg).
 * Instagram — карусель 4:5 (1080×1350), TikTok — 9:16 (1080×1920); остальным сетям пропорции не важны: исходный кадр в JPEG.
 * Близкие пропорции обрезаются по главному объекту, далёкие — вписываются целиком на размытый фон из того же фото.
 */
import { createHash } from "crypto";
import sharp from "sharp";
import { safeFetch } from "@/lib/pins/fetch";
import { exists, publicUrl, removePath, writeFileAtomic } from "@/lib/pins/storage";
import type { ArticleImageRef, NetworkKey } from "./types";

type Format = { key: string; w: number; h: number } | null;
const FORMATS: Partial<Record<NetworkKey, Format>> = {
  instagram: { key: "4x5", w: 1080, h: 1350 },
  tiktok: { key: "9x16", w: 1080, h: 1920 },
};
/** Обрезаем, если пропорции отличаются не больше чем в 1,3 раза; иначе — вписываем на размытый фон. */
const CROP_MAX_RATIO = 1.3;
const ORIG_MAX_SIDE = 1600;

export const runFilesDir = (runId: string) => `social/runs/${runId}`;

const sources = new Map<string, Promise<Buffer>>();
/** Исходник качаем один раз на прогон статьи (одно фото идёт в несколько сетей). */
function source(url: string): Promise<Buffer> {
  let p = sources.get(url);
  if (!p) {
    p = safeFetch(url, { timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024, accept: "image/*", headers: { "User-Agent": "Mozilla/5.0 (compatible; ZewexSocial/1.0; +https://zewex.tools)" } }).then((r) => {
      if (!r.ok) throw new Error(`фото не скачалось (${r.status})`);
      return r.body;
    });
    sources.set(url, p);
    void p.catch(() => undefined).finally(() => setTimeout(() => sources.delete(url), 120_000));
  }
  return p;
}

async function render(buf: Buffer, fmt: Format): Promise<Buffer> {
  const base = sharp(buf, { failOn: "none" }).rotate();
  if (!fmt) {
    return base.resize({ width: ORIG_MAX_SIDE, height: ORIG_MAX_SIDE, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  }
  const meta = await base.metadata();
  const src = (meta.width || 1) / (meta.height || 1);
  const tgt = fmt.w / fmt.h;
  if (Math.max(src / tgt, tgt / src) <= CROP_MAX_RATIO) {
    return base.resize(fmt.w, fmt.h, { fit: "cover", position: sharp.strategy.attention }).flatten({ background: "#ffffff" }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  }
  const flat = await sharp(buf, { failOn: "none" }).rotate().flatten({ background: "#ffffff" }).toBuffer();
  const bg = await sharp(flat).resize(fmt.w, fmt.h, { fit: "cover" }).blur(40).modulate({ brightness: 0.75 }).toBuffer();
  const fg = await sharp(flat).resize(fmt.w, fmt.h, { fit: "inside" }).toBuffer();
  return sharp(bg).composite([{ input: fg, gravity: "centre" }]).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

/** Фото в формате сети на нашем сервере. Не получилось (битый файл, 403) — фото выпадает из поста, пост остаётся. */
export async function hostedImages(runId: string, net: NetworkKey, images: ArticleImageRef[]): Promise<ArticleImageRef[]> {
  const fmt = FORMATS[net] ?? null;
  const out: ArticleImageRef[] = [];
  for (const im of images) {
    const rel = `${runFilesDir(runId)}/${createHash("sha1").update(im.url).digest("hex").slice(0, 16)}-${fmt?.key ?? "orig"}.jpg`;
    try {
      if (!(await exists(rel))) await writeFileAtomic(rel, await render(await source(im.url), fmt));
      out.push({ url: publicUrl(rel), alt: im.alt });
    } catch {
      /* фото пропускаем */
    }
  }
  return out;
}

export async function removeRunFiles(runId: string): Promise<void> {
  await removePath(runFilesDir(runId)).catch(() => undefined);
}
