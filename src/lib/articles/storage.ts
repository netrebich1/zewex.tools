/**
 * Раскладка файлов сервиса статей в общем хранилище (storage/, отдаётся nginx как /files/):
 *   articles/<articleId>/cand/<candidateId>.jpg          скачанный оригинал кандидата (удаляется после отбора)
 *   articles/<articleId>/cand/<candidateId>.thumb.webp   миниатюра для сеток и vision-оценки
 *   articles/<articleId>/photos/<photoId>.jpg            фото статьи (JPEG ≤1600 px, q90 — как уходит в WordPress)
 *   articles/<articleId>/photos/<photoId>.thumb.webp     миниатюра для модерации
 *   articles/<articleId>/gen/<n>.png                      сгенерированные картинки (формат «ИИ-фото»)
 */
import sharp from "sharp";
import { absPath, ensureDir, exists, publicUrl, removePath, writeFileAtomic } from "@/lib/pins/storage";

export { absPath, ensureDir, exists, publicUrl, removePath, writeFileAtomic };

export const articleDir = (articleId: string) => `articles/${articleId}`;
export const candidateRel = (articleId: string, candId: string) => `articles/${articleId}/cand/${candId}.jpg`;
export const candidateThumbRel = (articleId: string, candId: string) => `articles/${articleId}/cand/${candId}.thumb.webp`;
export const photoRel = (articleId: string, photoId: string) => `articles/${articleId}/photos/${photoId}.jpg`;
export const photoThumbRel = (articleId: string, photoId: string) => `articles/${articleId}/photos/${photoId}.thumb.webp`;
export const generatedRel = (articleId: string, n: number, ext = "png") => `articles/${articleId}/gen/${n}.${ext}`;

/** Параметры сжатия перед загрузкой на сайт (оригинал: _shared/compressImage.ts — JPEG 90, длинная сторона ≤1600). */
export const WP_IMAGE = { maxSide: 1600, quality: 90 } as const;
export const THUMB = { width: 400, quality: 78 } as const;

/** Миниатюра WebP шириной THUMB.width (высота по пропорции). */
export async function makeThumb(src: Buffer, width = THUMB.width): Promise<Buffer> {
  return sharp(src).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: THUMB.quality }).toBuffer();
}

/**
 * JPEG для WordPress: ≤1600 px по длинной стороне, качество 90, без увеличения маленьких кадров.
 * Если исходник — уже JPEG и получился легче результата, возвращаем исходник (оригинал: тяжёлый JPEG не подменяет лёгкий).
 */
export async function toWpJpeg(src: Buffer): Promise<{ bytes: Buffer; width: number; height: number }> {
  const meta = await sharp(src).rotate().metadata();
  const out = await sharp(src).rotate().resize({ width: WP_IMAGE.maxSide, height: WP_IMAGE.maxSide, fit: "inside", withoutEnlargement: true }).jpeg({ quality: WP_IMAGE.quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const isJpeg = meta.format === "jpeg";
  const fits = (meta.width ?? 0) <= WP_IMAGE.maxSide && (meta.height ?? 0) <= WP_IMAGE.maxSide;
  if (isJpeg && fits && src.length <= out.data.length) return { bytes: src, width: meta.width ?? out.info.width, height: meta.height ?? out.info.height };
  return { bytes: out.data, width: out.info.width, height: out.info.height };
}

/** Удалить все файлы статьи (после публикации с wpUrl или при удалении статьи). */
export async function purgeArticleFiles(articleId: string): Promise<void> {
  await removePath(articleDir(articleId));
}

/** Удалить только оригиналы кандидатов (после отбора; миниатюры остаются для резерва в модерации). */
export async function purgeCandidateOriginals(articleId: string, keepIds: Set<string>, allIds: string[]): Promise<void> {
  for (const id of allIds) {
    if (keepIds.has(id)) continue;
    await removePath(candidateRel(articleId, id)).catch(() => {});
  }
}
