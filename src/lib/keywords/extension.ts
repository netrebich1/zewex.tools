import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Папка расширения «Zewex Collector» в коде портала: отсюда собирается ZIP для скачивания, версия — из manifest.json. */
export const EXTENSION_DIR = join(process.cwd(), "extension", "collector");

let cached: string | null = null;

/** Текущая (актуальная) версия расширения — та, что сейчас отдаёт кнопка «Скачать». */
export async function extensionVersion(): Promise<string> {
  if (cached) return cached;
  try {
    const m = JSON.parse(await readFile(join(EXTENSION_DIR, "manifest.json"), "utf8")) as { version?: string };
    cached = m.version || "0";
  } catch {
    cached = "0";
  }
  return cached;
}

/** a < b по частям версии «1.2.3». */
export function olderVersion(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const pa = a.split(".").map((x) => Number(x) || 0), pb = b.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}
