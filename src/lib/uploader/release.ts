/**
 * Что сотрудник скачивает с портала (всё лежит в нашем хранилище, отдаётся nginx как /files/…):
 *  - сборка агента `uploader/agent/zewex-uploader-<версия>.zip` (собирается на сервере scripts/uploader/build-agent.sh при деплое:
 *    dist + node_modules + node.exe, Node у сотрудника не нужен; версия — `uploader/agent/latest.txt`, агент сравнивает с `latest` в ответах API);
 *  - установщик Dolphin Anty `uploader/downloads/dolphin-anty-setup.exe` (scripts/uploader/fetch-dolphin.sh, дата в `.date`).
 */
import { readFile, stat } from "node:fs/promises";
import { absPath, exists, publicUrl, writeFileAtomic } from "@/lib/pins/storage";

const LATEST = "uploader/agent/latest.txt";
const DOLPHIN = "uploader/downloads/dolphin-anty-setup.exe";

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

export type DownloadInfo = { url: string; sizeMb: number; date: string | null } | null;

/** Ссылки для страницы установки: агент и Dolphin, с размером и датой; null — файла нет. */
export async function downloads(): Promise<{ agent: (DownloadInfo & { version: string }) | null; dolphin: DownloadInfo }> {
  const v = await agentLatestVersion();
  const info = async (rel: string, dateRel?: string): Promise<DownloadInfo> => {
    try {
      const s = await stat(absPath(rel));
      let date: string | null = null;
      try { date = dateRel ? (await readFile(absPath(dateRel), "utf8")).trim() : s.mtime.toISOString().slice(0, 10); } catch { date = s.mtime.toISOString().slice(0, 10); }
      return { url: publicUrl(rel), sizeMb: Math.round(s.size / 1048576), date };
    } catch {
      return null;
    }
  };
  const agent = v !== "0" ? await info(agentZipRel(v)) : null;
  return { agent: agent ? { ...agent, version: v } : null, dolphin: await info(DOLPHIN, "uploader/downloads/dolphin-anty-setup.date") };
}

/** Сохранить сборку, загруженную админом вручную: ZIP + отметка версии. */
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
