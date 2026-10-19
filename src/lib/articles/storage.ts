/**
 * Раскладка файлов сервиса статей в общем хранилище (storage/, отдаётся nginx как /files/):
 *   articles/<articleId>/cand/<candidateId>.jpg          скачанный оригинал кандидата (отклонённые удаляются, одобренные ИИ хранятся)
 *   articles/<articleId>/cand/<candidateId>.thumb.webp   миниатюра для сеток и vision-оценки
 *   articles/<articleId>/photos/<photoId>.jpg            фото статьи (JPEG ≤1600 px, q90 — как уходит в WordPress)
 *   articles/<articleId>/photos/<photoId>.thumb.webp     миниатюра для модерации
 *   articles/<articleId>/gen/<n>.png                      сгенерированные картинки (формат «ИИ-фото»)
 */
import { execFile } from "node:child_process";
import { readFile, readdir, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import sharp from "sharp";
import { absPath, ensureDir, exists, publicUrl, removePath, writeFileAtomic } from "@/lib/pins/storage";

export { absPath, ensureDir, exists, publicUrl, removePath, writeFileAtomic };

export const articleDir = (articleId: string) => `articles/${articleId}`;
export const candidateRel = (articleId: string, candId: string) => `articles/${articleId}/cand/${candId}.jpg`;
export const candidateThumbRel = (articleId: string, candId: string) => `articles/${articleId}/cand/${candId}.thumb.webp`;
export const photoRel = (articleId: string, photoId: string) => `articles/${articleId}/photos/${photoId}.jpg`;
export const photoThumbRel = (articleId: string, photoId: string) => `articles/${articleId}/photos/${photoId}.thumb.webp`;
export const generatedRel = (articleId: string, n: number, ext = "png") => `articles/${articleId}/gen/${n}.${ext}`;

/** Место на диске: файлы статей (du) и раздел хранилища (statfs), МБ. Считает воркер раз в 30 мин — du по тысячам папок не быстрый. */
export async function measureStorage(): Promise<{ storageMb: number; diskFreeMb: number; diskTotalMb: number }> {
  const root = absPath("articles");
  const { stdout } = await promisify(execFile)("du", ["-sm", root], { timeout: 10 * 60_000, maxBuffer: 1 << 20 }).catch(() => ({ stdout: "0" }));
  const fs = await statfs(absPath("."));
  const mb = (blocks: number) => Math.round((blocks * fs.bsize) / 1048576);
  return { storageMb: parseInt(String(stdout), 10) || 0, diskFreeMb: mb(fs.bavail), diskTotalMb: mb(fs.blocks) };
}

/** Параметры сжатия перед загрузкой на сайт (оригинал — JPEG 90). 85 + mozjpeg: −14% веса, PSNR 46.7 дБ к q90 на 30 реальных фото (2026-10-15), глазом не отличить. */
export const WP_IMAGE = { maxSide: 1600, quality: 85 } as const;
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

/**
 * Очистка после публикации без потери истории ИИ-модерации: удаляются все файлы статьи, кроме миниатюр фото статьи
 * (включая исключённые) и миниатюр кандидатов из `keepCandIds` (добавленные ИИ из резерва). Миниатюры ~20 КБ —
 * экран решений ИИ показывает по ним «убрано / добавлено» и после публикации (аудит 2026-10-14).
 */
export async function purgeArticleFilesKeepThumbs(articleId: string, keepCandIds: Set<string>): Promise<void> {
  const dir = articleDir(articleId);
  for (const sub of ["photos", "cand", "gen"]) {
    let names: string[] = [];
    try { names = await readdir(absPath(`${dir}/${sub}`)); } catch { continue; }
    for (const name of names) {
      const keep = name.endsWith(".thumb.webp") && (sub === "photos" || (sub === "cand" && keepCandIds.has(name.slice(0, -".thumb.webp".length))));
      if (!keep) await removePath(`${dir}/${sub}/${name}`).catch(() => {});
    }
  }
}

/**
 * Хранение данных (решение владельца 2026-10-19, под будущий мешап статей): после публикации удаляются только файлы
 * кандидатов вне `keepCandIds` (отклонённые и не оценённые) — оригиналы и миниатюры. Фото статьи (photos/),
 * сгенерированные (gen/) и одобренные ИИ кандидаты (keep / selected / reserve) остаются.
 */
export async function purgeRejectedCandidateFiles(articleId: string, keepCandIds: Set<string>): Promise<void> {
  const dir = `${articleDir(articleId)}/cand`;
  let names: string[] = [];
  try { names = await readdir(absPath(dir)); } catch { return; }
  for (const name of names) {
    const id = name.replace(/\.thumb\.webp$/, "").replace(/\.jpg$/, "");
    if (!keepCandIds.has(id)) await removePath(`${dir}/${name}`).catch(() => {});
  }
}

/**
 * Хранить одобренных кандидатов в сжатом виде (идея владельца 2026-10-19): оригинал заменяется версией «как для WordPress»
 * (JPEG ≤1600 px, q85), если она меньше. У вошедших в статью (`selectedIds`) оригинал удаляется совсем — та же картинка
 * уже лежит сжатой в photos/. Миниатюры не трогаем. Возвращает, сколько байт освободили.
 */
export async function compactKeptCandidates(articleId: string, keepIds: Iterable<string>, selectedIds: Set<string>): Promise<number> {
  let saved = 0;
  for (const id of keepIds) {
    const rel = candidateRel(articleId, id);
    let src: Buffer;
    try { src = await readFile(absPath(rel)); } catch { continue; }
    if (selectedIds.has(id)) {
      await removePath(rel).catch(() => {});
      saved += src.length;
      continue;
    }
    const out = await toWpJpeg(src).catch(() => null);
    if (out && out.bytes.length < src.length) {
      await writeFileAtomic(rel, out.bytes);
      saved += src.length - out.bytes.length;
    }
  }
  return saved;
}

/** Удалить только оригиналы кандидатов вне keepIds (после отбора: отклонённые; одобренные ИИ остаются). */
export async function purgeCandidateOriginals(articleId: string, keepIds: Set<string>, allIds: string[]): Promise<void> {
  for (const id of allIds) {
    if (keepIds.has(id)) continue;
    await removePath(candidateRel(articleId, id)).catch(() => {});
  }
}
