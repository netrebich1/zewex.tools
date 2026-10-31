/**
 * Состояние сервера для плашки в шапке: диск, процессор, память. Читается прямо на сервере портала
 * (тот же сервер, где воркер и хранилище файлов). Ответ кэшируется на 15 с, чтобы много открытых вкладок
 * не замеряли процессор каждая сама.
 */
import os from "node:os";
import { readFile, statfs } from "node:fs/promises";

export type ServerStatus = {
  at: string;
  disk: { path: string; totalGb: number; freeGb: number; usedPct: number };
  cpu: { cores: number; busyPct: number; ioWaitPct: number; load1: number; load5: number; load15: number };
  memory: { totalGb: number; availableGb: number; usedPct: number };
  uptimeHours: number;
};

const TTL_MS = 15_000;
let cache: { at: number; value: ServerStatus } | null = null;
let inflight: Promise<ServerStatus> | null = null;

const GB = 1024 ** 3;
const round1 = (v: number) => Math.round(v * 10) / 10;

type CpuSample = { total: number; idle: number; iowait: number };

/** Linux: строка `cpu` из /proc/stat; иначе — сумма по os.cpus() (без iowait). */
async function cpuSample(): Promise<CpuSample> {
  try {
    const line = (await readFile("/proc/stat", "utf8")).split("\n").find((l) => l.startsWith("cpu "));
    if (line) {
      const v = line.trim().split(/\s+/).slice(1).map(Number);
      // user nice system idle iowait irq softirq steal
      const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
      return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle, iowait };
    }
  } catch { /* не Linux */ }
  let total = 0, idle = 0;
  for (const c of os.cpus()) { const t = c.times; total += t.user + t.nice + t.sys + t.idle + t.irq; idle += t.idle; }
  return { total, idle, iowait: 0 };
}

/** «Доступная» память (MemAvailable): то, что реально можно занять, с учётом кэша файлов. */
async function availableMemory(): Promise<number> {
  try {
    const m = (await readFile("/proc/meminfo", "utf8")).match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (m) return Number(m[1]) * 1024;
  } catch { /* не Linux */ }
  return os.freemem();
}

async function measure(): Promise<ServerStatus> {
  const a = await cpuSample();
  await new Promise((r) => setTimeout(r, 500));
  const b = await cpuSample();
  const dt = Math.max(1, b.total - a.total);
  const idle = b.idle - a.idle;
  const iowait = b.iowait - a.iowait;
  const fs = await statfs("/");
  const totalDisk = fs.blocks * fs.bsize;
  const freeDisk = fs.bavail * fs.bsize;
  const totalMem = os.totalmem();
  const availMem = await availableMemory();
  const [load1, load5, load15] = os.loadavg();
  return {
    at: new Date().toISOString(),
    disk: { path: "/", totalGb: round1(totalDisk / GB), freeGb: round1(freeDisk / GB), usedPct: Math.round((1 - freeDisk / totalDisk) * 100) },
    cpu: {
      cores: os.cpus().length,
      busyPct: Math.max(0, Math.min(100, Math.round(((dt - idle - iowait) / dt) * 100))),
      ioWaitPct: Math.max(0, Math.min(100, Math.round((iowait / dt) * 100))),
      load1: round1(load1), load5: round1(load5), load15: round1(load15),
    },
    memory: { totalGb: round1(totalMem / GB), availableGb: round1(availMem / GB), usedPct: Math.round((1 - availMem / totalMem) * 100) },
    uptimeHours: Math.round(os.uptime() / 3600),
  };
}

export async function serverStatus(): Promise<ServerStatus> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  inflight ??= measure().then((value) => { cache = { at: Date.now(), value }; return value; }).finally(() => { inflight = null; });
  return inflight;
}
