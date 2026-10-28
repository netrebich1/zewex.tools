import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decodeEntities } from "./text";
import { activeProxies, fetchWithProxy } from "./sources";
import { fetchText } from "./fetch";

/**
 * Ресёрч по карточке из избранного: открываем страницы источников и собираем кандидатов главной картинки
 * (og:image, крупные <img>) и вставки Instagram / X / YouTube. Картинки источников — только ориентир для поиска
 * оригинала (пресс-фото, пост героя); вставки можно ставить штатным кодом.
 */

export type ResearchImage = { url: string; from: string; w?: number; h?: number; kind: "og" | "img" | "feed" };
export type ResearchEmbed = { kind: "instagram" | "x" | "youtube" | "tiktok" | "facebook" | "threads" | "telegram" | "pinterest"; url: string; from: string };
export type ResearchPage = { url: string; ok: boolean; note?: string; title?: string; lead?: string };
export type ClusterResearch = { images: ResearchImage[]; embeds: ResearchEmbed[]; pages: ResearchPage[]; at: string; deep?: boolean; queries?: string[] };

const attr = (tag: string, name: string) => decodeEntities(tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ?? "");
const metaContent = (html: string, prop: string) => {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const t = m[0];
    if (new RegExp(`\\b(?:property|name)\\s*=\\s*["']${prop}["']`, "i").test(t)) return attr(t, "content");
  }
  return "";
};
const abs = (u: string, base: string) => {
  try {
    return new URL(u, base).toString();
  } catch {
    return "";
  }
};
const isPhoto = (u: string) => /\.(jpe?g|png|webp|avif)(\?|$)/i.test(u) || /\/wp-content\/uploads\/|images\.|img\.|cdn\./i.test(u);
const junk = (u: string) => /logo|icon|avatar|sprite|placeholder|blank|pixel|badge|button|banner|ads?\.|\.svg|\.gif|emoji|1x1|spacer|channelheader|\/pix\/|\/static\/|\/assets\/|share-|social/i.test(u);

export function extractFromHtml(html: string, pageUrl: string, from: string): { images: ResearchImage[]; embeds: ResearchEmbed[]; title: string; lead: string } {
  const images: ResearchImage[] = [];
  const embeds: ResearchEmbed[] = [];
  const seen = new Set<string>();
  const addImg = (u: string, kind: ResearchImage["kind"], w?: number, h?: number) => {
    const full = abs(u, pageUrl);
    if (!full || seen.has(full) || junk(full) || !/^https?:/.test(full)) return;
    seen.add(full);
    images.push({ url: full, from, kind, ...(w ? { w } : {}), ...(h ? { h } : {}) });
  };
  const og = metaContent(html, "og:image") || metaContent(html, "og:image:url") || metaContent(html, "twitter:image");
  if (og) addImg(og, "og", Number(metaContent(html, "og:image:width")) || undefined, Number(metaContent(html, "og:image:height")) || undefined);
  // Крупные картинки статьи: по атрибутам ширины или по srcset с большим размером.
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const t = m[0];
    const src = attr(t, "data-src") || attr(t, "data-lazy-src") || attr(t, "src");
    const srcset = attr(t, "data-srcset") || attr(t, "srcset");
    let best = src;
    let bestW = Number(attr(t, "width")) || 0;
    if (srcset) {
      for (const part of srcset.split(",")) {
        const [u, d] = part.trim().split(/\s+/);
        const w = parseInt(d ?? "0", 10);
        if (u && w > bestW) {
          best = u;
          bestW = w;
        }
      }
    }
    if (!best || !isPhoto(best)) continue;
    const h = Number(attr(t, "height")) || 0;
    if (bestW && bestW < 600) continue;
    if (!bestW && /\.png(\?|$)/i.test(best)) continue;
    if (images.length >= 12) break;
    addImg(best, "img", bestW || undefined, h || undefined);
  }
  const addEmbed = (kind: ResearchEmbed["kind"], u: string) => {
    const full = kind === "youtube" ? abs(u, pageUrl).replace(/&.*$/, "") : abs(u, pageUrl).replace(/[?#].*$/, "");
    if (!full || embeds.some((e) => e.url === full)) return;
    embeds.push({ kind, url: full, from });
  };
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+/gi)) addEmbed("instagram", m[0]);
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+\/status\/\d+/gi)) addEmbed("x", m[0]);
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)[A-Za-z0-9_-]{6,}/gi)) addEmbed("youtube", m[0]);
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9_.-]+\/video\/\d+/gi)) addEmbed("tiktok", m[0]);
  for (const m of html.matchAll(/https?:\/\/(?:www\.|m\.)?facebook\.com\/(?:[A-Za-z0-9_.-]+\/(?:posts|videos|photos)\/[A-Za-z0-9_.-]+|watch\/?\?v=\d+|reel\/\d+|photo\/?\?fbid=\d+)/gi)) addEmbed("facebook", m[0]);
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?threads\.(?:net|com)\/@[A-Za-z0-9_.]+\/post\/[A-Za-z0-9_-]+/gi)) addEmbed("threads", m[0]);
  for (const m of html.matchAll(/https?:\/\/t\.me\/(?!s\/)[A-Za-z0-9_]{4,}\/\d+/gi)) addEmbed("telegram", m[0]);
  for (const m of html.matchAll(/https?:\/\/(?:[a-z]{2}\.)?pinterest\.com\/pin\/\d+/gi)) addEmbed("pinterest", m[0]);
  const title = (metaContent(html, "og:title") || decodeEntities(html.match(/<title[^>]*>([^<]{3,200})/i)?.[1] ?? "")).replace(/s+/g, " ").trim();
  const lead = (metaContent(html, "og:description") || metaContent(html, "description")).replace(/s+/g, " ").trim().slice(0, 500);
  return { images, embeds: embeds.slice(0, 16), title, lead };
}

const SOCIAL_HOST = /instagram\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|facebook\.com|threads\.(net|com)|t\.me|pinterest\.com|google\.|bing\.|duckduckgo\.|wikipedia\.org|yandex\./i;

/** Поиск страниц по запросу (DuckDuckGo HTML, без ключей): до N ссылок, без соцсетей и поисковиков. */
export async function webSearch(query: string, n = 8): Promise<string[]> {
  const r = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeoutMs: 15_000, accept: "text/html" });
  if (!r.ok) return [];
  const out: string[] = [];
  for (const m of r.text.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/gi)) {
    let u = decodeEntities(m[1]);
    const uddg = u.match(/[?&]uddg=([^&]+)/);
    if (uddg) u = decodeURIComponent(uddg[1]);
    if (!/^https?:/.test(u) || SOCIAL_HOST.test(u) || out.includes(u)) continue;
    out.push(u);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Дополнительный ресёрч для избранного: ищем в вебе по герою и теме (укр и англ), открываем найденные страницы
 * конкурентов и собираем из них вставки соцсетей и картинки. Добавляется к обычному ресёрчу.
 */
export async function deepResearch(clusterId: string): Promise<ClusterResearch> {
  const base = await researchCluster(clusterId);
  const cluster = await prisma.newsCluster.findUniqueOrThrow({ where: { id: clusterId }, select: { title: true, titleUk: true, mainEntityName: true, entities: true, projectId: true } });
  const ents = Array.isArray(cluster.entities) ? (cluster.entities as { name?: string; orig?: string; role?: string }[]) : [];
  const main = ents.find((e) => e.role === "main") ?? ents[0];
  const hero = cluster.mainEntityName || main?.name || "";
  const heroEn = main?.orig && /[a-z]/i.test(main.orig) ? main.orig : "";
  const topic = (cluster.titleUk || cluster.title).replace(/[«»"“”:—–-]/g, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 6).join(" ");
  const queries = [hero ? `${hero} ${topic}` : topic, heroEn ? `${heroEn} ${cluster.title.split(/\s+/).slice(0, 7).join(" ")}` : ""].filter(Boolean);
  const project = await prisma.newsProject.findUniqueOrThrow({ where: { id: cluster.projectId }, select: { settings: true } });
  const autoProxy = (project.settings as { autoProxy?: boolean } | null)?.autoProxy !== false;
  const proxies = await activeProxies();
  const known = new Set(base.pages.map((p) => p.url));
  const urls: string[] = [];
  for (const q of queries) {
    for (const u of await webSearch(q, 6)) if (!known.has(u) && !urls.includes(u)) urls.push(u);
  }
  const extra: ClusterResearch["pages"] = [];
  await Promise.all(urls.slice(0, 8).map(async (u) => {
    const r = await fetchWithProxy(u, false, autoProxy, proxies);
    const from = u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
    if (!r.ok) {
      extra.push({ url: u, ok: false, note: r.error ?? `HTTP ${r.status}` });
      return;
    }
    const got = extractFromHtml(r.text, r.finalUrl || u, from);
    for (const im of got.images) if (!base.images.some((x) => x.url === im.url)) base.images.push(im);
    for (const e of got.embeds) if (!base.embeds.some((x) => x.url === e.url)) base.embeds.push(e);
    extra.push({ url: u, ok: true, note: `пошук: ${got.images.length} фото, ${got.embeds.length} вставок`, title: got.title, lead: got.lead });
  }));
  const out: ClusterResearch = { ...base, pages: [...base.pages, ...extra], images: base.images.slice(0, 20), embeds: base.embeds.slice(0, 16), deep: true, queries };
  await prisma.newsCluster.update({ where: { id: clusterId }, data: { research: out as unknown as Prisma.InputJsonValue, researchAt: new Date() } });
  return out;
}

/** Собрать ресёрч по кластеру: страницы источников (до 8) + картинки из лент. */
export async function researchCluster(clusterId: string): Promise<ClusterResearch> {
  const [cluster, items, proxies] = await Promise.all([
    prisma.newsCluster.findUniqueOrThrow({ where: { id: clusterId }, select: { projectId: true, imageUrl: true } }),
    prisma.newsItem.findMany({ where: { clusterId }, orderBy: { foundAt: "asc" }, select: { url: true, domain: true, imageUrl: true, tier: true } }),
    activeProxies(),
  ]);
  const project = await prisma.newsProject.findUniqueOrThrow({ where: { id: cluster.projectId }, select: { settings: true } });
  const autoProxy = (project.settings as { autoProxy?: boolean } | null)?.autoProxy !== false;
  const out: ClusterResearch = { images: [], embeds: [], pages: [], at: new Date().toISOString() };
  for (const it of items) if (it.imageUrl && !junk(it.imageUrl)) out.images.push({ url: it.imageUrl, from: it.domain, kind: "feed" });
  const pages = items.filter((x) => !/news\.google\.com/.test(x.url)).slice(0, 8);
  await Promise.all(pages.map(async (p) => {
    const r = await fetchWithProxy(p.url, false, autoProxy, proxies);
    if (!r.ok) {
      out.pages.push({ url: p.url, ok: false, note: r.error ?? `HTTP ${r.status}` });
      return;
    }
    const got = extractFromHtml(r.text, r.finalUrl || p.url, p.domain);
    for (const im of got.images) if (!out.images.some((x) => x.url === im.url)) out.images.push(im);
    for (const e of got.embeds) if (!out.embeds.some((x) => x.url === e.url)) out.embeds.push(e);
    out.pages.push({ url: p.url, ok: true, note: `${got.images.length} фото, ${got.embeds.length} вставок` });
  }));
  // Google News ссылки ведут на news.google.com — страницы оригиналов недоступны без редиректа; это отмечаем.
  const gn = items.length - pages.length;
  if (gn > 0) out.pages.push({ url: "news.google.com", ok: false, note: `${gn} ссылок через Google News — оригиналы не открывались` });
  out.images = out.images.slice(0, 16);
  await prisma.newsCluster.update({ where: { id: clusterId }, data: { research: out as unknown as Prisma.InputJsonValue, researchAt: new Date() } });
  return out;
}

/** Готовый код вставки по ссылке: Instagram, X, YouTube, TikTok — штатные embed-коды платформ. */
export function embedCode(e: { kind: ResearchEmbed["kind"]; url: string }): string {
  const u = e.url.replace(/[?#].*$/, "");
  if (e.kind === "instagram") {
    return `<blockquote class="instagram-media" data-instgrm-permalink="${u}/?utm_source=ig_embed" data-instgrm-version="14" style="max-width:540px;min-width:326px;width:100%;margin:1em auto;"><a href="${u}/">Переглянути цей допис в Instagram</a></blockquote>\n<script async src="https://www.instagram.com/embed.js"></script>`;
  }
  if (e.kind === "x") {
    return `<blockquote class="twitter-tweet"><a href="${u}">${u}</a></blockquote>\n<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`;
  }
  if (e.kind === "youtube") {
    const id = e.url.match(/(?:v=|embed\/|youtu\.be\/)([A-Za-z0-9_-]{6,})/)?.[1] ?? "";
    return `<iframe width="560" height="315" src="https://www.youtube.com/embed/${id}" title="YouTube video" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="max-width:100%"></iframe>`;
  }
  if (e.kind === "tiktok") {
    const vid = e.url.match(/\/video\/(\d+)/)?.[1] ?? "";
    return `<blockquote class="tiktok-embed" cite="${u}" data-video-id="${vid}" style="max-width:605px;min-width:325px"><a href="${u}">TikTok</a></blockquote>\n<script async src="https://www.tiktok.com/embed.js"></script>`;
  }
  if (e.kind === "facebook") {
    const isVideo = /\/videos\/|watch|\/reel\//.test(e.url);
    return `<iframe src="https://www.facebook.com/plugins/${isVideo ? "video" : "post"}.php?href=${encodeURIComponent(e.url)}&show_text=true&width=500" width="500" height="${isVideo ? 400 : 600}" style="border:none;overflow:hidden;max-width:100%" scrolling="no" frameborder="0" allowfullscreen="true" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"></iframe>`;
  }
  if (e.kind === "threads") {
    return `<blockquote class="text-post-media" data-text-post-permalink="${u}" data-text-post-version="0" style="max-width:540px;min-width:270px;width:100%;margin:1em auto"><a href="${u}">Переглянути в Threads</a></blockquote>\n<script async src="https://www.threads.net/embed.js"></script>`;
  }
  if (e.kind === "telegram") {
    const post = u.replace(/^https?:\/\/t\.me\//, "");
    return `<script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-post="${post}" data-width="100%"></script>`;
  }
  // pinterest
  return `<a data-pin-do="embedPin" data-pin-width="medium" href="${u}"></a>\n<script async defer src="https://assets.pinterest.com/js/pinit.js"></script>`;
}
