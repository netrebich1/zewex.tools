/**
 * Настройки агента на диске: адрес портала и токен. Токен на Windows защищён DPAPI (через PowerShell, привязан к пользователю Windows),
 * в других системах хранится как есть. Файл: <dataDir>/config.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { dataDir } from "./paths";

export type Config = { portal: string; token: string };
const FILE = () => join(dataDir(), "config.json");
const DEFAULT_PORTAL = "https://zewex.tools";

function dpapi(mode: "Protect" | "Unprotect", data: string): string {
  const ps = mode === "Protect"
    ? `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('${data}'), $null, 'CurrentUser'))`
    : `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${data}'), $null, 'CurrentUser'))`;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true }).trim();
}

const canDpapi = () => process.platform === "win32";

export function loadConfig(): Config | null {
  if (!existsSync(FILE())) return null;
  try {
    const raw = JSON.parse(readFileSync(FILE(), "utf8")) as { portal?: string; token?: string; tokenDpapi?: string };
    const token = raw.tokenDpapi && canDpapi() ? dpapi("Unprotect", raw.tokenDpapi) : raw.token ?? "";
    if (!token) return null;
    return { portal: (raw.portal || DEFAULT_PORTAL).replace(/\/+$/, ""), token };
  } catch {
    return null;
  }
}

export function saveConfig(c: Config): void {
  const out: Record<string, string> = { portal: c.portal.replace(/\/+$/, "") };
  if (canDpapi()) {
    try { out.tokenDpapi = dpapi("Protect", c.token); } catch { out.token = c.token; }
  } else out.token = c.token;
  writeFileSync(FILE(), JSON.stringify(out, null, 2), "utf8");
}

/** Первый запуск: спросить токен (и адрес портала, если задан через ZEWEX_PORTAL). */
export async function askConfig(): Promise<Config> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, (a) => r(a.trim())));
  console.log("Zewex Uploader — первый запуск. Токен выдаётся в портале: Pinterest → Заливка в Pinterest → Агенты → «Добавить агента».");
  let token = "";
  while (!/^zxu_[A-Za-z0-9_-]{20,}$/.test(token)) token = await ask("Вставьте токен агента (zxu_…): ");
  rl.close();
  const c = { portal: (process.env.ZEWEX_PORTAL || DEFAULT_PORTAL).replace(/\/+$/, ""), token };
  saveConfig(c);
  console.log(`Сохранено в ${FILE()}.`);
  return c;
}
