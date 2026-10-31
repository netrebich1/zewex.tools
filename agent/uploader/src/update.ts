/**
 * Автообновление: портал в каждом ответе присылает `latest` (версию) и `latestUrl` (ZIP на нашем сервере).
 * Если версия новее — качаем ZIP в <dataDir>/update, распаковываем (PowerShell Expand-Archive), пишем pending.txt
 * и выходим с кодом 75. ZewexUploader.cmd видит код 75, копирует распакованные файлы поверх своей папки и запускает агент снова.
 * Работает только в собранной версии на Windows (dist/*.js); в режиме разработки (tsx) и на других системах — пропуск.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log";
import { dataDir } from "./paths";
import { AGENT_VERSION } from "./protocol";

export const UPDATE_EXIT_CODE = 75;
const tried = new Set<string>();

function olderVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => Number(x) || 0), pb = b.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
}

export function updatesSupported(): boolean {
  return process.platform === "win32" && __filename.endsWith(".js") && !process.env.ZEWEX_NO_UPDATE;
}

/** Есть версия новее — скачать, распаковать, завершить процесс кодом 75 (перезапуск делает .cmd). */
export async function maybeUpdate(latest: string | undefined, latestUrl: string | null | undefined, busy: number): Promise<void> {
  if (!latest || latest === "0" || !latestUrl || !olderVersion(AGENT_VERSION, latest) || tried.has(latest)) return;
  if (!updatesSupported()) { if (!tried.has(latest)) { tried.add(latest); log.warn(`есть версия ${latest}, автообновление здесь недоступно — скачайте ZIP на странице «Агенты»`); } return; }
  if (busy > 0) { log.info(`есть версия ${latest}, обновлюсь после текущих заданий`); return; }
  tried.add(latest);
  const dir = join(dataDir(), "update");
  const zip = join(dir, `zewex-uploader-${latest}.zip`);
  const out = join(dir, latest);
  try {
    mkdirSync(dir, { recursive: true });
    log.setState(`обновление до ${latest}: скачиваю`);
    const res = await fetch(latestUrl, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) throw new Error(`слишком маленький файл (${buf.length} байт)`);
    writeFileSync(zip, buf);
    rmSync(out, { recursive: true, force: true });
    log.setState(`обновление до ${latest}: распаковываю`);
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`], { windowsHide: true, timeout: 5 * 60_000 });
    const root = existsSync(join(out, "zewex-uploader", "dist", "index.js")) ? join(out, "zewex-uploader") : out;
    if (!existsSync(join(root, "dist", "index.js")) || !existsSync(join(root, "node.exe"))) throw new Error("в архиве нет dist/index.js или node.exe");
    // Сам запускатель не перезаписываем: он выполняется в этот момент (cmd читает файл по ходу).
    rmSync(join(root, "ZewexUploader.cmd"), { force: true });
    writeFileSync(join(dir, "pending.txt"), root, "utf8");
    log.info(`обновление до ${latest} готово — перезапускаюсь`);
    process.exit(UPDATE_EXIT_CODE);
  } catch (e) {
    log.warn(`автообновление до ${latest} не удалось — продолжаю на ${AGENT_VERSION}`, e);
  }
}
