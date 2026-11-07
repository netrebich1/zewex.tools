import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decodeEntities, keyTokens, tokens } from "./text";
import { activeProxies, fetchWithProxy } from "./sources";
import { fetchText } from "./fetch";

/**
 * Ресёрч по карточке из избранного: страницы источников и поиск по событию → кандидаты главной картинки (ориентир)
 * и вставки соцсетей. Берём только то, что относится к этой новости: вставки ищем в основном тексте страницы,
 * каждую проверяем через oEmbed платформы (автор, подпись) на совпадение с героем и темой; старые посты отсекаем.
 */

export type ResearchImage = { url: string; from: string; w?: number; h?: number; kind: "og" | "img" | "feed" };
export type EmbedKind = "instagram" | "x" | "youtube" | "tiktok" | "facebook" | "threads" | "telegram" | "pinterest" | "reddit";
export type ResearchEmbed = { kind: EmbedKind; url: string; from: string; author?: string; text?: string; why?: string };
export type ResearchPage = { url: string; ok: boolean; note?: string; title?: string; lead?: string; publishedAt?: string };
export type ClusterResearch = { images: ResearchImage[]; embeds: ResearchEmbed[]; pages: ResearchPage[]; at: string; deep?: boolean; queries?: string[]; rejected?: number };

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
const strip = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Основной текст страницы: <article>, иначе от <h1> до блоков «читайте также / комментарии / сайдбар». */
function mainContent(html: string): string {
  const art = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0];
  if (art && art.length > 1500) return art;
  const start = html.search(/<h1\b/i);
  let body = start >= 0 ? html.slice(start) : html;
  const stop = body.search(/<(?:aside|footer)\b|class="[^"]*(?:related|comment|sidebar|recommend|also-read|read-more|more-news|popular|trending|teaser-list)[^"]*"/i);
  if (stop > 2000) body = body.slice(0, stop);
  return body;
}

function publishedAt(html: string): string | undefined {
  const m = metaContent(html, "article:published_time") || metaContent(html, "og:published_time") || html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] || "";
  const d = m ? new Date(m) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
}

export type Extracted = { images: ResearchImage[]; embeds: ResearchEmbed[]; title: string; lead: string; publishedAt?: string; text: string };

export function extractFromHtml(html: string, pageUrl: string, from: string): Extracted {
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
  const body = mainContent(html);
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
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
    if (images.length >= 8) break;
    addImg(best, "img", bestW || undefined, h || undefined);
  }
  const addEmbed = (kind: EmbedKind, u: string) => {
    const full = kind === "youtube" ? abs(u, pageUrl).replace(/&.*$/, "") : abs(u, pageUrl).replace(/[?#].*$/, "");
    if (!full || embeds.some((e) => e.url === full)) return;
    embeds.push({ kind, url: full, from });
  };
  for (const m of body.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+/gi)) addEmbed("instagram", m[0]);
  for (const m of body.matchAll(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+\/status\/\d+/gi)) addEmbed("x", m[0]);
  for (const m of body.matchAll(/https?:\/\/(?:www\.)?(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)[A-Za-z0-9_-]{6,}/gi)) addEmbed("youtube", m[0]);
  for (const m of body.matchAll(/https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9_.-]+\/video\/\d+/gi)) addEmbed("tiktok", m[0]);
  for (const m of body.matchAll(/https?:\/\/(?:www\.|m\.)?facebook\.com\/(?:[A-Za-z0-9_.-]+\/(?:posts|videos|photos)\/[A-Za-z0-9_.-]+|watch\/?\?v=\d+|reel\/\d+|photo\/?\?fbid=\d+)/gi)) addEmbed("facebook", m[0]);
  for (const m of body.matchAll(/https?:\/\/(?:www\.)?threads\.(?:net|com)\/@[A-Za-z0-9_.]+\/post\/[A-Za-z0-9_-]+/gi)) addEmbed("threads", m[0]);
  for (const m of body.matchAll(/https?:\/\/t\.me\/(?!s\/)[A-Za-z0-9_]{4,}\/\d+/gi)) addEmbed("telegram", m[0]);
  for (const m of body.matchAll(/https?:\/\/(?:[a-z]{2}\.)?pinterest\.com\/pin\/\d+/gi)) addEmbed("pinterest", m[0]);
  for (const m of body.matchAll(/https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/[a-z0-9]+(?:\/[A-Za-z0-9_%-]+)?/gi)) addEmbed("reddit", m[0]);
  const title = (metaContent(html, "og:title") || decodeEntities(html.match(/<title[^>]*>([^<]{3,200})/i)?.[1] ?? "")).replace(/\s+/g, " ").trim();
  const lead = (metaContent(html, "og:description") || metaContent(html, "description")).replace(/\s+/g, " ").trim().slice(0, 500);
  return { images, embeds: embeds.slice(0, 20), title, lead, publishedAt: publishedAt(html), text: strip(body).slice(0, 6000) };
}

// ───────── Релевантность: герой + тема ─────────

const fold = (s: string) => s.toLowerCase().replace(/[’'ʼ]/g, "").replace(/ё/g, "е").replace(/[іїи]/g, "и").replace(/[єе]/g, "е").replace(/[гґх]/g, "х").replace(/оу/g, "о").replace(/(.)\1/g, "$1");
const stem = (w: string) => (/[a-z]/.test(w) ? w.toLowerCase().replace(/'s$/, "") : fold(w).slice(0, Math.max(4, w.length - 2)));
const GENERIC = new Set(["зірка", "зірки", "зірку", "зіркою", "звезда", "показала", "показав", "здивувала", "мережу", "мережа", "фото", "відео", "новий", "нова", "нову", "образ", "образі", "стала", "став", "вперше", "вразила", "сімейне", "сімейні", "сукня", "сукні", "сукню", "сукнею", "образом", "образи", "образів", "образу", "вбранні", "вбрання", "стильний", "стильному", "стильним", "показали", "показали", "зявилася", "вийшла", "вийшов", "star", "shows", "photos", "news", "about", "with", "after", "their", "this", "that", "from", "look", "looks"]);

export type Topic = { heroStems: string[]; topicStems: string[]; hero: string; heroEn: string; since: Date; eventAt: Date };

export function topicOf(c: { title: string; titleUk: string | null; mainEntityName: string | null; entities: unknown; firstPublishedAt: Date }): Topic {
  const ents = Array.isArray(c.entities) ? (c.entities as { name?: string; orig?: string; role?: string }[]) : [];
  const main = ents.find((e) => e.role === "main") ?? ents[0];
  const hero = c.mainEntityName || main?.name || "";
  const heroEn = main?.orig && /[a-z]/i.test(main.orig) ? main.orig : "";
  const heroStems = [...tokens(hero), ...tokens(heroEn)].filter((w) => w.length >= 3).map(stem);
  const topicStems = [...keyTokens(c.titleUk || ""), ...keyTokens(c.title)].filter((w) => w.length >= 4 && !GENERIC.has(w) && !heroStems.some((h) => stem(w).startsWith(h) || h.startsWith(stem(w)))).map(stem);
  // Событие свежее: материалы старше 10 дней до первой публикации кластера — уже другая история.
  return { heroStems: [...new Set(heroStems)], topicStems: [...new Set(topicStems)].slice(0, 10), hero, heroEn, since: new Date(c.firstPublishedAt.getTime() - 10 * 86_400_000), eventAt: c.firstPublishedAt };
}

const hasHero = (t: Topic, text: string) => {
  const f = fold(text) + " " + text.toLowerCase();
  // Фамилия героя достаточна (Гілтон / Hilton); однословные имена — целиком.
  const last = t.heroStems.filter((s) => s.length >= 4);
  return last.some((s) => f.includes(s));
};
/** Расстояние Левенштейна — для правописных вариантов (Хеллоуін / Геловін, Кардаш'ян / Кардашьян). */
function lev(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
const topicHits = (t: Topic, text: string) => {
  const f = fold(text) + " " + text.toLowerCase();
  const words = f.split(/[^a-zа-яіїєґ0-9]+/i).filter((w) => w.length >= 5);
  return t.topicStems.filter((s) => s.length >= 4 && (f.includes(s) || (s.length >= 5 && words.some((w) => Math.min(lev(s, w.slice(0, s.length - 1)), lev(s, w.slice(0, s.length)), lev(s, w.slice(0, s.length + 1))) <= (s.length >= 8 ? 2 : 1))))).length;
};
const fresh = (t: Topic, iso?: string) => !iso || new Date(iso) >= t.since;

/** Страница про это событие: герой есть в заголовке или описании, плюс хотя бы одно слово темы, и не старше окна. */
export function pageRelevant(t: Topic, p: { title: string; lead: string; publishedAt?: string; text?: string }, strict = false): { ok: boolean; why: string } {
  if (!fresh(t, p.publishedAt)) return { ok: false, why: `стара публікація (${p.publishedAt?.slice(0, 10)})` };
  const head = `${p.title} ${p.lead}`;
  if (!hasHero(t, head)) return { ok: false, why: "герой не в заголовку" };
  const hits = topicHits(t, head) || Math.min(1, topicHits(t, (p.text ?? "").slice(0, 1500)));
  // Строго (пошук статті на сайті): у героя за ці дні може бути кілька новин — потрібно 2 слова теми (або 1, якщо тема коротка).
  if (strict) {
    // Одно слово темы достаточно, если статья вышла в ±3 дня от события (Геловін / Хеллоуін — те же дни).
    const near = p.publishedAt ? Math.abs(new Date(p.publishedAt).getTime() - t.eventAt.getTime()) <= 3 * 86_400_000 : false;
    return hits >= 2 || (hits >= 1 && (near || t.topicStems.length <= 3)) || !t.topicStems.length ? { ok: true, why: `герой + тема (${hits})` } : { ok: false, why: "тема не збігається" };
  }
  if (hits || !t.topicStems.length) return { ok: true, why: `герой + тема (${hits})` };
  // Слова теми можуть не збігтися через правопис (Геловін / Хеллоуін): публікація про героя в ±3 дні від події — та сама новина.
  const dt = p.publishedAt ? Math.abs(new Date(p.publishedAt).getTime() - t.eventAt.getTime()) : Infinity;
  if (dt <= 3 * 86_400_000) return { ok: true, why: "герой у заголовку, ті самі дні" };
  return { ok: false, why: "тема не збігається" };
}

// ───────── Проверка вставок через oEmbed платформ ─────────

type Verified = { author?: string; text?: string; ok: boolean; note?: string; date?: string };

async function oembedJson(url: string): Promise<Record<string, unknown> | null> {
  const r = await fetchText(url, { timeoutMs: 12_000, accept: "application/json" });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Автор и подпись поста: Instagram (embed/captioned), YouTube, X, TikTok, Reddit — без ключей. Остальные — без проверки. */
export async function verifyEmbed(e: ResearchEmbed): Promise<Verified> {
  try {
    if (e.kind === "instagram") {
      const r = await fetchText(`${e.url.replace(/\/$/, "")}/embed/captioned/`, { timeoutMs: 15_000, accept: "text/html" });
      if (!r.ok) return { ok: false, note: `instagram ${r.status}` };
      const user = r.text.match(/class="(?:CaptionUsername|UsernameText)[^"]*"[^>]*>([^<]+)</i)?.[1] ?? r.text.match(/"owner":\{[^}]*"username":"([^"]+)"/)?.[1] ?? "";
      const cap = r.text.match(/<div class="Caption"[\s\S]*?<\/div>/i)?.[0] ?? "";
      const date = r.text.match(/datetime="([^"]+)"/)?.[1];
      return { ok: true, author: user.trim(), text: strip(cap).slice(0, 400), date };
    }
    if (e.kind === "youtube") {
      const j = await oembedJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(e.url)}&format=json`);
      return j ? { ok: true, author: String(j.author_name ?? ""), text: String(j.title ?? "") } : { ok: false, note: "youtube oembed" };
    }
    if (e.kind === "x") {
      const j = await oembedJson(`https://publish.twitter.com/oembed?url=${encodeURIComponent(e.url)}&omit_script=1`);
      return j ? { ok: true, author: String(j.author_name ?? ""), text: strip(String(j.html ?? "")).slice(0, 400) } : { ok: false, note: "x oembed" };
    }
    if (e.kind === "tiktok") {
      const j = await oembedJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(e.url)}`);
      return j ? { ok: true, author: String(j.author_name ?? ""), text: String(j.title ?? "") } : { ok: false, note: "tiktok oembed" };
    }
    if (e.kind === "reddit") {
      const j = await oembedJson(`https://www.reddit.com/oembed?url=${encodeURIComponent(e.url)}`);
      return j ? { ok: true, author: String(j.author_name ?? ""), text: String(j.title ?? "") } : { ok: false, note: "reddit oembed" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, note: err instanceof Error ? err.message : String(err) };
  }
}

/** Оставить только вставки про это событие: автор — герой, или герой/тема в подписи; не старше окна. */
async function filterEmbeds(t: Topic, list: ResearchEmbed[], pageOk: (from: string) => boolean): Promise<{ kept: ResearchEmbed[]; rejected: number }> {
  const kept: ResearchEmbed[] = [];
  let rejected = 0;
  await Promise.all(list.slice(0, 24).map(async (e) => {
    const v = await verifyEmbed(e);
    const meta = `${v.author ?? ""} ${v.text ?? ""}`;
    const byAuthor = !!v.author && hasHero(t, v.author.replace(/[._]/g, " "));
    const byText = hasHero(t, meta) && (topicHits(t, meta) > 0 || !t.topicStems.length);
    let ok = false;
    let why = "";
    if (!v.ok) {
      // Платформа не ответила: берём только если страница-источник сама про это событие.
      ok = pageOk(e.from);
      why = ok ? `без перевірки, сторінка про подію (${v.note ?? ""})` : `не перевірено (${v.note ?? ""})`;
    } else if (!fresh(t, v.date)) {
      why = `старий пост (${v.date?.slice(0, 10)})`;
    } else if (byAuthor && (topicHits(t, meta) > 0 || pageOk(e.from))) {
      ok = true;
      why = `пост героя${v.author ? ` @${v.author}` : ""}`;
    } else if (byText) {
      ok = true;
      why = `герой і тема в підписі${v.author ? ` (@${v.author})` : ""}`;
    } else if (v.author && !v.text && pageOk(e.from)) {
      ok = true;
      why = `зі сторінки про подію (@${v.author})`;
    } else {
      why = v.author ? `чужий пост @${v.author}, не про подію` : "не про подію";
    }
    if (ok) kept.push({ ...e, author: v.author, text: v.text?.slice(0, 200), why });
    else rejected++;
  }));
  // Пост героя — первым; не больше 4.
  kept.sort((a, b) => Number(/пост героя/.test(b.why ?? "")) - Number(/пост героя/.test(a.why ?? "")));
  return { kept: kept.slice(0, 4), rejected };
}

async function loadTopic(clusterId: string) {
  const c = await prisma.newsCluster.findUniqueOrThrow({ where: { id: clusterId }, select: { projectId: true, title: true, titleUk: true, mainEntityName: true, entities: true, firstPublishedAt: true } });
  const project = await prisma.newsProject.findUniqueOrThrow({ where: { id: c.projectId }, select: { settings: true } });
  return { c, topic: topicOf(c), autoProxy: (project.settings as { autoProxy?: boolean } | null)?.autoProxy !== false };
}

/** Ресёрч по источникам кластера: они про событие по определению, но вставки всё равно проверяются. */
export async function researchCluster(clusterId: string): Promise<ClusterResearch> {
  const [{ topic, autoProxy }, items, proxies] = await Promise.all([
    loadTopic(clusterId),
    prisma.newsItem.findMany({ where: { clusterId }, orderBy: { foundAt: "asc" }, select: { url: true, domain: true, imageUrl: true } }),
    activeProxies(),
  ]);
  const out: ClusterResearch = { images: [], embeds: [], pages: [], at: new Date().toISOString() };
  for (const it of items) if (it.imageUrl && !junk(it.imageUrl)) out.images.push({ url: it.imageUrl, from: it.domain, kind: "feed" });
  const pages = items.filter((x) => !/news\.google\.com/.test(x.url)).slice(0, 8);
  const found: ResearchEmbed[] = [];
  await Promise.all(pages.map(async (p) => {
    const r = await fetchWithProxy(p.url, false, autoProxy, proxies);
    if (!r.ok) {
      out.pages.push({ url: p.url, ok: false, note: r.error ?? `HTTP ${r.status}` });
      return;
    }
    const got = extractFromHtml(r.text, r.finalUrl || p.url, p.domain);
    for (const im of got.images) if (!out.images.some((x) => x.url === im.url)) out.images.push(im);
    for (const e of got.embeds) if (!found.some((x) => x.url === e.url)) found.push(e);
    out.pages.push({ url: p.url, ok: true, note: `${got.images.length} фото, ${got.embeds.length} вставок у тексті`, title: got.title, lead: got.lead, publishedAt: got.publishedAt });
  }));
  const okDomains = new Set(out.pages.filter((p) => p.ok).map((p) => p.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]));
  const f = await filterEmbeds(topic, found, (from) => okDomains.has(from));
  out.embeds = f.kept;
  out.rejected = f.rejected;
  const gn = items.length - pages.length;
  if (gn > 0) out.pages.push({ url: "news.google.com", ok: false, note: `${gn} ссылок через Google News — оригиналы не открывались` });
  out.images = out.images.slice(0, 16);
  await prisma.newsCluster.update({ where: { id: clusterId }, data: { research: out as unknown as Prisma.InputJsonValue, researchAt: new Date() } });
  return out;
}

const SOCIAL_HOST = /instagram\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|facebook\.com|threads\.(net|com)|t\.me|pinterest\.com|reddit\.com|google\.|bing\.|duckduckgo\.|wikipedia\.org|yandex\./i;

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
 * Глубокий ресёрч для избранного: поиск по герою + словам события (укр и англ), только страницы про это событие
 * и не старше окна; вставки из их основного текста, проверенные через oEmbed. Нерелевантные страницы — в журнал.
 */
export async function deepResearch(clusterId: string): Promise<ClusterResearch> {
  const base = await researchCluster(clusterId);
  const { topic, autoProxy } = await loadTopic(clusterId);
  const proxies = await activeProxies();
  // Слова события без имени героя и служебных слов: «Паріс Гілтон хеллоуін імідж волосся», «Paris Hilton halloween hair transformation».
  const words = (src: string) => keyTokens(src).filter((w) => w.length >= 4 && !/['’]/.test(w) && !GENERIC.has(w) && !topic.heroStems.some((h) => stem(w).startsWith(h) || h.startsWith(stem(w)))).slice(0, 4).join(" ");
  const cl = await prisma.newsCluster.findUniqueOrThrow({ where: { id: clusterId }, select: { title: true, titleUk: true } });
  const en = topic.heroEn || (/[a-z]/i.test(cl.title) ? "" : topic.hero);
  const queries = [
    `${topic.hero} ${words(cl.titleUk || cl.title)}`.trim(),
    /[a-z]/i.test(cl.title) ? `${en} ${words(cl.title)}`.trim() : "",
  ].filter((q, i, arr) => q.length > 3 && arr.indexOf(q) === i);
  const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  const known = new Set(base.pages.map((p) => norm(p.url)));
  const urls: string[] = [];
  for (const q of queries) for (const u of await webSearch(q, 8)) if (!known.has(norm(u)) && !urls.some((x) => norm(x) === norm(u))) urls.push(u);
  const extra: ResearchPage[] = [];
  const found: ResearchEmbed[] = [];
  const okDomains = new Set(base.pages.filter((p) => p.ok).map((p) => p.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]));
  await Promise.all(urls.slice(0, 10).map(async (u) => {
    const r = await fetchWithProxy(u, false, autoProxy, proxies);
    const from = u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
    if (!r.ok) {
      extra.push({ url: u, ok: false, note: r.error ?? `HTTP ${r.status}` });
      return;
    }
    const got = extractFromHtml(r.text, r.finalUrl || u, from);
    const rel = pageRelevant(topic, got);
    if (!rel.ok) {
      extra.push({ url: u, ok: false, note: `пошук, пропущено: ${rel.why}`, title: got.title, publishedAt: got.publishedAt });
      return;
    }
    okDomains.add(from);
    for (const im of got.images) if (!base.images.some((x) => x.url === im.url)) base.images.push(im);
    for (const e of got.embeds) if (!found.some((x) => x.url === e.url) && !base.embeds.some((x) => x.url === e.url)) found.push(e);
    extra.push({ url: u, ok: true, note: `пошук, про подію: ${got.images.length} фото, ${got.embeds.length} вставок у тексті`, title: got.title, lead: got.lead, publishedAt: got.publishedAt });
  }));
  const f = await filterEmbeds(topic, found, (from) => okDomains.has(from));
  const embeds = [...base.embeds, ...f.kept].filter((e, i, a) => a.findIndex((x) => x.url === e.url) === i).slice(0, 4);
  const out: ClusterResearch = { ...base, pages: [...base.pages, ...extra], images: base.images.slice(0, 20), embeds, deep: true, queries, rejected: (base.rejected ?? 0) + f.rejected };
  const saved = await prisma.newsCluster.update({ where: { id: clusterId }, data: { research: out as unknown as Prisma.InputJsonValue, researchAt: new Date() }, select: { projectId: true } });
  // Ресёрч бесплатный (поиск и страницы без ИИ), но в «Расходах» виден счётчиком.
  await prisma.newsCost.create({ data: { projectId: saved.projectId, runId: `research:${clusterId}`.slice(0, 64), op: "research", costUsd: 0 } }).catch(() => undefined);
  return out;
}

/** Готовый код вставки по ссылке: штатные embed-коды платформ. */
export function embedCode(e: { kind: EmbedKind; url: string }): string {
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
  if (e.kind === "reddit") {
    return `<blockquote class="reddit-embed-bq" data-embed-height="500"><a href="${u}">${u}</a></blockquote>\n<script async src="https://embed.reddit.com/widgets.js" charset="UTF-8"></script>`;
  }
  return `<a data-pin-do="embedPin" data-pin-width="medium" href="${u}"></a>\n<script async defer src="https://assets.pinterest.com/js/pinit.js"></script>`;
}
