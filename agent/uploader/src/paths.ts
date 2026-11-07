import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Папка данных агента: %LOCALAPPDATA%\ZewexUploader (Windows) или ~/.zewex-uploader. */
export function dataDir(): string {
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ZewexUploader") : join(homedir(), ".zewex-uploader");
  mkdirSync(base, { recursive: true });
  return base;
}

export function filesDir(day: string): string {
  const d = join(dataDir(), "files", day.replace(/[^0-9-]/g, ""));
  mkdirSync(d, { recursive: true });
  return d;
}
