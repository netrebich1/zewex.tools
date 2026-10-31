/**
 * Объём и число фото — для каждой статьи свои (владелец 31.10: «для какой-то статьи надо мало, для какой-то больше»).
 * Этап `scenario` после выбора формата: топ Google (снимок DataForSEO Labs, запасной путь — живая выдача; слот photo_dfs) → 3–5 статей конкурентов
 * (без соцсетей, магазинов, форумов, видео) → медиана слов. Цель = медиана +15 %, в рамках формата; без выдачи — рамки
 * формата (списки — по числу пунктов). Фото — по формату, числу пунктов и «визуальности» темы, не больше ~1 на 220 слов.
 * Объём или фото, заданные в форме запуска, не трогаются (run.fixedLength / run.fixedImages).
 */
import { safeFetch } from "@/lib/pins/fetch";
import { dfsRequest, type AiCtx } from "./ai";
import { isVisualTopic, type Scenario } from "./scenarios";
import type { BlogRecipeParams } from "./types";

export type BlogSizing = {
  /** Цель по словам и итоговые пределы для плана */
  words: number;
  length: { min: number; max: number };
  images: { min: number; max: number };
  /** Медиана слов у конкурентов (null — выдача не получена или мало статей) */
  median: number | null;
  pages: Array<{ url: string; words: number }>;
  query: string;
  reason: string;
  fixed: { length: boolean; images: boolean };
  costUsd: number;
  error?: string;
};

const SKIP_HOST = /(^|\.)(pinterest|youtube|youtu|reddit|quora|amazon|walmart|etsy|target|tiktok|instagram|facebook|twitter|x|wikipedia|ebay|sephora|ulta|costco|homedepot|lowes|bestbuy|ikea|wayfair|google)\.[a-z.]+$/i;
const PAGES = 5;
const MIN_PAGES = 3;
const PAGE_WORDS = [300, 9000] as const;

const countWords = (html: string) => (html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length;

/**
 * Слова статьи: только абзацы, подзаголовки и пункты списков (от 4 слов — не меню и не «похожие записи»)
 * внутри <article> → <main> → body, без шапки, подвала, боковых колонок, форм и комментариев.
 */
export function articleWords(html: string): number {
  const clean = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template|figure)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const main = clean.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? clean.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? clean;
  const body = main.split(/<(?:div|section|ol)\b[^>]*(?:id|class)="[^"]*\b(?:comments?|related|respond|share|newsletter)\b[^"]*"/i)[0];
  let words = 0;
  for (const m of body.matchAll(/<(p|h[1-4]|li|td|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const w = countWords(m[2]);
    if (m[1].toLowerCase() !== "li" || w >= 4) words += w;
  }
  return words;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

type OrganicItem = { type?: string; url?: string; rank_group?: number };
type SerpUrls = { urls: string[]; costUsd: number; source: string; error?: string };

const organicUrls = (items: OrganicItem[] | undefined) => (items ?? [])
  .filter((i) => i.type === "organic" && i.url && /^https?:\/\//.test(i.url) && (i.rank_group ?? 1) <= 20)
  .sort((x, y) => (x.rank_group ?? 0) - (y.rank_group ?? 0))
  .map((i) => i.url!);

/**
 * Топ Google с настоящими адресами. Живая выдача DataForSEO с осени 2026 отдаёт большую часть ссылок как google.com/goto
 * (зашифровано, а с сервера Google отвечает проверкой на бота), поэтому сначала — последний снимок выдачи из базы
 * DataForSEO Labs (historical_serps, ~$0.0006): по SEO-ключу, затем по теме; живая выдача — запасной путь, только прямые ссылки.
 */
async function topUrls(ai: AiCtx, queries: string[]): Promise<SerpUrls> {
  let cost = 0;
  for (const q of queries) {
    const r = await dfsRequest(ai, "dataforseo_labs/google/historical_serps/live", [{ keyword: q, location_code: 2840, language_code: "en" }], 60_000);
    cost += r.costUsd ?? 0;
    if (!r.ok) continue;
    const snap = (r.data as { tasks?: Array<{ result?: Array<{ items?: Array<{ datetime?: string; items?: OrganicItem[] }> }> }> })?.tasks?.[0]?.result?.[0]?.items?.[0];
    const urls = organicUrls(snap?.items);
    if (urls.length >= 5) return { urls, costUsd: cost, source: `снимок выдачи «${q}»${snap?.datetime ? ` от ${snap.datetime.slice(0, 10)}` : ""}` };
  }
  const q = queries[queries.length - 1];
  const r = await dfsRequest(ai, "serp/google/organic/live/advanced", [{ keyword: q, location_code: 2840, language_code: "en", device: "desktop", depth: 10 }], 60_000);
  cost += r.costUsd ?? 0;
  if (!r.ok) return { urls: [], costUsd: cost, source: "", error: `выдача Google не получена: ${String(r.error ?? r.status).slice(0, 160)}` };
  const live = organicUrls((r.data as { tasks?: Array<{ result?: Array<{ items?: OrganicItem[] }> }> })?.tasks?.[0]?.result?.[0]?.items).filter((u) => !/(^|\.)google\.[a-z.]+\/goto\b/i.test(u.replace(/^https?:\/\//, "")));
  return { urls: live, costUsd: cost, source: `живая выдача «${q}»` };
}

/** Медиана слов статей из топа Google; ошибки не роняют этап — возвращается пусто с причиной. */
export async function competitorWords(ai: AiCtx, queries: string[], signal?: AbortSignal, log?: (m: string) => void): Promise<{ median: number | null; pages: Array<{ url: string; words: number }>; costUsd: number; source: string; error?: string }> {
  const top = await topUrls(ai, [...new Set(queries.map((q) => q.trim().toLowerCase()).filter(Boolean))]);
  const cost = top.costUsd;
  if (top.error) return { median: null, pages: [], costUsd: cost, source: top.source, error: top.error };
  const urls: string[] = [];
  for (const url of top.urls) {
    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { continue; }
    if (SKIP_HOST.test(host) || /\.(pdf|ashx|docx?)($|\?)/i.test(url)) { log?.(`пропуск (соцсеть, магазин, форум, видео): ${host}`); continue; }
    urls.push(url);
  }
  const pages: Array<{ url: string; words: number }> = [];
  // По 3 параллельно, пока не наберётся PAGES годных статей
  for (let k = 0; k < urls.length && pages.length < PAGES; k += 3) {
    const batch = urls.slice(k, k + 3);
    const got = await Promise.all(batch.map(async (url) => {
      try {
        const res = await safeFetch(url, { timeoutMs: 12_000, maxBytes: 4 * 1024 * 1024, signal, headers: { "User-Agent": UA, Accept: "text/html" } });
        if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "html")) { log?.(`${url.slice(0, 80)}: HTTP ${res.status}`); return null; }
        const words = articleWords(res.body.toString("utf8"));
        if (words >= PAGE_WORDS[0] && words <= PAGE_WORDS[1]) return { url, words };
        log?.(`${url.slice(0, 80)}: ${words} слов — не статья`);
        return null;
      } catch (e) { log?.(`${url.slice(0, 80)}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160)); return null; }
    }));
    for (const g of got) if (g && pages.length < PAGES) pages.push(g);
  }
  if (pages.length < MIN_PAGES) return { median: null, pages, costUsd: cost, source: top.source, error: `статей конкурентов прочитано ${pages.length} из ${MIN_PAGES} нужных` };
  return { median: median(pages.map((p) => p.words)), pages, costUsd: cost, source: top.source };
}

/** Рамки объёма формата: [от, до]; списки — от числа пунктов. */
export function formatRange(s: Pick<Scenario, "key" | "structure">, n: number | null): [number, number] {
  const per = (lo: number, hi: number, base: number): [number, number] => {
    const c = Math.max(3, n ?? 10);
    return [Math.round(c * lo + base), Math.round(c * hi + base + 200)];
  };
  switch (s.key) {
    case "checklist": return [600, 1400];
    case "big_list": return per(10, 16, 250);
    case "workout": return per(80, 130, 350);
    case "plan": return [1000, 2200];
    case "recipe": return [800, 1500];
    case "numbered": return per(80, 130, 250);
    case "comparison": return [1400, 2500];
    case "explainer": return [1100, 2200];
    case "how_to_video": return [900, 1800];
    case "roundup_recipes": case "roundup_ideas": return per(50, 80, 250);
    default: return [900, 2000];
  }
}

const round50 = (v: number) => Math.round(v / 50) * 50;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Число фото (вместе с главным): по формату, пунктам, визуальности темы и объёму. */
export function imageRange(s: Pick<Scenario, "key" | "structure">, n: number | null, words: number, visual: boolean): { min: number; max: number } {
  const byWords = Math.max(3, Math.round(words / 220));
  let min: number, max: number;
  if (s.structure === "numbered" && n) { max = Math.min(12, Math.ceil(n / 2) + 1); min = Math.max(3, max - 2); }
  else if (s.structure === "workout" && n) { max = Math.min(12, n + 1); min = Math.max(3, Math.ceil(n / 2)); }
  else if (s.structure === "roundup" && n) { max = Math.min(26, n + 1); min = max; }
  else if (s.structure === "big_list") { min = 3; max = visual ? 6 : 4; }
  else if (s.structure === "recipe") { min = 4; max = 7; }
  else if (s.structure === "plan") { min = 3; max = 5; }
  else if (visual) { max = Math.min(10, byWords + 1); min = Math.max(4, max - 3); }
  else { max = Math.min(5, byWords); min = 3; }
  if (s.structure !== "roundup") max = Math.min(max, Math.max(3, byWords + (visual ? 2 : 0)));
  // После потолка по объёму нижний предел — не выше «потолок − 2» (подборке нужно фото у каждого пункта)
  return { min: s.structure === "roundup" ? max : Math.min(min, Math.max(3, max - 2)), max };
}

/** Итог для статьи: объём и фото; ручные значения запуска сохраняются. */
export async function sizeArticle(ai: AiCtx, o: {
  queries: string[]; topic: string; keyword: string; scenario: Pick<Scenario, "key" | "structure">; n: number | null;
  params: BlogRecipeParams; fixed: { length: boolean; images: boolean }; signal?: AbortSignal; log?: (m: string) => void;
}): Promise<BlogSizing> {
  const [lo, hi] = formatRange(o.scenario, o.n);
  const comp = o.fixed.length ? { median: null, pages: [], costUsd: 0, source: "" } as Awaited<ReturnType<typeof competitorWords>> : await competitorWords(ai, o.queries, o.signal, o.log);
  const words = o.fixed.length
    ? Math.round((o.params.length.min + o.params.length.max) / 2)
    : round50(comp.median ? clamp(comp.median * 1.15, lo, hi) : (lo + hi) / 2);
  const length = o.fixed.length ? o.params.length : { min: round50(words * 0.85), max: round50(words * 1.15) };
  const visual = isVisualTopic(`${o.topic} ${o.keyword}`);
  const images = o.fixed.images ? { min: o.params.images.min, max: o.params.images.max } : imageRange(o.scenario, o.n, words, visual);
  const why: string[] = [];
  if (o.fixed.length) why.push(`объём из запуска ${length.min}–${length.max}`);
  else if (comp.median) why.push(`${comp.source}, статей ${comp.pages.length}: медиана ${comp.median} слов → цель ${words} (формат ${lo}–${hi})`);
  else why.push(`по формату ${lo}–${hi} → цель ${words}${comp.error ? ` (${comp.error})` : ""}`);
  why.push(o.fixed.images ? `фото из запуска ${images.min}–${images.max}` : `фото ${images.min}–${images.max}${o.n ? `, пунктов ${o.n}` : ""}${visual ? ", визуальная тема" : ""}`);
  return { words, length, images, median: comp.median, pages: comp.pages, query: comp.source || o.queries[0], reason: why.join(" · "), fixed: o.fixed, costUsd: comp.costUsd, ...(comp.error ? { error: comp.error } : {}) };
}
