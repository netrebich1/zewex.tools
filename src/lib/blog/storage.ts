/**
 * Файлы сервиса инфо-статей в общем хранилище (storage/, отдаётся nginx как /files/):
 *   blog/<postId>/cand/<candidateId>.jpg          скачанный оригинал кандидата
 *   blog/<postId>/cand/<candidateId>.thumb.webp   миниатюра (сетки, vision-оценка)
 *   blog/<postId>/photos/<photoId>.jpg            фото статьи (JPEG ≤1600 px, как уходит в WordPress)
 *   blog/<postId>/photos/<photoId>.thumb.webp     миниатюра для карточки и проверки
 *   blog/<postId>/photos/<photoId>.pin.jpg        фото с плашкой текста (как Canvas-пин)
 * Сжатие и миниатюры — общие функции статей (src/lib/articles/storage.ts).
 */
import { readdir } from "node:fs/promises";
import { absPath, ensureDir, exists, makeThumb, publicUrl, removePath, toWpJpeg, writeFileAtomic } from "@/lib/articles/storage";

export { absPath, ensureDir, exists, makeThumb, publicUrl, removePath, toWpJpeg, writeFileAtomic };

export const postDir = (postId: string) => `blog/${postId}`;
export const candidateRel = (postId: string, candId: string) => `blog/${postId}/cand/${candId}.jpg`;
export const candidateThumbRel = (postId: string, candId: string) => `blog/${postId}/cand/${candId}.thumb.webp`;
export const photoRel = (postId: string, photoId: string) => `blog/${postId}/photos/${photoId}.jpg`;
export const photoThumbRel = (postId: string, photoId: string) => `blog/${postId}/photos/${photoId}.thumb.webp`;
/** Фото с плашкой текста (этап pin_images) */
export const pinOverlayRel = (postId: string, photoId: string) => `blog/${postId}/photos/${photoId}.pin.jpg`;

/** Удалить все файлы поста (при удалении поста). */
export async function purgePostFiles(postId: string): Promise<void> {
  await removePath(postDir(postId));
}

/** Удалить оригиналы и миниатюры кандидатов вне keepIds (отклонённые после выбора фото). */
export async function purgeCandidateFiles(postId: string, keepIds: Set<string>): Promise<void> {
  const dir = `${postDir(postId)}/cand`;
  let names: string[] = [];
  try { names = await readdir(absPath(dir)); } catch { return; }
  for (const name of names) {
    const id = name.replace(/\.thumb\.webp$/, "").replace(/\.jpg$/, "");
    if (!keepIds.has(id)) await removePath(`${dir}/${name}`).catch(() => {});
  }
}
