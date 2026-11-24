/**
 * Проверка свободности домена через RDAP (без ключей) с подстраховкой DNS-over-HTTPS.
 * RDAP 404 → свободен (если DNS тоже пуст), 200 → занят, остальное → следующий эндпоинт; все молчат → unknown.
 * Сервер зоны берётся из официального справочника IANA (кэш на сутки), затем известная таблица, затем rdap.org.
 *
 * Реестры ограничивают частоту запросов (SIDN для .nl — ~1 запрос в секунду), поэтому запросы к одному
 * RDAP-хосту идут через очередь с паузой; на 429 пауза растёт и запрос повторяется по Retry-After.
 *
 * У части зон RDAP нет совсем (.co, .gr, .mx, .my, .io, .im…): rdap.org отвечает 404 «No RDAP service». Это НЕ «свободен» —
 * зона запоминается, и дальше для неё решает только DNS (NXDOMAIN → свободен, source "dns"; NS есть → занят).
 * Хост, который не резолвится или не принимает соединения (rdap.nic.co), выключается на 10 минут, чтобы не тратить время.
 * Зона, чей RDAP стабильно отвечает дольше SLOW_RDAP_MS (rdap.nic.fr ~5 с на запрос), тоже переходит на DNS — иначе бренд
 * с такой зоной проверяется в десятки раз дольше остальных.
 *
 * Один обрыв соединения хост не выключает: нужно несколько быстрых отказов подряд, и пауза короткая. rdap.org не выключается
 * вообще — он только перенаправляет в реестр, и отказ реестра нельзя приписывать ему.
 */
import type { AvailabilityStatus } from "./types";

export type AvailabilityResult = { domain: string; status: AvailabilityStatus; source: "rdap" | "dns" | "none" };

const RDAP_TIMEOUT_MS = 8000;
const DNS_TIMEOUT_MS = 6000;
const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 3600_000;
const MAX_429_RETRIES = 1;
/** Реестр отвечает 429 подряд: перестаём к нему ходить на это время (растёт до часа), зона идёт по DNS. */
const THROTTLE_FIRST_MS = 10 * 60_000;
const THROTTLE_MAX_MS = 60 * 60_000;
const THROTTLE_AFTER_429 = 3;
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
  "rdap.registro.br": 700,
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

/** Эндпоинты RDAP домена без мёртвых и «задушенных» хостов; throttled — живые есть, но все задушены лимитом. */
async function endpointsFor(domain: string): Promise<{ urls: string[]; throttled: boolean }> {
  const tld = domain.split(".").pop() ?? "";
  const known = await rdapBase(tld);
  const generic = `https://rdap.org/domain/${domain}`;
  const list = known && !known.includes("rdap.org/") ? [`${known}${domain}`, generic] : [generic];
  const alive = list.filter((u) => !isHostDead(new URL(u).hostname));
  const urls = alive.filter((u) => !isThrottled(new URL(u).hostname));
  return { urls, throttled: alive.length > 0 && urls.length === 0 };
}

/* ---------- Лимит реестра (429) ---------- */

const throttled = new Map<string, { until: number; backoff: number }>();
const host429 = new Map<string, number>();

function isThrottled(host: string): boolean {
  const t = throttled.get(host);
  return !!t && Date.now() < t.until;
}

/** 429 подряд или долгий Retry-After: хост «задушен» — не ждём его, а решаем по DNS, пока лимит не снимут. */
function noteThrottle(host: string, retryAfterSec: number | null): boolean {
  const n = (host429.get(host) ?? 0) + 1;
  host429.set(host, n);
  if (n < THROTTLE_AFTER_429 && !(retryAfterSec != null && retryAfterSec >= 60)) return false;
  const prev = throttled.get(host);
  const backoff = prev ? Math.min(THROTTLE_MAX_MS, prev.backoff * 2) : THROTTLE_FIRST_MS;
  throttled.set(host, { until: Date.now() + Math.max(backoff, Math.min(THROTTLE_MAX_MS, (retryAfterSec ?? 0) * 1000)), backoff });
  host429.delete(host);
  return true;
}

/** Хосты RDAP, которые сейчас задушены лимитом: для логов и подсказки в карточке. */
export function throttledRdapHosts(): Array<{ host: string; until: number }> {
  return Array.from(throttled.entries()).filter(([, t]) => Date.now() < t.until).map(([host, t]) => ({ host, until: t.until }));
}

/* ---------- Зоны без RDAP и мёртвые хосты ---------- */

/** Зоны, для которых rdap.org ответил «No RDAP service» или RDAP слишком медленный: проверяем только по DNS. */
const noRdapTlds = new Map<string, number>();
const SLOW_TLD_MS = 15 * 60_000;

function isNoRdap(tld: string): boolean {
  const until = noRdapTlds.get(tld);
  if (until === undefined) return false;
  if (Date.now() > until) {
    noRdapTlds.delete(tld);
    rdapTimes.delete(tld);
    return false;
  }
  return true;
}
const SLOW_RDAP_MS = 3000;
const SLOW_RDAP_SAMPLES = 4;
/** Время ответа RDAP по зоне (последние ответы), мс. */
const rdapTimes = new Map<string, number[]>();

function noteRdapTime(tld: string, ms: number) {
  const list = [...(rdapTimes.get(tld) ?? []), ms].slice(-SLOW_RDAP_SAMPLES);
  rdapTimes.set(tld, list);
  if (list.length >= SLOW_RDAP_SAMPLES && list.every((t) => t > SLOW_RDAP_MS)) noRdapTlds.set(tld, Date.now() + SLOW_TLD_MS);
}
const DEAD_HOST_MS = 60_000;
const DEAD_HOST_FAILURES = 5;
const deadHosts = new Map<string, number>();
/** Быстрые отказы хоста подряд; любой ответ хоста обнуляет счёт. */
const hostFailures = new Map<string, number>();

function noteHostFailure(host: string) {
  if (host === "rdap.org") return;
  const n = (hostFailures.get(host) ?? 0) + 1;
  if (n < DEAD_HOST_FAILURES) {
    hostFailures.set(host, n);
    return;
  }
  hostFailures.delete(host);
  deadHosts.set(host, Date.now() + DEAD_HOST_MS);
}

function isHostDead(host: string): boolean {
  const until = deadHosts.get(host);
  if (!until) return false;
  if (Date.now() > until) {
    deadHosts.delete(host);
    return false;
  }
  return true;
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

/** Ответ RDAP с учётом очереди хоста и повторов на 429. null — сеть/таймаут; "throttled" — реестр задушил лимитом. */
async function rdapFetch(url: string, tld: string): Promise<Response | null | "throttled"> {
  const host = new URL(url).hostname;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    if (isThrottled(host)) return "throttled";
    await acquireHost(host);
    if (isNoRdap(tld)) return null;
    if (isThrottled(host)) return "throttled";
    let res: Response | null = null;
    const started = Date.now();
    try {
      res = await fetch(url, {
        headers: { Accept: "application/rdap+json, application/json", "User-Agent": "zewex-tools-domains/1.0" },
        signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch {
      // Быстрый отказ (обрыв, имя не резолвится) считаем по хосту; таймаут — как очень медленный ответ зоны
      const elapsed = Date.now() - started;
      if (elapsed < SLOW_RDAP_MS) noteHostFailure(host);
      else noteRdapTime(tld, elapsed);
      return null;
    }
    hostFailures.delete(host);
    if (res.status === 429) {
      await res.body?.cancel().catch(() => {});
      const raRaw = Number(res.headers.get("retry-after"));
      const ra = Number.isFinite(raRaw) && raRaw > 0 ? raRaw : null;
      if (noteThrottle(host, ra)) return "throttled";
      const wait = note429(host, ra);
      if (attempt < MAX_429_RETRIES) await sleep(Math.min(wait, 5000));
      continue;
    }
    if (res.status === 200 || res.status === 404) {
      host429.delete(host);
      noteOk(host);
      noteRdapTime(tld, Date.now() - started);
    }
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

/** Итог только по DNS (зона без RDAP): NXDOMAIN — свободен, NS есть — занят, иначе не проверен. */
async function byDnsOnly(domain: string, pre: boolean | null): Promise<AvailabilityResult> {
  const dns = pre === null ? await hasDnsRecords(domain) : pre;
  if (dns === true) return { domain, status: "taken", source: "dns" };
  if (dns === false) return { domain, status: "available", source: "dns" };
  return { domain, status: "unknown", source: "none" };
}

export async function checkDomain(domain: string): Promise<AvailabilityResult> {
  // Сначала дешёвый DNS: у занятого домена почти всегда есть NS-записи, и RDAP (с лимитами реестров) не нужен.
  const pre = await hasDnsRecords(domain);
  if (pre === true) return { domain, status: "taken", source: "dns" };
  const tld = domain.split(".").pop() ?? "";
  if (isNoRdap(tld)) return byDnsOnly(domain, pre);
  const ep = await endpointsFor(domain);
  // Реестр задушил нас лимитом: не ждём, решаем по DNS (NS есть — занят, NXDOMAIN — свободен «по DNS»)
  if (ep.throttled) return byDnsOnly(domain, pre);
  let sawThrottle = false;
  let answered = false;
  for (const url of ep.urls) {
    const res = await rdapFetch(url, tld);
    // Пока ждали очереди, другой запрос выяснил, что у зоны нет RDAP
    if (isNoRdap(tld)) return byDnsOnly(domain, pre);
    if (res === "throttled") { sawThrottle = true; continue; }
    if (!res) continue;
    answered = true;
    if (res.status === 404 && new URL(url).hostname === "rdap.org") {
      // rdap.org отвечает 404 и на «нет такого домена», и на «у зоны нет RDAP» — второе не значит «свободен»
      const body = await res.text().catch(() => "");
      if (/No RDAP service/i.test(body)) {
        noRdapTlds.set(tld, Number.POSITIVE_INFINITY);
        return byDnsOnly(domain, pre);
      }
    }
    if (res.status === 404) {
      // DNS не ответил заранее — перепроверим, прежде чем объявить домен свободным
      const dns = pre === null ? await hasDnsRecords(domain) : pre;
      if (dns === true) return { domain, status: "taken", source: "dns" };
      return { domain, status: "available", source: "rdap" };
    }
    if (res.status === 200) return { domain, status: "taken", source: "rdap" };
    // 5xx / неожиданный ответ — пробуем следующий эндпоинт
  }
  if (sawThrottle && !answered) return byDnsOnly(domain, pre);
  const dns = pre === null ? await hasDnsRecords(domain) : pre;
  if (dns === true) return { domain, status: "taken", source: "dns" };
  // Своего RDAP у зоны нет (по справочнику IANA), а rdap.org не ответил: как и для других таких зон, решает DNS
  if (dns === false && bootstrap && !(await rdapBase(tld))) return { domain, status: "available", source: "dns" };
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
