import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";

const RING: string[] = [];
const MAX = 300;
let state = "запуск";

const stamp = () => new Date().toLocaleString("ru-RU", { hour12: false });

function write(level: string, msg: string, extra?: unknown) {
  const line = `${stamp()} ${level.padEnd(5)} ${msg}${extra !== undefined ? ` ${extra instanceof Error ? extra.stack ?? extra.message : typeof extra === "string" ? extra : JSON.stringify(extra)}` : ""}`;
  RING.push(line);
  if (RING.length > MAX) RING.shift();
  (level === "ERROR" ? console.error : console.log)(line);
  try {
    mkdirSync(join(dataDir(), "logs"), { recursive: true });
    appendFileSync(join(dataDir(), "logs", `${new Date().toISOString().slice(0, 10)}.log`), line + "\n");
  } catch { /* лог на диск — не критично */ }
}

export const log = {
  info: (m: string, e?: unknown) => write("INFO", m, e),
  warn: (m: string, e?: unknown) => write("WARN", m, e),
  error: (m: string, e?: unknown) => write("ERROR", m, e),
  lines: () => [...RING],
  /** Строка состояния для портала и окна */
  setState: (s: string) => { state = s; console.log(`${stamp()} STATE ${s}`); },
  state: () => state,
};
