/**
 * Semrush SEO API (формат v3) через шлюз Group by SEO: https://api-semrush.groupbuyseo.org/?key=…&type=…
 * Ключ владельца — GROUPBYSEO_API_KEY в .env (в репозиторий не попадает). Баланс — юниты (100 000 на 17.11.2026):
 * phrase_these 10 юнитов за строку, phrase_related 40 за строку, phrase_kdi 50 — поэтому KD берём колонкой Kd
 * в обзоре, а related только для лучших кандидатов и с малым display_limit.
 * Ответ — CSV с «;», первая строка — заголовки; ошибки — текстом «ERROR N :: …» (503 = у шлюза лежит апстрим).
 */

const BASE = process.env.GROUPBYSEO_SEMRUSH_URL || "https://api-semrush.groupbuyseo.org/";

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
};

/** Колонки Semrush → поля. Остальные колонки игнорируются. */
const COL: Record<string, keyof KeywordMetrics> = { Keyword: "phrase", "Search Volume": "volume", "Keyword Difficulty": "kd", CPC: "cpc", Competition: "competition", "Number of Results": "results", "Related Relevance": "relevance" };

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
  const uniq = [...new Set(phrases.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    const batch = uniq.slice(i, i + 100);
    try {
      const text = await withRetry(() => request({ type: "phrase_these", phrase: batch.join(";"), database, export_columns: "Ph,Nq,Cp,Co,Nr,Kd" }));
      const rows = parseCsv(text);
      semrushUnits.spent += rows.length * 10;
      for (const r of rows) out.set(r.phrase.toLowerCase(), r);
    } catch (e) {
      if (e instanceof SemrushError && e.nothingFound) continue;
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
