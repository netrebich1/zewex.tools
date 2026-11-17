/**
 * Semrush SEO API (формат v3) через шлюз Group by SEO: https://api-semrush.groupbuyseo.org/?key=…&type=…
 * Ключ владельца — GROUPBYSEO_API_KEY в .env (в репозиторий не попадает). Баланс — юниты (100 000 на 17.11.2026):
 * phrase_these 10 юнитов за строку, phrase_related 40 за строку, phrase_kdi 50 — поэтому KD берём колонкой Kd
 * в обзоре, а related только для лучших кандидатов и с малым display_limit.
 * Ответ — CSV с «;», первая строка — заголовки; ошибки — текстом «ERROR N :: …» (503 = у шлюза лежит апстрим).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.GROUPBYSEO_SEMRUSH_URL || "https://api-semrush.groupbuyseo.org/";
/** Кэш замеров на диске (ключ «база|фраза»): юниты за один и тот же ключ не тратятся дважды. Данные Semrush месячные. */
const CACHE_FILE = process.env.SEMRUSH_CACHE_FILE || ".semrush-cache.json";
let cache: Record<string, KeywordMetrics> | null = null;
function loadCache() {
  if (cache) return cache;
  try { cache = existsSync(CACHE_FILE) ? (JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Record<string, KeywordMetrics>) : {}; } catch { cache = {}; }
  return cache;
}
function saveCache() { if (cache) writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8"); }

export class SemrushError extends Error {
  constructor(public code: number, message: string) { super(message); }
  /** Нечего найти: не ошибка доступа, просто нет данных. */
  get nothingFound() { return this.code === 50; }
  /** Апстрим шлюза лежит или лимит — повторить позже. */
  get retryable() { return this.code === 503 || this.code === 429; }
}

export type KeywordMetrics = {
  phrase: string;
  /** Среднемесячный объём в базе */
  volume: number;
  /** Keyword Difficulty 0–100 */
  kd: number | null;
  cpc: number | null;
  competition: number | null;
  results: number | null;
  /** Релевантность для phrase_related */
  relevance?: number;
  /** Намерение: коды Semrush через запятую (0 коммерческое, 1 информационное, 2 навигационное, 3 транзакционное) */
  intent?: string;
  /** SERP-признаки: коды через запятую; 52 = AI Overview */
  serp?: string;
  /** 12 месячных значений тренда 0–1 */
  trends?: number[];
};

export const AIO_CODE = "52";
export const hasAio = (m: Pick<KeywordMetrics, "serp">) => !!m.serp && m.serp.split(",").map((s) => s.trim()).includes(AIO_CODE);
/** Полный набор колонок обзора: метрики, намерение, SERP-признаки, тренд — всё в одной строке за те же 10 юнитов. */
const FULL_COLUMNS = "Ph,Nq,Cp,Co,Nr,Kd,In,Fk,Td";

/** Колонки Semrush → поля. Остальные колонки игнорируются. */
const COL: Record<string, keyof KeywordMetrics> = { Keyword: "phrase", "Search Volume": "volume", "Keyword Difficulty": "kd", "Keyword Difficulty Index": "kd", CPC: "cpc", Competition: "competition", "Number of Results": "results", "Related Relevance": "relevance", Intent: "intent", "Keywords SERP Features": "serp", Trends: "trends" };
const TEXT_COLS = new Set<keyof KeywordMetrics>(["phrase", "intent", "serp"]);

function parseCsv(text: string): KeywordMetrics[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(";").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(";");
    const m: KeywordMetrics = { phrase: "", volume: 0, kd: null, cpc: null, competition: null, results: null };
    header.forEach((h, i) => {
      const key = COL[h];
      if (!key) return;
      const v = (cells[i] ?? "").trim();
      if (key === "phrase") m.phrase = v;
      else if (key === "trends") m.trends = v ? v.split(",").map((x) => Number(x)).filter((x) => !Number.isNaN(x)) : undefined;
      else if (TEXT_COLS.has(key)) (m as Record<string, unknown>)[key] = v || undefined;
      else {
        const n = Number(v.replace(",", "."));
        (m as Record<string, unknown>)[key] = v === "" || Number.isNaN(n) ? null : n;
      }
    });
    m.volume = m.volume ?? 0;
    return m;
  });
}

async function request(params: Record<string, string>): Promise<string> {
  const key = process.env.GROUPBYSEO_API_KEY;
  if (!key) throw new SemrushError(401, "GROUPBYSEO_API_KEY не задан");
  const url = new URL(BASE);
  url.searchParams.set("key", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    const err = text.match(/^ERROR (\d+) :: (.*)$/m);
    if (err) throw new SemrushError(Number(err[1]), err[2].trim());
    if (!r.ok) throw new SemrushError(r.status, text.slice(0, 200));
    return text;
  } finally {
    clearTimeout(t);
  }
}

/** Повтор при 503/429: шлюз теряет апстрим на минуты. */
async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof SemrushError) || !e.retryable || i >= tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 15_000 * (i + 1)));
    }
  }
}

/** Юниты, потраченные процессом (для журнала скриптов). */
export const semrushUnits = { spent: 0 };

/**
 * Обзор до 100 ключей за запрос (phrase_these, 10 юнитов за строку). Ключи без данных в ответ не попадают —
 * вызывающий считает их объёмом 0. База — код Semrush: cz, de, pl, ro, es, us…
 */
export async function keywordOverview(phrases: string[], database: string): Promise<Map<string, KeywordMetrics>> {
  const out = new Map<string, KeywordMetrics>();
  const c = loadCache();
  const uniq = [...new Set(phrases.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  const fresh: string[] = [];
  for (const p of uniq) {
    const hit = c[`${database}|${p}`];
    if (hit) { if (hit.volume > 0) out.set(p, hit); } else fresh.push(p);
  }
  const zero = (p: string): KeywordMetrics => ({ phrase: p, volume: 0, kd: null, cpc: null, competition: null, results: null });
  for (let i = 0; i < fresh.length; i += 100) {
    const batch = fresh.slice(i, i + 100);
    try {
      const text = await withRetry(() => request({ type: "phrase_these", phrase: batch.join(";"), database, export_columns: FULL_COLUMNS }));
      const rows = parseCsv(text);
      semrushUnits.spent += rows.length * 10;
      for (const r of rows) { out.set(r.phrase.toLowerCase(), r); c[`${database}|${r.phrase.toLowerCase()}`] = r; }
      // Ключей, которых нет в ответе, Semrush не знает: запоминаем как объём 0, чтобы не спрашивать снова.
      for (const p of batch) if (!c[`${database}|${p}`]) c[`${database}|${p}`] = zero(p);
    } catch (e) {
      if (e instanceof SemrushError && e.nothingFound) { for (const p of batch) c[`${database}|${p}`] = zero(p); continue; }
      throw e;
    } finally {
      saveCache();
    }
  }
  return out;
}

/**
 * Все запросы базы, содержащие фразу (phrase_fullsearch, 20 юнитов за строку), по убыванию объёма. Это и есть «карта спроса»:
 * семя «nehty» даёт все чешские запросы про ногти. Кэш не используется: выгрузка одноразовая, результат хранится в LocQuery.
 */
export async function fullSearch(phrase: string, database: string, limit = 300): Promise<KeywordMetrics[]> {
  // Шлюз принимает display_limit ≤ 100 — страницы по 100 через display_offset.
  const out: KeywordMetrics[] = [];
  for (let offset = 0; offset < limit; offset += 100) {
    const page = Math.min(100, limit - offset);
    try {
      const text = await withRetry(() => request({ type: "phrase_fullsearch", phrase, database, display_limit: String(page), display_offset: String(offset), display_sort: "nq_desc", export_columns: FULL_COLUMNS }));
      const rows = parseCsv(text);
      semrushUnits.spent += rows.length * 20;
      out.push(...rows);
      if (rows.length < page) break;
    } catch (e) {
      if (e instanceof SemrushError && e.nothingFound) break;
      throw e;
    }
  }
  return out;
}

/** Похожие ключи (phrase_related, 40 юнитов за строку) — только для лучших кандидатов, limit маленький. */
export async function relatedKeywords(phrase: string, database: string, limit = 10): Promise<KeywordMetrics[]> {
  try {
    const text = await withRetry(() => request({ type: "phrase_related", phrase, database, display_limit: String(limit), display_sort: "nq_desc", export_columns: "Ph,Nq,Cp,Co,Nr,Kd,Rr" }));
    const rows = parseCsv(text);
    semrushUnits.spent += rows.length * 40;
    return rows;
  } catch (e) {
    if (e instanceof SemrushError && e.nothingFound) return [];
    throw e;
  }
}
