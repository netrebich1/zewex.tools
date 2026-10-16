/**
 * Google TOP-10 по брендам для анализа приставок и зон конкурентов.
 * Основной источник — DataForSEO (слот serp_dfs), запасной — SerpAPI (слот serp_api):
 * если DataForSEO не подключён или запрос не прошёл, тот же запрос уходит в SerpAPI.
 * Все вызовы идут через прокси портала (правила, ключи, журнал расхода).
 */
import { resolveSlot, runSlot, type ResolvedSlot } from "@/lib/run";
import { getCountry, LIMITS, PROJECT_SLUG, SLOT_SERP_API, SLOT_SERP_DFS, type SerpSnapshot } from "./types";
import { domainHasBrand, mineSuffixes } from "./mining";

export type SerpCtx = { userId: string; teamId?: string | null; refId?: string };

type QueryResult = { ok: true; domains: string[]; provider: "dataforseo" | "serpapi" } | { ok: false; error: string };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function viaDataForSeo(ctx: SerpCtx, pre: ResolvedSlot, keyword: string, countryCode: string): Promise<QueryResult> {
  const country = getCountry(countryCode);
  if (!country) return { ok: false, error: `Для страны «${countryCode}» не настроен код DataForSEO` };
  const res = await runSlot({
    userId: ctx.userId,
    projectSlug: PROJECT_SLUG,
    slotKey: SLOT_SERP_DFS,
    payload: { endpoint: "serp/google/organic/live/advanced", body: [{ keyword, location_code: country.locationCode, language_code: country.languageCode, depth: 10 }] },
    timeoutMs: 90_000,
    meta: { teamId: ctx.teamId ?? undefined, refId: ctx.refId },
    pre,
  });
  if (!res.ok) return { ok: false, error: res.error ?? `DataForSEO: HTTP ${res.status}` };
  const data = res.data as { tasks?: Array<{ status_code?: number; status_message?: string; result?: Array<{ items?: Array<{ type?: string; domain?: string; url?: string; rank_group?: number }> }> }> };
  const task = data.tasks?.[0];
  if (!task || (task.status_code && task.status_code !== 20000)) return { ok: false, error: task?.status_message ?? "DataForSEO: пустой ответ" };
  const items = task.result?.[0]?.items ?? [];
  const domains: string[] = [];
  for (const it of items) {
    if (it.type !== "organic") continue;
    const host = (it.domain ?? hostOf(it.url ?? "")).toLowerCase().replace(/^www\./, "");
    if (host && !domains.includes(host)) domains.push(host);
    if (domains.length >= 10) break;
  }
  return { ok: true, domains, provider: "dataforseo" };
}

async function viaSerpApi(ctx: SerpCtx, pre: ResolvedSlot, keyword: string, countryCode: string): Promise<QueryResult> {
  const country = getCountry(countryCode);
  const res = await runSlot({
    userId: ctx.userId,
    projectSlug: PROJECT_SLUG,
    slotKey: SLOT_SERP_API,
    payload: { engine: "google", q: keyword, gl: countryCode, hl: country?.languageCode ?? "en", num: 10 },
    timeoutMs: 60_000,
    meta: { teamId: ctx.teamId ?? undefined, refId: ctx.refId },
    pre,
  });
  if (!res.ok) return { ok: false, error: res.error ?? `SerpAPI: HTTP ${res.status}` };
  const data = res.data as { organic_results?: Array<{ link?: string }> };
  const domains: string[] = [];
  for (const it of data.organic_results ?? []) {
    const host = hostOf(it.link ?? "");
    if (host && !domains.includes(host)) domains.push(host);
    if (domains.length >= 10) break;
  }
  return { ok: true, domains, provider: "serpapi" };
}

export type Top10Result = {
  ok: boolean;
  error: string | null;
  /** Запрос → домены TOP-10 (все, до фильтра по бренду) */
  byQuery: Record<string, string[]>;
  provider: "dataforseo" | "serpapi" | null;
  /** Запросы, которые не удалось снять ни одним источником */
  failed: Array<{ query: string; error: string }>;
};

/** Снимает TOP-10 по списку запросов; по каждому запросу сначала DataForSEO, при сбое — SerpAPI. */
export async function fetchTop10(ctx: SerpCtx, queries: string[], countryCode: string): Promise<Top10Result> {
  const dfs = await resolveSlot(ctx.userId, PROJECT_SLUG, SLOT_SERP_DFS);
  const serp = await resolveSlot(ctx.userId, PROJECT_SLUG, SLOT_SERP_API);
  if (!dfs.ok && !serp.ok) {
    return { ok: false, error: "Не подключён ни DataForSEO, ни SerpAPI: откройте страницу ключа и отметьте сервис «Подбор доменов».", byQuery: {}, provider: null, failed: [] };
  }
  const byQuery: Record<string, string[]> = {};
  const failed: Array<{ query: string; error: string }> = [];
  let provider: Top10Result["provider"] = null;
  const list = Array.from(new Set(queries.map((q) => q.trim().toLowerCase()).filter(Boolean))).slice(0, LIMITS.serpQueries);
  // По 3 запроса одновременно: быстрее для 25 брендов, но без шторма на ключ.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, list.length) }, async () => {
    while (cursor < list.length) {
      const q = list[cursor++]!;
      let r: QueryResult | null = null;
      if (dfs.ok) r = await viaDataForSeo(ctx, dfs.value, q, countryCode);
      if ((!r || !r.ok) && serp.ok) {
        const r2 = await viaSerpApi(ctx, serp.value, q, countryCode);
        if (r2.ok || !r) r = r2;
      }
      if (r && r.ok) {
        byQuery[q] = r.domains;
        provider = provider ?? r.provider;
      } else failed.push({ query: q, error: r && !r.ok ? r.error : "нет источника" });
    }
  });
  await Promise.all(workers);
  const anyOk = Object.keys(byQuery).length > 0;
  return { ok: anyOk, error: anyOk ? null : failed[0]?.error ?? "Выдача не получена", byQuery, provider, failed };
}

export type SerpAnalysis = { snapshot: SerpSnapshot; suffixes: ReturnType<typeof mineSuffixes>; failed: Top10Result["failed"]; allDomains: string[] };

/** Полный анализ: TOP-10 по брендам (или по ключу), фильтр «только домены с брендом», приставки конкурентов (топ-30). */
export async function analyzeSerp(ctx: SerpCtx, input: { brands: string[]; countryCode: string; keyword?: string }): Promise<{ ok: true; value: SerpAnalysis } | { ok: false; error: string }> {
  const queries = input.keyword?.trim() ? [input.keyword.trim()] : input.brands;
  const top = await fetchTop10(ctx, queries, input.countryCode);
  if (!top.ok) return { ok: false, error: top.error ?? "Выдача не получена" };
  const all = new Set<string>();
  for (const list of Object.values(top.byQuery)) for (const d of list) all.add(d);
  const domains = Array.from(all).filter((d) => domainHasBrand(d, input.brands));
  const byQuery: Record<string, string[]> = {};
  for (const [q, list] of Object.entries(top.byQuery)) byQuery[q] = list.filter((d) => domainHasBrand(d, input.brands));
  const snapshot: SerpSnapshot = {
    provider: top.provider ?? "dataforseo",
    countryCode: input.countryCode,
    keyword: input.keyword?.trim() || null,
    byQuery,
    domains,
    fetchedAt: new Date().toISOString(),
  };
  return { ok: true, value: { snapshot, suffixes: mineSuffixes(domains, input.brands).slice(0, 30), failed: top.failed, allDomains: Array.from(all) } };
}
