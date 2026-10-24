/**
 * Поиск реальных фото для слотов инфо-статьи: DataForSEO (слот photo_dfs) с запасным SerpApi (photo_serp) проекта `blog`.
 * Чистые помощники (нормализация, tbs, домены, вердикты) — из поиска статей (src/lib/articles/photo/search.ts);
 * сами запросы идут через клиент этого сервиса (src/lib/blog/ai.ts), потому что ключи у проекта свои.
 */
import { dfsRequest, serpRequest, type AiCtx } from "@/lib/blog/ai";
import { acquire } from "@/lib/pins/ai/limiter";
import {
  buildTbs, dfsTaskVerdict, hostOf, IMAGE_SEARCH_CONCURRENCY, normalizeSearchConfig, sizeFilterAspect,
  type PhotoCandidateInput, type SearchCfg, type SearchResult,
} from "@/lib/articles/photo/search";
import type { BlogPhotoSearch } from "@/lib/blog/types";

export { buildSearchQuery, hostOf, isBlockedDomain, orientationVerdict, sizeVerdict, type PhotoCandidateInput, type SearchCfg, type SearchResult } from "@/lib/articles/photo/search";

/** Настройки поиска сценария → SearchCfg статей (общие фильтры размера/ориентации/доменов). orientation — на слот. */
export function searchCfgFor(ps: BlogPhotoSearch, orientation: "tall" | "square" | "any" | "wide"): SearchCfg {
  const orient = orientation === "any" ? ["any" as const] : orientation === "tall" ? ["tall" as const] : orientation === "square" ? ["square" as const] : ["wide" as const];
  return normalizeSearchConfig({
    source: ps.source,
    country: ps.country,
    language: ps.language,
    freshness: ps.freshness,
    imageType: ps.imageType,
    // «any» понимает normalizeSearchConfig (обнуляет остальные), хотя в типе сценария статей его нет
    orientation: orient as unknown as BlogPhotoSearch["orientation"],
    minWidth: ps.minSide,
    minHeight: ps.minSide,
    minScore: ps.minScore,
    candidatesTotal: ps.perSlot,
    includeDomains: [],
    excludeDomains: ps.excludeDomains,
    uniqueMode: ps.uniqueMode,
    writerMode: "description",
    captionMode: ps.captionMode,
    captionTemplate: ps.captionTemplate,
    querySuffix: "",
    license: "any",
  });
}

const NOT_CONFIGURED_STATUS = new Set([404, 409]);
const isTransientStatus = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;
const KEY_PROBLEM_RE = /run out of searches|out of credits|insufficient (?:funds|credits|balance)|not enough (?:funds|credits|balance)|payment required|invalid api key|unauthori[sz]ed|account (?:is )?(?:disabled|suspended|blocked)|исчерпал месячный лимит/i;

function httpKeyProblem(status: number, error: string): string | undefined {
  if (status === 401 || status === 402 || status === 403 || KEY_PROBLEM_RE.test(error)) return error.slice(0, 200) || `HTTP ${status}`;
  return undefined;
}

export async function searchSerpApi(ctx: AiCtx, query: string, cfg: SearchCfg, limit: number): Promise<SearchResult> {
  const items: PhotoCandidateInput[] = [];
  const tbs = buildTbs(cfg);
  let requests = 0;
  const release = await acquire("dfs", IMAGE_SEARCH_CONCURRENCY);
  try {
    for (let page = 0; page < 2 && items.length < limit; page++) {
      const params: Record<string, string | number> = { engine: "google_images", q: query, gl: cfg.country.toLowerCase(), hl: cfg.language, ijn: page };
      if (tbs) params.tbs = tbs;
      if (cfg.size_filter) {
        params.imgsz = "l";
        const aspect = sizeFilterAspect(cfg);
        if (aspect) params.imgar = aspect;
      }
      const res = await serpRequest(ctx, params, "photo_serp", 60_000);
      requests++;
      if (!res.ok) {
        if (NOT_CONFIGURED_STATUS.has(res.status) && requests === 1 && !res.data) return { items, error: `SerpApi не подключён: ${res.error || ""}`.trim(), requests: 0, notConfigured: true };
        const keyProblem = httpKeyProblem(res.status, String(res.error || ""));
        return { items, error: `SerpApi HTTP ${res.status}: ${String(res.error || "").slice(0, 200)}`, requests, transient: !keyProblem && isTransientStatus(res.status), keyProblem: keyProblem ? `SerpApi: ${keyProblem}` : undefined };
      }
      const json = res.data as { images_results?: Array<Record<string, unknown>> } | null;
      const results = json?.images_results || [];
      if (!results.length) break;
      for (const r of results) {
        const imageUrl = (r.original || r.thumbnail) as string | undefined;
        if (!imageUrl) continue;
        const link = (r.link as string) || null;
        items.push({
          source: "serpapi", searchQuery: query, url: String(imageUrl), thumbUrl: (r.thumbnail as string) || null,
          pageUrl: link || (r.source as string) || null, domain: hostOf(link) || (r.source ? String(r.source).toLowerCase() : null),
          title: (r.title as string) || null,
          width: typeof r.original_width === "number" ? r.original_width : null, height: typeof r.original_height === "number" ? r.original_height : null,
        });
        if (items.length >= limit) break;
      }
    }
    return { items, requests };
  } finally {
    release();
  }
}

const DFS_LOCATIONS: Record<string, number> = { US: 2840, GB: 2826, AU: 2036, CA: 2124, DE: 2276, FR: 2250, ES: 2724, IT: 2380, NL: 2528, PL: 2616, BR: 2076, IN: 2356, UA: 2804, RU: 2643 };
const DFS_IMAGES_ENDPOINT = "serp/google/images/live/advanced";

type DfsItem = { type?: string; url?: string; source_url?: string; image_url?: string; encoded_url?: string; alt?: string; title?: string; domain?: string };
type DfsBody = { tasks?: Array<{ status_code?: number; status_message?: string; result?: Array<{ items?: DfsItem[] }> }> };

export async function searchDataForSeo(ctx: AiCtx, query: string, cfg: SearchCfg, limit: number): Promise<SearchResult> {
  const tbs = buildTbs(cfg);
  const body = [{ keyword: query, location_code: DFS_LOCATIONS[cfg.country] || 2840, language_code: cfg.language.slice(0, 2), depth: Math.min(200, Math.max(100, limit)), ...(tbs ? { search_param: `tbs=${tbs}` } : {}) }];
  const release = await acquire("dfs", IMAGE_SEARCH_CONCURRENCY);
  try {
    const res = await dfsRequest(ctx, DFS_IMAGES_ENDPOINT, body, 130_000);
    if (!res.ok) {
      if (NOT_CONFIGURED_STATUS.has(res.status) && !res.data) return { items: [], error: `DataForSEO не подключён: ${res.error || ""}`.trim(), requests: 0, notConfigured: true };
      const keyProblem = httpKeyProblem(res.status, String(res.error || ""));
      return { items: [], error: `DataForSEO HTTP ${res.status}: ${String(res.error || "").slice(0, 200)}`, requests: 1, transient: !keyProblem && isTransientStatus(res.status), keyProblem: keyProblem ? `DataForSEO: ${keyProblem}` : undefined };
    }
    const json = (res.data || {}) as DfsBody;
    const task = json.tasks?.[0];
    const rawItems = task?.result?.[0]?.items || [];
    const items: PhotoCandidateInput[] = [];
    for (const r of rawItems) {
      const fileUrl = r.source_url || r.image_url || null;
      if (r.type !== "images_search" && !fileUrl) continue;
      if (!fileUrl || !String(fileUrl).startsWith("http")) continue;
      const pageUrl = r.url && String(r.url).startsWith("http") ? String(r.url) : null;
      items.push({ source: "dataforseo", searchQuery: query, url: String(fileUrl), thumbUrl: r.encoded_url || null, pageUrl, domain: hostOf(pageUrl) || (r.domain ? String(r.domain).toLowerCase() : null) || hostOf(fileUrl), title: r.title || r.alt || null, width: null, height: null });
      if (items.length >= limit) break;
    }
    const rootCode = Number((json as { status_code?: number }).status_code) || 0;
    const code = Number(task?.status_code) >= 40000 ? Number(task?.status_code) : rootCode >= 40000 ? rootCode : 0;
    const message = String(task?.status_message || (json as { status_message?: string }).status_message || "task error");
    const verdict = dfsTaskVerdict(code);
    if (verdict === "ok" || verdict === "empty" || items.length) return { items, requests: 1, error: verdict === "ok" || verdict === "empty" ? undefined : `DataForSEO ${code}: ${message}` };
    const taskErr = `DataForSEO ${code}: ${message}`;
    return { items, requests: 1, error: taskErr, transient: verdict === "transient", keyProblem: verdict === "key" ? taskErr : undefined };
  } finally {
    release();
  }
}

/** Поиск с фолбэком: source ≠ dataforseo → SerpApi, иначе DataForSEO; при сбое — другой провайдер. */
export async function searchImagesWithFallback(ctx: AiCtx, query: string, cfg: SearchCfg, limit: number): Promise<SearchResult & { engine: string }> {
  const errors: string[] = [];
  let requests = 0;
  let notConfigured = 0;
  let transient = false;
  let keyProblem: string | undefined;

  if (cfg.source !== "dataforseo") {
    const r = await searchSerpApi(ctx, query, cfg, limit);
    requests += r.requests;
    if (r.items.length) return { ...r, engine: "serpapi", requests };
    if (r.notConfigured) notConfigured++;
    transient ||= !!r.transient;
    keyProblem ||= r.keyProblem;
    errors.push(r.error || "SerpApi: 0 результатов");
  }
  const d = await searchDataForSeo(ctx, query, cfg, limit);
  requests += d.requests;
  if (d.items.length) return { items: d.items, error: errors.length ? `фолбэк DataForSEO (${errors.join("; ")})` : d.error, requests, engine: "dataforseo" };
  if (d.notConfigured) notConfigured++;
  transient ||= !!d.transient;
  keyProblem ||= d.keyProblem;
  if (d.error) errors.push(d.error);
  const dfsFailed = !!d.transient || !!d.notConfigured || !!d.keyProblem;
  if (cfg.source === "dataforseo" && dfsFailed) {
    const r = await searchSerpApi(ctx, query, cfg, Math.min(limit, 100));
    requests += r.requests;
    if (r.items.length) return { items: r.items, error: `фолбэк SerpApi (${errors.join("; ")})`, requests, engine: "serpapi" };
    if (r.notConfigured) notConfigured++;
    transient ||= !!r.transient;
    keyProblem ||= r.keyProblem;
    if (r.error) errors.push(r.error);
  }
  return { items: [], error: errors.length ? errors.join("; ") : undefined, requests, engine: "none", notConfigured: notConfigured >= 2, transient, keyProblem };
}
