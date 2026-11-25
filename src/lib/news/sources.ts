import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { fetchText, type FetchResult } from "./fetch";
import { cleanGnewsItem, feedLinksFromHtml, parseFeed, parseTrends, type FeedItem, type TrendItem } from "./parse";
import type { NewsSettings } from "./types";

/** Адреса Google News / Trends, загрузка источника (с прокси при 403/429), поиск лент сайта. */

export function gnewsSearchUrl(q: string, s: Pick<NewsSettings, "hl" | "gl" | "ceid">, when = "1d"): string {
  const query = /\bwhen:\d+[hd]\b/.test(q) ? q : `${q} when:${when}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${s.hl}&gl=${s.gl}&ceid=${encodeURIComponent(s.ceid)}`;
}
export function gnewsTopicUrl(topic: string, s: Pick<NewsSettings, "hl" | "gl" | "ceid">): string {
  return `https://news.google.com/rss/headlines/section/topic/${encodeURIComponent(topic.toUpperCase())}?hl=${s.hl}&gl=${s.gl}&ceid=${encodeURIComponent(s.ceid)}`;
}
export function trendsUrl(geo: string): string {
  return `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
}

export type ProxyRow = { id: string; label: string; url: string };
export async function activeProxies(): Promise<ProxyRow[]> {
  const rows = await prisma.newsProxy.findMany({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
  return rows.flatMap((r) => {
    try {
      return [{ id: r.id, label: r.label, url: decryptSecret(r.urlEnc) }];
    } catch {
      return [];
    }
  });
}

export type SourceLike = { id: string; kind: string; url: string; viaProxy: boolean; lang?: string };
export type SourceFetch = { items: FeedItem[]; trends: TrendItem[]; error?: string; status: number; viaProxy: boolean; proxyId?: string };

const blocked = (r: FetchResult) => r.status === 403 || r.status === 429 || r.status === 451 || r.status === 503;

/** Загрузка с прокси: сначала напрямую (если источник не помечен «через прокси»), при 403/429 — через прокси. */
export async function fetchWithProxy(url: string, wantProxy: boolean, autoProxy: boolean, proxies: ProxyRow[]): Promise<FetchResult & { proxyId?: string }> {
  const pick = () => proxies[Math.floor(Math.random() * proxies.length)];
  if (wantProxy && proxies.length) {
    const p = pick();
    return { ...(await fetchText(url, { proxyUrl: p.url })), proxyId: p.id };
  }
  const r = await fetchText(url);
  if (!r.ok && autoProxy && proxies.length && blocked(r)) {
    const p = pick();
    return { ...(await fetchText(url, { proxyUrl: p.url })), proxyId: p.id };
  }
  return r;
}

/** Редакция Google News по языку источника: мировые запросы (site:people.com) — в американской, иначе выдача пустая. */
const GNEWS_EDITIONS: Record<string, Pick<NewsSettings, "hl" | "gl" | "ceid">> = {
  en: { hl: "en-US", gl: "US", ceid: "US:en" },
  fr: { hl: "fr", gl: "FR", ceid: "FR:fr" },
  it: { hl: "it", gl: "IT", ceid: "IT:it" },
  de: { hl: "de", gl: "DE", ceid: "DE:de" },
  pl: { hl: "pl", gl: "PL", ceid: "PL:pl" },
};
export function gnewsEdition(lang: string | undefined, s: NewsSettings): Pick<NewsSettings, "hl" | "gl" | "ceid"> {
  const own = s.hl.split("-")[0].toLowerCase();
  return lang && lang.toLowerCase() !== own && GNEWS_EDITIONS[lang.toLowerCase()] ? GNEWS_EDITIONS[lang.toLowerCase()] : s;
}

export function sourceUrl(src: SourceLike, s: NewsSettings): string {
  const ed = gnewsEdition(src.lang, s);
  if (src.kind === "gnews_query") return gnewsSearchUrl(src.url, ed);
  if (src.kind === "gnews_topic") return /^https?:/.test(src.url) ? src.url : gnewsTopicUrl(src.url, ed);
  if (src.kind === "trends") return /^https?:/.test(src.url) ? src.url : trendsUrl(src.url || s.gl);
  return src.url;
}

export async function fetchSource(src: SourceLike, s: NewsSettings, proxies: ProxyRow[]): Promise<SourceFetch> {
  const url = sourceUrl(src, s);
  let r = await fetchWithProxy(url, src.viaProxy, s.autoProxy, proxies);
  if (!r.ok) return { items: [], trends: [], error: r.error ?? `HTTP ${r.status}`, status: r.status, viaProxy: r.viaProxy, proxyId: r.proxyId };
  if (src.kind === "trends") return { items: [], trends: parseTrends(r.text), status: r.status, viaProxy: r.viaProxy, proxyId: r.proxyId };
  let feed = parseFeed(r.text);
  // Индекс карт сайта (nv.ua: sitemap_news.xml → sitemap_news_recent.xml): берём самую свежую дочернюю карту.
  if (feed.kind === "sitemapindex" && feed.children.length) {
    r = await fetchWithProxy(feed.children[0], src.viaProxy || r.viaProxy, s.autoProxy, proxies);
    if (!r.ok) return { items: [], trends: [], error: `${feed.children[0]}: ${r.error ?? r.status}`, status: r.status, viaProxy: r.viaProxy, proxyId: r.proxyId };
    feed = parseFeed(r.text);
  }
  if (feed.kind === "unknown") return { items: [], trends: [], error: "ответ не похож на RSS, Atom или карту сайта", status: r.status, viaProxy: r.viaProxy, proxyId: r.proxyId };
  const items = src.kind.startsWith("gnews") ? feed.items.map(cleanGnewsItem) : feed.items;
  return { items, trends: [], status: r.status, viaProxy: r.viaProxy, proxyId: r.proxyId };
}

export type FoundFeed = { url: string; kind: string; items: number; newest: string | null; title: string };

/** Поиск лент сайта: ссылки rel=alternate на главной + типовые адреса (/feed, /rss, news-sitemap). */
export async function discoverFeeds(siteUrl: string, proxies: ProxyRow[] = []): Promise<{ found: FoundFeed[]; error?: string }> {
  let base: URL;
  try {
    base = new URL(/^https?:/i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
  } catch {
    return { found: [], error: "Не похоже на адрес сайта" };
  }
  const home = await fetchWithProxy(base.toString(), false, true, proxies);
  const candidates = new Set<string>(home.ok ? feedLinksFromHtml(home.text, home.finalUrl || base.toString()) : []);
  const root = `${base.protocol}//${base.host}`;
  for (const p of ["/feed", "/rss", "/rss.xml", "/feed.xml", "/rss/", "/news-sitemap.xml", "/sitemap-news.xml", "/sitemap_news.xml", "/google-news-sitemap.xml", "/sitemap_google_news.xml"]) candidates.add(root + p);
  if (base.pathname.length > 1) for (const p of ["/feed/", "/rss/"]) candidates.add(root + base.pathname.replace(/\/$/, "") + p);
  const found: FoundFeed[] = [];
  const seen = new Set<string>();
  await Promise.all([...candidates].slice(0, 24).map(async (u) => {
    const r = await fetchWithProxy(u, false, true, proxies);
    if (!r.ok) return;
    let feed = parseFeed(r.text);
    if (feed.kind === "sitemapindex" && feed.children[0] && /news/i.test(feed.children[0])) {
      const c = await fetchWithProxy(feed.children[0], r.viaProxy, true, proxies);
      if (c.ok) feed = parseFeed(c.text);
    }
    if (feed.kind === "unknown" || feed.kind === "sitemapindex" || !feed.items.length) return;
    const newest = feed.items.map((i) => i.publishedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    // Обычная карта сайта со старыми адресами — не лента новостей.
    if (feed.kind === "urlset" && (!newest || Date.now() - newest > 3 * 86_400_000)) return;
    const key = `${feed.items.length}:${feed.items[0]?.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    const title = (r.text.match(/<title>(?:<!\[CDATA\[)?([^<\]]{1,120})/i)?.[1] ?? "").trim();
    found.push({ url: r.finalUrl || u, kind: feed.kind === "urlset" ? "sitemap" : "rss", items: feed.items.length, newest: newest ? new Date(newest).toISOString() : null, title });
  }));
  found.sort((a, b) => (b.newest ?? "").localeCompare(a.newest ?? ""));
  return { found, error: home.ok ? undefined : `главная не открылась: ${home.error}` };
}
