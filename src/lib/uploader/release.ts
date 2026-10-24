/**
 * Сборка агента для скачивания: ZIP кладётся в хранилище `uploader/agent/zewex-uploader-<версия>.zip`
 * (собирается на Windows скриптом agent/uploader/build.ps1 и загружается админом на странице «Агенты»).
 * Версия — файл `uploader/agent/latest.txt`; агент сравнивает с полем `latest` в каждом ответе API.
 */
import { readFile } from "node:fs/promises";
import { absPath, exists, writeFileAtomic } from "@/lib/pins/storage";

const LATEST = "uploader/agent/latest.txt";

export async function agentLatestVersion(): Promise<string> {
  try {
    return (await readFile(absPath(LATEST), "utf8")).trim() || "0";
  } catch {
    return "0";
  }
}

export const agentZipRel = (version: string) => `uploader/agent/zewex-uploader-${version.replace(/[^0-9a-zA-Z.-]/g, "")}.zip`;

export async function agentZipExists(version: string): Promise<boolean> {
  return version !== "0" && exists(agentZipRel(version));
}

/** Сохранить новую сборку: ZIP + отметка версии. */
export async function publishAgentBuild(version: string, zip: Buffer): Promise<void> {
  const v = version.trim();
  if (!/^\d+\.\d+(\.\d+)?$/.test(v)) throw new Error("Версия в виде 1.2 или 1.2.3");
  await writeFileAtomic(agentZipRel(v), zip);
  await writeFileAtomic(LATEST, v);
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
