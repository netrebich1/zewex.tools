import sharp from "sharp";
import { createHash } from "crypto";

/**
 * Обработка картинок через sharp (замена стороннего images.weserv.nl).
 * Все выходные JPEG без EXIF и прочих метаданных.
 */

sharp.concurrency(1);

export type ImageInfo = { width: number; height: number; format: string };

export async function imageInfo(buf: Buffer): Promise<ImageInfo> {
  const m = await sharp(buf).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0, format: m.format ?? "" };
}

/** Чистый JPEG для медиатеки WordPress и CSV: сплющить прозрачность на белом, убрать метаданные. */
export async function toCleanJpeg(buf: Buffer, opts: { maxSide?: number; quality?: number } = {}): Promise<{ data: Buffer; width: number; height: number }> {
  const maxSide = opts.maxSide ?? 2000;
  const out = await sharp(buf)
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: opts.quality ?? 88, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height };
}

/** Уменьшенная копия для сеток модерации. */
export async function makeThumb(buf: Buffer, width = 400): Promise<Buffer> {
  return sharp(buf).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
}

/** Фото статьи для Canvas: ограничить размер, чтобы не держать гигантские битмапы в памяти. */
export async function prepareForCanvas(buf: Buffer, maxSide = 1600): Promise<Buffer> {
  return sharp(buf).rotate().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}
