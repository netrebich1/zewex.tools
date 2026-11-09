/**
 * Все запросы к API DeepL идут отсюда: напрямую или через SOCKS5-прокси из «Прокси DeepL».
 *
 * Ключ всегда ходит через один и тот же прокси: выбор по наибольшему хешу (ключ + прокси) среди рабочих прокси.
 * Добавили или убрали прокси — переезжают только ключи этого прокси, остальные остаются на своих IP
 * (DeepL закрывает API аккаунтам, которые видит с одного адреса; так было 2026-11-03).
 * Прокси заведены, но ни один не работает — запрос не уходит напрямую с сервера, а падает с понятной ошибкой.
 */
import { createHash } from "node:crypto";
import { fetch as ufetch, type Dispatcher, type RequestInit, type Response } from "undici";
import { socksDispatcher } from "fetch-socks";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

type ProxyRow = { id: string; host: string; port: number; username: string; password: string; label: string };

/** Список перечитывается из базы не чаще раза в 30 с, как пул ключей. */
const TTL_MS = 30_000;
/** Сетевых сбоев подряд, после которых прокси выключается сам. */
const MAX_FAILS = 3;

let cache: { at: number; total: number; active: ProxyRow[] } | null = null;
const dispatchers = new Map<string, Dispatcher>();

export const proxyLabel = (p: { host: string; port: number }) => `${p.host}:${p.port}`;

async function loadProxies(): Promise<{ total: number; active: ProxyRow[] }> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const rows = await prisma.deeplProxy.findMany({ orderBy: { createdAt: "asc" } });
  const active = rows.filter((r) => r.isActive).map((r) => ({
    id: r.id, host: r.host, port: r.port, username: r.username, password: r.passwordEnc ? decryptSecret(r.passwordEnc) : "", label: proxyLabel(r),
  }));
  cache = { at: Date.now(), total: rows.length, active };
  return cache;
}

export function resetProxyCache(): void {
  cache = null;
}

function dispatcherFor(p: ProxyRow): Dispatcher {
  const k = `${p.id}|${p.host}|${p.port}|${p.username}|${p.password}`;
  let d = dispatchers.get(k);
  if (!d) {
    d = socksDispatcher({ type: 5, host: p.host, port: p.port, ...(p.username ? { userId: p.username, password: p.password } : {}) });
    dispatchers.set(k, d);
  }
  return d;
}

const weight = (secret: string, proxyId: string) => createHash("sha256").update(`${secret.trim().toLowerCase()}|${proxyId}`).digest().readUInt32BE(0);

/** Прокси ключа (null — прокси не заведены, запрос идёт напрямую). */
export async function proxyForSecret(secret: string): Promise<ProxyRow | null> {
  const { total, active } = await loadProxies();
  if (!total) return null;
  if (!active.length) throw new Error("Все прокси DeepL выключены или не отвечают — включите или добавьте прокси на вкладке «Прокси»");
  return active.reduce((best, p) => (weight(secret, p.id) > weight(secret, best.id) ? p : best));
}

async function noteProxyResult(p: ProxyRow, err: string | null): Promise<void> {
  if (!err) {
    await prisma.deeplProxy.updateMany({ where: { id: p.id, failCount: { gt: 0 } }, data: { failCount: 0, lastError: null } }).catch(() => {});
    return;
  }
  const row = await prisma.deeplProxy.update({ where: { id: p.id }, data: { failCount: { increment: 1 }, lastError: err.slice(0, 500) } }).catch(() => null);
  if (row && row.failCount >= MAX_FAILS && row.isActive) {
    await prisma.deeplProxy.update({ where: { id: p.id }, data: { isActive: false, lastError: `Автоотключён после ${row.failCount} сбоев подряд: ${err}`.slice(0, 500) } }).catch(() => {});
    cache = null;
  }
}

/** Сетевая ошибка через прокси — с адресом прокси, чтобы было видно, кто не отвечает. */
function netError(e: unknown, p: ProxyRow | null): Error {
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
  const msg = `${e instanceof Error ? e.message : String(e)}${cause}`;
  return new Error(p ? `прокси ${p.label}: ${msg}` : msg);
}

/** fetch к DeepL ключом secret: через его прокси, если прокси заведены. */
export async function deeplFetch(secret: string, url: string, init: RequestInit = {}): Promise<Response> {
  const p = await proxyForSecret(secret);
  try {
    const res = await ufetch(url, { ...init, ...(p ? { dispatcher: dispatcherFor(p) } : {}) });
    if (p) await noteProxyResult(p, null);
    return res;
  } catch (e) {
    const err = netError(e, p);
    // Таймаут ответа DeepL — не вина прокси; отказ соединения, SOCKS и DNS — его.
    if (p && !(e instanceof Error && e.name === "TimeoutError")) await noteProxyResult(p, err.message);
    throw err;
  }
}

/** Проверка прокси: внешний IP и доступен ли через него API DeepL (без ключа DeepL отвечает 403 — значит, достучались). */
export async function checkProxy(id: string): Promise<{ ok: boolean; note: string; ip: string | null }> {
  const r = await prisma.deeplProxy.findUniqueOrThrow({ where: { id } });
  const p: ProxyRow = { id: r.id, host: r.host, port: r.port, username: r.username, password: r.passwordEnc ? decryptSecret(r.passwordEnc) : "", label: proxyLabel(r) };
  const dispatcher = dispatcherFor(p);
  let ip: string | null = null;
  let ok = false;
  let note: string;
  try {
    const ipRes = await ufetch("https://api.ipify.org?format=json", { dispatcher, signal: AbortSignal.timeout(15_000) });
    ip = ((await ipRes.json()) as { ip?: string }).ip ?? null;
    const dl = await ufetch("https://api-free.deepl.com/v2/usage", { dispatcher, signal: AbortSignal.timeout(15_000) });
    ok = dl.status === 403 || dl.status === 401 || dl.ok;
    note = ok ? `работает · IP ${ip ?? "?"} · DeepL доступен` : `IP ${ip ?? "?"}, но DeepL ответил ${dl.status}`;
  } catch (e) {
    note = netError(e, null).message;
  }
  const now = new Date();
  await prisma.deeplProxy.update({
    where: { id },
    data: {
      lastCheckedAt: now, lastCheckOk: ok, lastCheckNote: note.slice(0, 500), exitIp: ip,
      ...(ok ? { failCount: 0, lastError: null } : {}),
    },
  });
  cache = null;
  return { ok, note, ip };
}

/** Строка списка → прокси. Форматы: ip:port:user:pass, user:pass@ip:port, socks5://user:pass@ip:port, ip:port. */
export function parseProxyLine(line: string): { host: string; port: number; username: string; password: string } | null {
  const t = line.trim().replace(/^socks5h?:\/\//i, "");
  if (!t) return null;
  let m = t.match(/^([^:@\s]+):([^@\s]*)@([^:\s]+):(\d{1,5})$/);
  if (m) return { host: m[3]!, port: Number(m[4]), username: m[1]!, password: m[2]! };
  m = t.match(/^([^:\s]+):(\d{1,5})(?::([^:\s]*):(\S*))?$/);
  if (m) return { host: m[1]!, port: Number(m[2]), username: m[3] ?? "", password: m[4] ?? "" };
  return null;
}

/** Сколько ключей DeepL сидит на каждом прокси (для списка прокси). */
export async function keysPerProxy(): Promise<Map<string, number>> {
  const keys = await prisma.deeplKey.findMany({ where: { deletedAt: null }, select: { secretEnc: true } });
  const out = new Map<string, number>();
  for (const k of keys) {
    const p = await proxyForSecret(decryptSecret(k.secretEnc)).catch(() => null);
    if (p) out.set(p.id, (out.get(p.id) ?? 0) + 1);
  }
  return out;
}
