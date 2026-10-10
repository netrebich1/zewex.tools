/**
 * Проверка свободности домена через RDAP (без ключей) с подстраховкой DNS-over-HTTPS.
 * RDAP 404 → свободен (если DNS тоже пуст), 200 → занят, остальное → следующий эндпоинт; все молчат → unknown.
 * Сервер зоны берётся из официального справочника IANA (кэш на сутки), затем известная таблица, затем rdap.org.
 *
 * Реестры ограничивают частоту запросов (SIDN для .nl — ~1 запрос в секунду), поэтому запросы к одному
 * RDAP-хосту идут через очередь с паузой; на 429 пауза растёт и запрос повторяется по Retry-After.
 */
import type { AvailabilityStatus } from "./types";

export type AvailabilityResult = { domain: string; status: AvailabilityStatus; source: "rdap" | "dns" | "none" };

const RDAP_TIMEOUT_MS = 8000;
const DNS_TIMEOUT_MS = 6000;
const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 3600_000;
const MAX_429_RETRIES = 3;
export const CHECK_CONCURRENCY = 8;

/** Запасная таблица на случай, если справочник IANA недоступен. */
const RDAP_SERVERS: Record<string, string> = {
  com: "https://rdap.verisign.com/com/v1/domain/",
  net: "https://rdap.verisign.com/net/v1/domain/",
  nl: "https://rdap.sidn.nl/domain/",
  org: "https://rdap.publicinterestregistry.org/rdap/domain/",
  io: "https://rdap.identitydigital.services/rdap/domain/",
  games: "https://rdap.identitydigital.services/rdap/domain/",
  bet: "https://rdap.identitydigital.services/rdap/domain/",
  co: "https://rdap.nic.co/domain/",
  app: "https://www.registry.google/rdap/domain/",
  dev: "https://www.registry.google/rdap/domain/",
  de: "https://rdap.denic.de/domain/",
  uk: "https://rdap.nominet.uk/uk/domain/",
};

/** Известные лимиты реестров: минимальная пауза между запросами к хосту, мс. Остальные хосты — без паузы, пока не ответят 429. */
const HOST_INTERVALS: Record<string, number> = {
  "rdap.sidn.nl": 1100,
  "rdap.denic.de": 300,
  "rdap.org": 250,
};

/* ---------- Справочник IANA ---------- */

let bootstrap: { map: Map<string, string>; loadedAt: number } | null = null;
let bootstrapLoading: Promise<void> | null = null;

async function loadBootstrap(): Promise<void> {
  try {
    const res = await fetch(BOOTSTRAP_URL, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "zewex-tools-domains/1.0" } });
    if (!res.ok) return;
    const data = (await res.json()) as { services?: Array<[string[], string[]]> };
    const map = new Map<string, string>();
    for (const [tlds, urls] of data.services ?? []) {
      const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];
      if (!url) continue;
      for (const t of tlds) map.set(t.toLowerCase(), url.replace(/\/+$/, "") + "/domain/");
    }
    if (map.size) bootstrap = { map, loadedAt: Date.now() };
  } catch {
    /* остаёмся на запасной таблице */
  }
}

async function rdapBase(tld: string): Promise<string | null> {
  if (!bootstrap || Date.now() - bootstrap.loadedAt > BOOTSTRAP_TTL_MS) {
    if (!bootstrapLoading) bootstrapLoading = loadBootstrap().finally(() => { bootstrapLoading = null; });
    await bootstrapLoading;
  }
  return bootstrap?.map.get(tld) ?? RDAP_SERVERS[tld] ?? null;
}

async function endpointsFor(domain: string): Promise<string[]> {
  const tld = domain.split(".").pop() ?? "";
  const known = await rdapBase(tld);
  const generic = `https://rdap.org/domain/${domain}`;
  return known && !known.includes("rdap.org/") ? [`${known}${domain}`, generic] : [generic];
}

/* ---------- Очередь на хост ---------- */

type Gate = { chain: Promise<void>; nextAt: number; interval: number; base: number; okStreak: number };
const gates = new Map<string, Gate>();

function gateFor(host: string): Gate {
  let g = gates.get(host);
  if (!g) {
    const base = HOST_INTERVALS[host] ?? 0;
    g = { chain: Promise.resolve(), nextAt: 0, interval: base, base, okStreak: 0 };
    gates.set(host, g);
  }
  return g;
}

/** Ждёт своей очереди к хосту; хосты без паузы не сериализуются. */
async function acquireHost(host: string): Promise<void> {
  const g = gateFor(host);
  if (g.interval <= 0) return;
  const prev = g.chain;
  let release!: () => void;
  g.chain = new Promise<void>((r) => { release = r; });
  await prev;
  const wait = g.nextAt - Date.now();
  if (wait > 0) await sleep(wait);
  g.nextAt = Date.now() + g.interval;
  release();
}

function noteOk(host: string) {
  const g = gateFor(host);
  g.okStreak++;
  // Лимит снят: после 40 удачных ответов подряд пауза возвращается к базовой
  if (g.okStreak >= 40 && g.interval > g.base) {
    g.interval = Math.max(g.base, Math.floor(g.interval / 2));
    g.okStreak = 0;
  }
}

function note429(host: string, retryAfterSec: number | null): number {
  const g = gateFor(host);
  g.okStreak = 0;
  g.interval = Math.min(8000, Math.max(1000, g.interval * 2 || 1000));
  const wait = retryAfterSec != null ? Math.min(15_000, Math.max(1000, retryAfterSec * 1000)) : g.interval * 2;
  g.nextAt = Math.max(g.nextAt, Date.now() + wait);
  return wait;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- Запросы ---------- */

/** Ответ RDAP с учётом очереди хоста и повторов на 429. null — сеть/таймаут. */
async function rdapFetch(url: string): Promise<Response | null> {
  const host = new URL(url).hostname;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    await acquireHost(host);
    let res: Response | null = null;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/rdap+json, application/json", "User-Agent": "zewex-tools-domains/1.0" },
        signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch {
      return null;
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = note429(host, Number.isFinite(ra) && ra > 0 ? ra : null);
      if (attempt < MAX_429_RETRIES) await sleep(wait);
      continue;
    }
    if (res.status === 200 || res.status === 404) noteOk(host);
    return res;
  }
  return null;
}

/** true — есть NS-записи (точно занят), false — NXDOMAIN, null — не удалось узнать. */
async function hasDnsRecords(domain: string): Promise<boolean | null> {
  const providers = [
    `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=NS`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`,
  ];
  for (const url of providers) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(DNS_TIMEOUT_MS) });
      if (!res.ok) continue;
      const body = (await res.json()) as { Status?: number; Answer?: unknown[] };
      if (body.Status === 3) return false;
      if (Array.isArray(body.Answer) && body.Answer.length > 0) return true;
      return null;
    } catch {
      /* следующий резолвер */
    }
  }
  return null;
}

export async function checkDomain(domain: string): Promise<AvailabilityResult> {
  for (const url of await endpointsFor(domain)) {
    const res = await rdapFetch(url);
    if (!res) continue;
    if (res.status === 404) {
      const dns = await hasDnsRecords(domain);
      if (dns === true) return { domain, status: "taken", source: "dns" };
      return { domain, status: "available", source: "rdap" };
    }
    if (res.status === 200) return { domain, status: "taken", source: "rdap" };
    // 5xx / неожиданный ответ — пробуем следующий эндпоинт
  }
  const dns = await hasDnsRecords(domain);
  if (dns === true) return { domain, status: "taken", source: "dns" };
  return { domain, status: "unknown", source: "none" };
}

/** Параллельная проверка с ограничением конкурентности; signal прерывает между доменами. */
export async function checkDomains(domains: string[], opts: { signal?: AbortSignal; onResult?: (r: AvailabilityResult) => void } = {}): Promise<AvailabilityResult[]> {
  const results: AvailabilityResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, domains.length) }, async () => {
    while (cursor < domains.length) {
      if (opts.signal?.aborted) return;
      const domain = domains[cursor++]!;
      const r = await checkDomain(domain);
      results.push(r);
      opts.onResult?.(r);
    }
  });
  await Promise.all(workers);
  return results;
}
