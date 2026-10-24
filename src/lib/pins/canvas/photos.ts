import { readFile } from "fs/promises";
import { safeFetch } from "../fetch";
import { prepareForCanvas, sha1 } from "../images";
import { absPath, exists, writeFileAtomic } from "../storage";

/** Фото статьи для рендера: кэш на диске pins/photos/<sha1(url)>.jpg (≤1600 px). */
export async function cachedPhoto(url: string, signal?: AbortSignal): Promise<Buffer> {
  const rel = `pins/photos/${sha1(url)}.jpg`;
  if (await exists(rel)) return readFile(absPath(rel));
  const res = await safeFetch(url, { accept: "image/*", timeoutMs: 25_000, signal });
  if (!res.ok) throw new Error(`Фото недоступно (HTTP ${res.status})`);
  const jpeg = await prepareForCanvas(res.body, 1600);
  await writeFileAtomic(rel, jpeg);
  return jpeg;
}

/** Нейтральные тестовые фото для превью стилей (сайты владельца). */
export const TEST_PHOTO_URLS = [
  "https://zorvianix.com/wp-content/uploads/2025/08/short-fall-nails-trends-2025-20.webp",
  "https://zorvianix.com/wp-content/uploads/2025/08/fall-hairstyles-for-women-over-50-ideas-2025-16.webp",
  "https://beautydaily.com.ua/wp-content/uploads/2026/08/zhinochi-stylni-obrazy-na-osin-9.webp",
  "https://zorvianix.com/wp-content/uploads/2025/08/fall-gel-nails-designs-2025-20.webp",
  "https://zorvianix.com/wp-content/uploads/2025/07/fall-fashion-outfits-ideas-2025-for-women-60-9.webp",
  "https://beautydaily.com.ua/wp-content/uploads/2026/06/summer-haircuts-for-women-over-30-8.webp",
];

export async function testPhotos(signal?: AbortSignal): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const u of TEST_PHOTO_URLS) {
    try { out.push(await cachedPhoto(u, signal)); } catch { /* пропускаем битое фото */ }
  }
  if (out.length < 4) throw new Error("Не удалось загрузить тестовые фото для превью");
  return out;
}
