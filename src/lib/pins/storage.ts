import { mkdir, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, join, normalize } from "path";
import { randomBytes } from "crypto";

/**
 * Файловое хранилище сервиса пинов. Раскладка:
 *   pins/runs/<runId>/<itemId>.jpg   картинки пинов (чистый JPEG)
 *   pins/photos/<sha1(url)>.jpg      кэш фото статей
 *   pins/examples/<id>.<ext>         примеры пинов
 *   pins/previews/<styleId>-<n>.jpg  превью Canvas-стилей
 *   pins/fonts/...                   шрифты (nginx не отдаёт)
 * Публичный адрес: <APP_URL>/files/<относительный путь> (nginx, кэш год).
 */

export function storageRoot(): string {
  return process.env.PINS_STORAGE_DIR || "/var/www/zewex_tools_usr/data/storage";
}

function safeRel(rel: string): string {
  const n = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^\/+/, "");
  if (n.includes("..")) throw new Error(`Недопустимый путь хранилища: ${rel}`);
  return n;
}

export function absPath(rel: string): string {
  return join(storageRoot(), safeRel(rel));
}

export function publicUrl(rel: string): string {
  const base = (process.env.APP_URL || "https://zewex.tools").replace(/\/+$/, "");
  return `${base}/files/${safeRel(rel)}`;
}

export async function ensureDir(relDir: string): Promise<string> {
  const p = absPath(relDir);
  await mkdir(p, { recursive: true });
  return p;
}

/** Атомарная запись: во временный файл рядом, затем rename. */
export async function writeFileAtomic(rel: string, data: Buffer | string): Promise<string> {
  const target = absPath(rel);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
  return target;
}

export async function exists(rel: string): Promise<boolean> {
  try {
    await stat(absPath(rel));
    return true;
  } catch {
    return false;
  }
}

export async function removePath(rel: string): Promise<void> {
  await rm(absPath(rel), { recursive: true, force: true });
}

export const runDir = (runId: string) => `pins/runs/${runId}`;
export const itemImageRel = (runId: string, itemId: string) => `pins/runs/${runId}/${itemId}.jpg`;
export const itemThumbRel = (runId: string, itemId: string) => `pins/runs/${runId}/${itemId}.thumb.webp`;
export const exampleRel = (id: string, ext: string) => `pins/examples/${id}.${ext.replace(/^\./, "")}`;
export const previewRel = (styleId: string, count: number, rev: number) => `pins/previews/${styleId}-${rev}-${count}.jpg`;
