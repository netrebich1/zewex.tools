/**
 * Поиск реальных фото: нормализация настроек, построение запросов, провайдеры (DataForSEO, SerpApi — через слоты
 * портала `photo_dfs` / `photo_serp`), фильтры доменов. Порт оригинала _shared/photoSearch.ts.
 * Исправление 08-plan §3 п.6: у DataForSEO `pageUrl` = поле `url` (страница), `sourceUrl`/`url` кандидата = `source_url`
 * (файл), домен — от страницы; gstatic-превью (`encoded_url`) → `thumbUrl`.
 * Лимит одновременных обращений — семафор в процессе (`acquire("dfs", 6)`), вместо service_leases оригинала.
 */
import { dfsRequest, serpRequest, type AiCtx } from "@/lib/articles/ai";
import type { PhotoSearchConfig } from "@/lib/articles/types";
import { acquire } from "@/lib/pins/ai/limiter";

/** Нормализованная конфигурация поиска (форма оригинала photoSearch.ts:8-44). */
export interface SearchCfg {
  source: "serpapi" | "dataforseo" | "both";
  candidates_total: number;
  orientation: Array<"any" | "tall" | "wide" | "square">;
  min_width: number;
  min_height: number;
  min_score: number;
  license: "any" | "commercial";
  image_type: "any" | "photo";
  freshness: "any" | "y" | "m" | "w";
  country: string;
  language: string;
  include_domains: string[];
  include_urls: string[];
  exclude_domains: string[];
  query_suffix: string;
  unique_mode: "soft" | "strict" | "off";
  /** Фильтр размера/ориентации в самом поиске (PhotoSearchConfig.searchSizeFilter; по умолчанию выключен). */
  size_filter: boolean;
}

// оригинал: photoSearch.ts:46
export const MIN_PHOTO_SIDE = 550;
/** Одновременных обращений к поиску картинок (оригинал: serviceSlots.ts SERVICE_LIMITS.image_search = 6). */
export const IMAGE_SEARCH_CONCURRENCY = 6;

/** Домен для оператора site:. Полный URL превращаем в чистый хост (photoSearch.ts:77-83). */
export function sanitizeDomain(raw: string): string {
  let d = String(raw || "").trim().toLowerCase();
  if (!d) return "";
  d = d.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  d = d.split(/[/?#]/)[0].split(":")[0].replace(/\.+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : "";
}

/** Список «искать только здесь» делим на домены и полные ссылки на посты (photoSearch.ts:91-105). */
export function splitIncludes(entries: string[]): { include_domains: string[]; include_urls: string[] } {
  const domains = new Set<string>();
  const urls: string[] = [];
  for (const entry of entries) {
    const host = sanitizeDomain(entry);
    if (!host) continue;
    domains.add(host);
    const cleaned = String(entry).trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
    const slash = cleaned.indexOf("/");
    if (slash > 0 && cleaned.length - slash > 3) urls.push(`https://${cleaned}/`);
  }
  return { include_domains: [...domains], include_urls: [...new Set(urls)] };
}

// оригинал: photoSearch.ts:108-116
const VALID_COUNTRIES = new Set(["US", "GB", "AU", "CA", "IE", "NZ", "DE", "FR", "ES", "IT", "NL", "BE", "AT", "CH", "SE", "NO", "DK", "FI", "PL", "CZ", "PT", "GR", "HU", "RO", "BG", "HR", "SK", "SI", "EE", "LV", "LT", "TR", "UA", "RU", "BR", "MX", "AR", "CL", "CO", "PE", "IN", "ID", "JP", "KR", "CN", "TW", "HK", "SG", "MY", "TH", "VN", "PH", "AE", "SA", "IL", "EG", "ZA", "NG", "KE", "MA"]);
const COUNTRY_ALIASES: Record<string, string> = { EN: "US", UK: "GB", EU: "US", GLOBAL: "US", WORLD: "US", "": "US" };

/** Невалидное гео (например язык «EN» в колонке Geo) не должно ломать поиск. */
export function normalizeCountry(raw: unknown, fallback = "US"): string {
  const cc = String(raw || "").trim().toUpperCase().slice(0, 2);
  if (VALID_COUNTRIES.has(cc)) return cc;
  return COUNTRY_ALIASES[cc] || fallback;
}

/**
 * Нормализация настроек поиска из снимка сценария (recipe.photoSearch уже содержит итог переопределений сайта/запуска).
 * Правила оригинала normalizePhotoConfig (photoSearch.ts:118-160): минимум стороны 550, candidates_total ≥ 40,
 * ≤2 ориентации («any» обнуляет остальные), include-список делится на домены и ссылки на посты.
 */
export function normalizeSearchConfig(raw: Partial<PhotoSearchConfig> | null | undefined): SearchCfg {
  const c = raw || {};
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : String(v || "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const valid = ["any", "tall", "wide", "square"];
  const rawOr = Array.isArray(c.orientation) ? c.orientation : c.orientation ? [c.orientation] : [];
  let orientation = rawOr.map(String).filter((v): v is SearchCfg["orientation"][number] => valid.includes(v));
  if (orientation.includes("any")) orientation = ["any"];
  else orientation = [...new Set(orientation)].slice(0, 2);
  if (!orientation.length) orientation = ["tall", "square"];
  const source = String(c.source || "dataforseo");
  const fresh = String(c.freshness || "any");
  return {
    source: (["serpapi", "dataforseo", "both"].includes(source) ? source : "dataforseo") as SearchCfg["source"],
    candidates_total: Math.max(40, num(c.candidatesTotal, 100)),
    orientation,
    min_width: Math.max(MIN_PHOTO_SIDE, num(c.minWidth, MIN_PHOTO_SIDE)),
    min_height: Math.max(MIN_PHOTO_SIDE, num(c.minHeight, MIN_PHOTO_SIDE)),
    min_score: num(c.minScore, 7),
    license: c.license === "commercial" ? "commercial" : "any",
    image_type: c.imageType === "any" ? "any" : "photo",
    freshness: (["any", "y", "m", "w"].includes(fresh) ? fresh : "any") as SearchCfg["freshness"],
    country: normalizeCountry(c.country, "US"),
    language: String(c.language || "en").toLowerCase().slice(0, 5),
    ...splitIncludes(list(c.includeDomains)),
    exclude_domains: list(c.excludeDomains).map(sanitizeDomain).filter(Boolean),
    query_suffix: String(c.querySuffix || ""),
    unique_mode: (["soft", "strict", "off"].includes(String(c.uniqueMode)) ? c.uniqueMode : "soft") as SearchCfg["unique_mode"],
    size_filter: c.searchSizeFilter === true,
  };
}

/** Итоговый поисковый запрос с site:/минус-доменами и суффиксом (photoSearch.ts:189-199). Год убирается всегда. */
export function buildSearchQuery(keyword: string, cfg: SearchCfg): string {
  const noYear = keyword.replace(/\b(19|20)\d{2}\b/g, " ").replace(/\s+/g, " ").trim() || keyword.trim();
  const parts = [noYear];
  if (cfg.query_suffix.trim()) parts.push(cfg.query_suffix.trim());
  if (cfg.include_domains.length === 1) parts.push(`site:${cfg.include_domains[0]}`);
  else if (cfg.include_domains.length > 1) parts.push(`(${cfg.include_domains.map((d) => `site:${d}`).join(" OR ")})`);
  for (const d of cfg.exclude_domains) parts.push(`-site:${d}`);
  return parts.join(" ");
}

/** Размер кадра: единственный порог — короткая сторона (минимум 550 px) (photoSearch.ts:206-211). */
export function sizeVerdict(width: number, height: number, cfg: SearchCfg): string | null {
  const short = Math.min(width, height);
  const need = Math.min(cfg.min_width, cfg.min_height);
  if (short < need) return `мелкое (${width}×${height})`;
  return null;
}

/** Ориентация: почти квадратные кадры считаем вертикальными (до 1.05) (photoSearch.ts:214-225). */
export function orientationVerdict(width: number, height: number, cfg: SearchCfg): string | null {
  if (!width || !height) return null;
  if (cfg.orientation.includes("any")) return null;
  const ratio = width / height;
  const matches = cfg.orientation.some((o) => {
    if (o === "tall") return ratio <= 1.05;
    if (o === "wide") return ratio >= 0.95;
    if (o === "square") return ratio >= 0.7 && ratio <= 1.4;
    return false;
  });
  return matches ? null : "ориентация не соответствует выбранным типам";
}

/**
 * Ориентация для фильтра поисковика при включённом size_filter: сценарий обычно разрешает «tall + square», и раньше
 * при двух ориентациях фильтр не передавался вовсе. Теперь просим вертикальные, если вертикаль разрешена (квадрат
 * наш фильтр по-прежнему принимает — он просто реже попадётся в выдаче); только квадрат → iar:s; только широкие → iar:w.
 */
export function sizeFilterAspect(cfg: SearchCfg): "t" | "s" | "w" | null {
  if (cfg.orientation.includes("any")) return null;
  if (cfg.orientation.includes("tall")) return "t";
  if (cfg.orientation.includes("wide")) return "w";
  if (cfg.orientation.includes("square")) return "s";
  return null;
}

/**
 * tbs-фильтры Google Images (photoSearch.ts:237-250): одна ориентация, тип photo, лицензия, свежесть; размер не передаётся.
 * С size_filter (cost-fixes-b): `isz:l` (крупные, у Google это ≥ ~1024 px по стороне) и ориентация по sizeFilterAspect.
 */
export function buildTbs(cfg: SearchCfg): string {
  const tbs: string[] = [];
  const aspect = cfg.size_filter ? sizeFilterAspect(cfg) : null;
  if (cfg.size_filter) tbs.push("isz:l");
  if (aspect) tbs.push(`iar:${aspect}`);
  else if (cfg.orientation.length === 1 && cfg.orientation[0] === "tall") tbs.push("iar:t");
  else if (cfg.orientation.length === 1 && cfg.orientation[0] === "wide") tbs.push("iar:w");
  else if (cfg.orientation.length === 1 && cfg.orientation[0] === "square") tbs.push("iar:s");
  if (cfg.image_type === "photo") tbs.push("itp:photo");
  if (cfg.license === "commercial") tbs.push("sur:fmc");
  if (cfg.freshness !== "any") tbs.push(`qdr:${cfg.freshness}`);
  return tbs.join(",");
}

/** Найденный кандидат (до записи в ArtPhotoCandidate). */
export interface PhotoCandidateInput {
  source: string;
  searchQuery: string;
  /** URL файла картинки */
  url: string;
  thumbUrl: string | null;
  /** Страница, где размещено фото, и её домен */
  pageUrl: string | null;
  domain: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
}

export function hostOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Составные зоны, где «корень» домена состоит из трёх частей (shein.co.uk). */
const MULTI_TLD = new Set(["co.uk", "com.au", "co.nz", "com.br", "co.jp", "co.in", "com.mx", "co.za", "com.tr", "com.ua", "com.pl", "com.sg", "com.hk", "co.kr", "com.ar", "com.co"]);

/** Корень домена без поддоменов и с учётом составных зон. */
export function rootDomain(host?: string | null): string | null {
  const h = (host || "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!h || !h.includes(".")) return h || null;
  const parts = h.split(".");
  const last2 = parts.slice(-2).join(".");
  if (MULTI_TLD.has(last2) && parts.length >= 3) return parts.slice(-3).join(".");
  return last2;
}

/** Категории источников, которые никогда не годятся для статьи (photoSearch.ts:290-310). */
export const BLOCKED_ROOTS = new Set<string>([
  // магазины и маркетплейсы
  "amazon.com", "amazon.co.uk", "amazon.de", "ebay.com", "etsy.com", "aliexpress.com",
  "alibaba.com", "shein.com", "shein.co.uk", "temu.com", "wish.com", "walmart.com",
  "target.com", "ulta.com", "sephora.com", "boots.com", "asos.com", "shopee.com",
  "lazada.com", "flipkart.com", "wayfair.com", "overstock.com", "dhgate.com",
  "nykaa.com", "myntra.com", "ajio.com", "zalando.com", "bol.com", "otto.de",
  "mercadolibre.com", "rakuten.com", "taobao.com", "tmall.com", "jd.com",
  "shopping.yahoo.com", "shopping.google.com", "google.com",
  // форумы, соцсети и пин-борды
  "reddit.com", "quora.com", "pinterest.com", "pinimg.com", "facebook.com",
  "twitter.com", "x.com", "tumblr.com", "vk.com", "weheartit.com", "flipboard.com",
  "tiktok.com", "youtube.com", "linkedin.com", "threads.net",
  // фотостоки и клипарт
  "shutterstock.com", "istockphoto.com", "gettyimages.com", "dreamstime.com",
  "alamy.com", "depositphotos.com", "123rf.com", "adobe.com", "stock.adobe.com",
  "vecteezy.com", "freepik.com", "pngtree.com", "canva.com", "vectorstock.com",
  "bigstockphoto.com", "unsplash.com", "pexels.com", "pixabay.com",
  // низкокачественные / спамные блоги
  "sewmamasew.com",
]);

/** Поддомены и части адреса, выдающие магазин/корзину/каталог. */
const BLOCKED_HOST_HINTS = ["shop.", "store.", "shopping.", "cart.", "checkout.", "market.", "marketplace.", "forum.", "forums.", "community."];

/** Домен запрещён? Возвращает совпавший корень/подсказку или null (photoSearch.ts:322-334). */
export function isBlockedDomain(host?: string | null, excludeList: string[] = []): string | null {
  const h = (host || "").trim().toLowerCase().replace(/^www\./, "");
  if (!h) return null;
  const root = rootDomain(h);
  for (const raw of excludeList) {
    const ex = String(raw || "").trim().toLowerCase().replace(/^www\./, "");
    if (!ex) continue;
    if (h === ex || h.endsWith(`.${ex}`) || root === ex || root === rootDomain(ex)) return ex;
  }
  if (root && BLOCKED_ROOTS.has(root)) return root;
  for (const hint of BLOCKED_HOST_HINTS) if (h.startsWith(hint)) return hint.replace(".", "");
  return null;
}

/** Соседние регионы для добора «другое гео» (photoSearch.ts:351-372). */
export const GEO_FALLBACKS: Record<string, string[]> = {
  US: ["GB", "AU", "CA"], GB: ["US", "AU", "IE"], AU: ["GB", "US", "NZ"], CA: ["US", "GB", "AU"],
  IE: ["GB", "US", "AU"], NZ: ["AU", "GB", "US"], ES: ["MX", "US", "AR"], MX: ["ES", "US", "AR"],
  AR: ["ES", "MX", "US"], DE: ["AT", "CH", "US"], AT: ["DE", "CH", "US"], CH: ["DE", "AT", "FR"],
  FR: ["BE", "CA", "US"], BE: ["FR", "NL", "US"], NL: ["BE", "DE", "US"], IT: ["CH", "US", "GB"],
  PL: ["DE", "GB", "US"], BR: ["PT", "US", "ES"], PT: ["BR", "ES", "GB"], IN: ["GB", "US", "AU"],
};

/** Первый соседний регион, который ещё не использовался в этой статье. */
export function nextGeo(primary: string, usedGeos: string[] = []): string | null {
  const main = String(primary || "US").toUpperCase().slice(0, 2);
  const used = new Set([main, ...usedGeos.map((g) => String(g).toUpperCase())]);
  const list = GEO_FALLBACKS[main] || ["US", "GB"];
  for (const cc of list) if (!used.has(cc)) return cc;
  return null;
}

export function normalizeKeyword(kw?: string | null): string {
  return String(kw || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export type SearchResult = {
  items: PhotoCandidateInput[];
  error?: string;
  requests: number;
  /** Провайдер не подключён в портале (нет правила слота / ключа) */
  notConfigured?: boolean;
  /** Сетевая/серверная ошибка провайдера — имеет смысл повторить позже */
  transient?: boolean;
  /** Ключ провайдера не работает: нет средств, отклонён, исчерпан лимит — статья ждёт ключ, а не повторяет каждые 90 с */
  keyProblem?: string;
};

const NOT_CONFIGURED_STATUS = new Set([404, 409]);
const isTransientStatus = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;
/** Ответы провайдеров поиска «нет денег / ключ отклонён» (SerpApi отдаёт «run out of searches» с HTTP 429). */
const KEY_PROBLEM_RE = /run out of searches|out of credits|insufficient (?:funds|credits|balance)|not enough (?:funds|credits|balance)|payment required|invalid api key|unauthori[sz]ed|account (?:is )?(?:disabled|suspended|blocked)|исчерпал месячный лимит/i;

function httpKeyProblem(status: number, error: string): string | undefined {
  if (status === 401 || status === 402 || status === 403 || KEY_PROBLEM_RE.test(error)) return error.slice(0, 200) || `HTTP ${status}`;
  return undefined;
}

/**
 * Код задачи DataForSEO (status_code в tasks[0] или в корне ответа):
 *  20000 — ок; 40102 — «нет результатов» (не ошибка); 40100/40104 — доступ, 40200/40210 — оплата → ключ;
 *  40101 — «Internal SE Server Error» (сбой поисковика у DataForSEO, zorvianix 2026-10-15) → повтор, а не «нет средств»;
 *  40202/40209 — лимит частоты, 50000+ — сбой у них → повтор; остальные 4xxxx — ошибка запроса, повтор не поможет.
 */
export function dfsTaskVerdict(code: number): "ok" | "empty" | "key" | "transient" | "permanent" {
  if (!code || code < 40000) return "ok";
  if (code === 40102) return "empty";
  if (code === 40100 || code === 40104 || code === 40200 || code === 40210) return "key";
  if (code === 40101 || code === 40202 || code === 40209 || code >= 50000) return "transient";
  return "permanent";
}

/** SerpApi Google Images, пагинация по ijn: до 3 страниц по 100 (photoSearch.ts:386-438). */
export async function searchSerpApi(ctx: AiCtx, query: string, cfg: SearchCfg, limit: number): Promise<SearchResult> {
  const items: PhotoCandidateInput[] = [];
  const tbs = buildTbs(cfg);
  let requests = 0;
  const release = await acquire("dfs", IMAGE_SEARCH_CONCURRENCY);
  try {
    for (let page = 0; page < 3 && items.length < limit; page++) {
      const params: Record<string, string | number> = { engine: "google_images", q: query, gl: cfg.country.toLowerCase(), hl: cfg.language, ijn: page };
      if (tbs) params.tbs = tbs;
      // У SerpApi есть и отдельные параметры размера/ориентации (imgsz=l, imgar=t|s|w) — дублируем tbs ими.
      if (cfg.size_filter) {
        params.imgsz = "l";
        const aspect = sizeFilterAspect(cfg);
        if (aspect) params.imgar = aspect;
      }
      const res = await serpRequest(ctx, params, 60_000);
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
          source: "serpapi",
          searchQuery: query,
          url: String(imageUrl),
          thumbUrl: (r.thumbnail as string) || null,
          pageUrl: link || (r.source as string) || null,
          domain: hostOf(link) || (r.source ? String(r.source).toLowerCase() : null),
          title: (r.title as string) || null,
          width: typeof r.original_width === "number" ? r.original_width : null,
          height: typeof r.original_height === "number" ? r.original_height : null,
        });
        if (items.length >= limit) break;
      }
    }
    return { items, requests };
  } finally {
    release();
  }
}

// оригинал: photoSearch.ts:502-505 (остальные страны → US)
const DFS_LOCATIONS: Record<string, number> = { US: 2840, GB: 2826, AU: 2036, CA: 2124, DE: 2276, FR: 2250, ES: 2724, IT: 2380, NL: 2528, PL: 2616, BR: 2076, IN: 2356, UA: 2804, RU: 2643 };
export const DFS_IMAGES_ENDPOINT = "serp/google/images/live/advanced";

type DfsItem = { type?: string; url?: string; source_url?: string; image_url?: string; encoded_url?: string; alt?: string; title?: string; domain?: string };
type DfsBody = { tasks?: Array<{ status_code?: number; status_message?: string; cost?: number; result?: Array<{ items?: DfsItem[] }> }> };

/**
 * DataForSEO SERP Google Images (live advanced) — один POST, depth ≤ 200 (максимум API; оригинал допускал 700).
 * Стоимость запроса учитывает портал (UsageLog через runSlot).
 */
export async function searchDataForSeo(ctx: AiCtx, query: string, cfg: SearchCfg, limit: number): Promise<SearchResult> {
  const tbs = buildTbs(cfg);
  const body = [{
    keyword: query,
    location_code: DFS_LOCATIONS[cfg.country] || 2840,
    language_code: cfg.language.slice(0, 2),
    depth: Math.min(200, Math.max(100, limit)),
    ...(tbs ? { search_param: `tbs=${tbs}` } : {}),
  }];
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
      // 08-plan §3 п.6: source_url — файл, url — страница, encoded_url — кеш Google (превью)
      const fileUrl = r.source_url || r.image_url || null;
      if (r.type !== "images_search" && !fileUrl) continue;
      if (!fileUrl || !String(fileUrl).startsWith("http")) continue;
      const pageUrl = r.url && String(r.url).startsWith("http") ? String(r.url) : null;
      items.push({
        source: "dataforseo",
        searchQuery: query,
        url: String(fileUrl),
        thumbUrl: r.encoded_url || null,
        pageUrl,
        domain: hostOf(pageUrl) || (r.domain ? String(r.domain).toLowerCase() : null) || hostOf(fileUrl),
        title: r.title || r.alt || null,
        width: null,
        height: null,
      });
      if (items.length >= limit) break;
    }
    // Раньше любой код ≥ 40000 при пустой выдаче считался временным, и поиск повторялся каждые 90 с бесконечно
    // (аудит 2026-10-14 stability §2.2): «нет результатов», ошибка запроса и «нет оплаты» так не лечатся.
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

/**
 * Поиск с фолбэком (photoSearch.ts:637-675): source ≠ dataforseo → SerpApi, пусто/ошибка → DataForSEO;
 * source = dataforseo → DataForSEO, пусто → SerpApi. `notConfigured` = оба провайдера не подключены.
 */
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

  // Запасной SerpApi (заметно дороже DataForSEO, владелец 2026-10-16): только при сбое DataForSEO (временная ошибка,
  // нет ключа/денег), а не когда по запросу просто нет картинок; одна страница (≤100) вместо трёх.
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
  return {
    items: [],
    error: errors.length ? errors.join("; ") : undefined,
    requests,
    engine: "none",
    notConfigured: notConfigured >= 2,
    transient,
    keyProblem,
  };
}
