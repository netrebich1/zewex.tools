import { decodeEntities, hostOf, stripHtml } from "./text";

/**
 * Разбор лент без XML-библиотеки: RSS 2.0, Atom, news-sitemap / sitemap, Google News RSS, Google Trends RSS.
 * Ленты медиа часто нестрогие (CDATA, html в описании, нестандартные теги), поэтому — терпимые регулярки по блокам.
 */

export type FeedItem = {
  url: string;
  title: string;
  lead: string;
  imageUrl: string | null;
  categories: string[];
  publishedAt: Date | null;
  /** Для Google News: настоящий сайт и его название (ссылка ведёт на news.google.com). */
  sourceName?: string;
  sourceUrl?: string;
};

export type TrendItem = { title: string; traffic: string; publishedAt: Date | null; news: { title: string; url: string; source: string }[] };

export type ParsedFeed = { kind: "rss" | "atom" | "urlset" | "sitemapindex" | "unknown"; items: FeedItem[]; children: string[] };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Содержимое первого тега `name` (с пространством имён), CDATA снят. */
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}
function tags(block: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, "gi");
  for (const m of block.matchAll(re)) out.push(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim());
  return out;
}
function attr(block: string, tagName: string, attrName: string, where?: (t: string) => boolean): string {
  const re = new RegExp(`<${esc(tagName)}\\b[^>]*>`, "gi");
  for (const m of block.matchAll(re)) {
    if (where && !where(m[0])) continue;
    const a = m[0].match(new RegExp(`\\b${esc(attrName)}\\s*=\\s*["']([^"']+)["']`, "i"));
    if (a) return decodeEntities(a[1]);
  }
  return "";
}
function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, "gi");
  for (const m of xml.matchAll(re)) out.push(m[1]);
  return out;
}

export function parseDate(s: string): Date | null {
  const v = s.trim();
  if (!v) return null;
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d;
  // «28.10.2026 10:15» и подобное
  const m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0) - 2, +(m[5] ?? 0)));
  return null;
}

function firstImg(html: string): string | null {
  const m = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : null;
}

/** Без «половинок» эмодзи: обрезка строки или сущность &#55357; дают одиночный суррогат, и база не принимает запись. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const wellFormed = (s: string) => s.replace(LONE_SURROGATE, "");
function wellFormedItem(it: FeedItem): FeedItem {
  return {
    ...it,
    url: wellFormed(it.url),
    title: wellFormed(it.title),
    lead: wellFormed(it.lead),
    imageUrl: it.imageUrl ? wellFormed(it.imageUrl) : null,
    categories: it.categories.map(wellFormed),
    ...(it.sourceName ? { sourceName: wellFormed(it.sourceName) } : {}),
  };
}

function rssItem(b: string): FeedItem | null {
  const title = stripHtml(tag(b, "title"));
  let url = stripHtml(tag(b, "link"));
  if (!/^https?:/i.test(url)) url = attr(b, "link", "href") || stripHtml(tag(b, "guid"));
  if (!title || !/^https?:/i.test(url)) return null;
  const descHtml = tag(b, "description");
  const full = tag(b, "content:encoded") || tag(b, "yandex:full-text") || tag(b, "fulltext");
  const lead = stripHtml(descHtml || full).slice(0, 600);
  const body = full ? stripHtml(full).slice(0, 1500) : "";
  const image =
    attr(b, "enclosure", "url", (t) => !/type\s*=\s*["'](?!image)/i.test(t)) ||
    attr(b, "media:content", "url", (t) => !/medium\s*=\s*["'](?!image)/i.test(t)) ||
    attr(b, "media:thumbnail", "url") ||
    stripHtml(tag(tag(b, "image"), "url")) ||
    firstImg(descHtml) ||
    firstImg(full) ||
    null;
  const cats = [...tags(b, "category").map(stripHtml), ...tags(b, "dc:subject").map(stripHtml)].filter(Boolean);
  const date = parseDate(stripHtml(tag(b, "pubDate") || tag(b, "pubdate") || tag(b, "dc:date") || tag(b, "published") || tag(b, "updated")));
  const srcTag = b.match(/<source\b[^>]*\burl\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
  return {
    url: decodeEntities(url),
    title,
    lead: body && body.length > lead.length ? body : lead,
    imageUrl: image,
    categories: [...new Set(cats)].slice(0, 12),
    publishedAt: date,
    ...(srcTag ? { sourceUrl: decodeEntities(srcTag[1]), sourceName: stripHtml(srcTag[2]) } : {}),
  };
}

function atomEntry(b: string): FeedItem | null {
  const title = stripHtml(tag(b, "title"));
  const url = attr(b, "link", "href", (t) => !/rel\s*=\s*["'](?!alternate)/i.test(t)) || attr(b, "link", "href");
  if (!title || !url) return null;
  const content = tag(b, "content") || tag(b, "summary");
  const cats = [...b.matchAll(/<category\b[^>]*\bterm\s*=\s*["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1]));
  return {
    url,
    title,
    lead: stripHtml(content).slice(0, 1500),
    imageUrl: attr(b, "media:thumbnail", "url") || attr(b, "media:content", "url") || firstImg(decodeEntities(content)) || null,
    categories: cats,
    publishedAt: parseDate(stripHtml(tag(b, "published") || tag(b, "updated"))),
  };
}

function sitemapUrl(b: string): FeedItem | null {
  const url = stripHtml(tag(b, "loc"));
  if (!/^https?:/i.test(url)) return null;
  const title = stripHtml(tag(b, "news:title"));
  const kw = stripHtml(tag(b, "news:keywords"));
  return {
    url,
    // В обычной карте сайта заголовка нет — заголовок берётся из адреса и уточняется на шаге загрузки страницы (позже).
    title: title || slugTitle(url),
    lead: "",
    imageUrl: stripHtml(tag(b, "image:loc")) || null,
    categories: kw ? kw.split(",").map((s) => s.trim()).filter(Boolean) : [],
    publishedAt: parseDate(stripHtml(tag(b, "news:publication_date") || tag(b, "lastmod"))),
  };
}

/** «/moda/novosty/60-y-sezon-ukrainian-fashion-week/» → «60 y sezon ukrainian fashion week». */
export function slugTitle(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const last = parts.reverse().find((p) => /[a-z]{3,}/i.test(p)) ?? "";
    return decodeURIComponent(last).replace(/\.\w+$/, "").replace(/^\d{5,}-?/, "").replace(/[-_]+/g, " ").trim();
  } catch {
    return url;
  }
}

export function parseFeed(xml: string): ParsedFeed {
  const head = xml.slice(0, 3000);
  if (/<rss\b|<rdf:RDF\b|<channel\b/i.test(head)) {
    return { kind: "rss", items: blocks(xml, "item").map(rssItem).filter((x): x is FeedItem => !!x).map(wellFormedItem), children: [] };
  }
  if (/<feed\b/i.test(head)) {
    return { kind: "atom", items: blocks(xml, "entry").map(atomEntry).filter((x): x is FeedItem => !!x).map(wellFormedItem), children: [] };
  }
  if (/<sitemapindex\b/i.test(head)) {
    const children = blocks(xml, "sitemap").map((b) => ({ loc: stripHtml(tag(b, "loc")), mod: parseDate(stripHtml(tag(b, "lastmod")))?.getTime() ?? 0 }));
    children.sort((a, b) => b.mod - a.mod);
    return { kind: "sitemapindex", items: [], children: children.map((c) => c.loc).filter(Boolean) };
  }
  if (/<urlset\b/i.test(head)) {
    return { kind: "urlset", items: blocks(xml, "url").map(sitemapUrl).filter((x): x is FeedItem => !!x).map(wellFormedItem), children: [] };
  }
  return { kind: "unknown", items: [], children: [] };
}

/** Google News RSS: заголовок «Текст - Издание», ссылка на news.google.com, настоящий сайт — в <source url>. */
export function cleanGnewsItem(it: FeedItem): FeedItem {
  const src = it.sourceName ?? "";
  let title = it.title;
  if (src && title.endsWith(` - ${src}`)) title = title.slice(0, -(src.length + 3)).trim();
  return { ...it, title, lead: "", imageUrl: null };
}

export function parseTrends(xml: string): TrendItem[] {
  return blocks(xml, "item").map((b) => ({
    title: stripHtml(tag(b, "title")),
    traffic: stripHtml(tag(b, "ht:approx_traffic")),
    publishedAt: parseDate(stripHtml(tag(b, "pubDate"))),
    news: blocks(b, "ht:news_item").map((n) => ({ title: stripHtml(tag(n, "ht:news_item_title")), url: stripHtml(tag(n, "ht:news_item_url")), source: stripHtml(tag(n, "ht:news_item_source")) })).filter((n) => n.title),
  })).filter((t) => t.title);
}

/** Ссылки на ленты со страницы сайта (rel=alternate) и похожие на ленты ссылки. */
export function feedLinksFromHtml(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0];
    if (!/type\s*=\s*["']application\/(rss|atom)\+xml["']/i.test(t)) continue;
    const href = t.match(/href\s*=\s*["']([^"']+)["']/i);
    if (href) {
      try {
        out.add(new URL(decodeEntities(href[1]), base).toString());
      } catch {
        /* битая ссылка */
      }
    }
  }
  for (const m of html.matchAll(/href\s*=\s*["']([^"']*(?:\/rss|\/feed|rss\.xml|feed\.xml|\.rss)[^"']*)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), base);
      if (hostOf(u.toString()).endsWith(hostOf(base).split(".").slice(-2).join("."))) out.add(u.toString());
    } catch {
      /* битая ссылка */
    }
  }
  return [...out].slice(0, 20);
}
