import { safeFetch } from "@/lib/pins/fetch";
import { decodeEntities, imageKey, imgSrc, metaContent, stripScripts } from "@/lib/pins/stages/meta";

/**
 * Фото из статьи по H2-секциям (порт edge-функции extract-article-images,
 * фильтра _shared/authorPhoto.ts и выбора фото из collectAutopilotPhotos).
 * Чистые функции над HTML; сеть — только safeFetch.
 */

export type ArticleImage = {
  url: string;
  alt: string;
  section: string;
  width?: number;
  height?: number;
  /** 0 — первое фото H2-секции (контент), >0 — обычно коллаж/пин/дубль. */
  indexInSection: number;
};

export type ArticleImagesResult = { images: ArticleImage[]; featured?: string; error?: string };

const MAX_SECTIONS = 200;
const FETCH_TIMEOUT_MS = 25_000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* ----------------------------- фото автора ------------------------------ */

const AUTHOR_URL_RE = /(avatar|gravatar|wp-user-avatar|user-photo|userpic|profile-pic|profile-photo|author[-_/]|\/authors?\/)/i;
/** Мелкие квадратные картинки из аплоадов — почти всегда аватар. */
const SMALL_SQUARE_RE = /-(\d{2,3})x\1(?=\.\w+$)/i;

/** Фото автора по URL (аватар, /author/, маленький квадрат ≤300). */
export function isAuthorPhotoUrl(url: string): boolean {
  const clean = url.split("?")[0];
  if (AUTHOR_URL_RE.test(clean)) return true;
  const m = clean.match(SMALL_SQUARE_RE);
  return !!m && Number(m[1]) <= 300;
}

/** Фото автора по тегу <img>: класс, rel=author, квадратные размеры ≤300. */
export function isAuthorPhotoTag(tag: string): boolean {
  if (/\bclass\s*=\s*["'][^"']*(avatar|wp-user-avatar|author|photo\b)/i.test(tag)) return true;
  if (/\brel\s*=\s*["']author["']/i.test(tag)) return true;
  const w = Number(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || 0);
  const h = Number(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || 0);
  return !!w && !!h && w === h && w <= 300;
}

/** Объединённая проверка: по URL и (если передан) по тегу. */
export function isLikelyAuthorPhoto(url: string, tag?: string): boolean {
  return isAuthorPhotoUrl(url) || (!!tag && isAuthorPhotoTag(tag));
}

/** Обрезает хвост страницы с блоком автора/комментариями. */
export function stripAuthorBox(html: string): string {
  const m = html.match(
    /<(?:div|section|footer|aside)[^>]*(?:class|id)\s*=\s*["'][^"']*(author-?(?:box|bio|info|meta)|about-?the-?author|entry-author|post-author)[^"']*["']/i,
  );
  return m && m.index !== undefined ? html.slice(0, m.index) : html;
}

/* ------------------------------- разбор --------------------------------- */

function normalizeHtml(html: string): string {
  return html.replace(/\\+/g, "").replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'");
}

/** Абсолютный URL картинки относительно страницы; "" если не http(s). */
export function absolutizeImage(src: string, pageUrl: string): string {
  const s = decodeEntities(src).trim();
  if (!s) return "";
  if (s.startsWith("//")) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  try {
    return new URL(s, pageUrl).toString();
  } catch {
    return "";
  }
}

function attr(tag: string, name: string): string {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? "";
}

function dimension(tag: string, name: "width" | "height"): number | undefined {
  const v = Number(tag.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i"))?.[1] || 0);
  return v > 0 ? v : undefined;
}

/** Тег <img> не годится: пин-коллаж, карточка товара, иконка, лого, svg, фото автора. */
function skipTag(tag: string, src: string): boolean {
  if (/data-pin-nopin|stl-img|stl-/i.test(tag)) return true;
  if (/(sprite|icon|logo|avatar|emoji|pixel|placeholder|blank|1x1)/i.test(src)) return true;
  if (/\/product-/i.test(src) || /\.svg(\?|$)/i.test(src)) return true;
  return isLikelyAuthorPhoto(src, tag);
}

function isRaster(src: string): boolean {
  return /\.(jpe?g|png|webp|avif)(\?|$)/i.test(src) || /wp-content\/uploads/i.test(src);
}

/** Картинки одного куска HTML в порядке появления (без дедупликации — её делает вызывающий). */
function imagesIn(html: string, pageUrl: string, section: string): ArticleImage[] {
  const out: ArticleImage[] = [];
  let i = 0;
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const src = imgSrc(tag);
    if (!src || skipTag(tag, src) || !isRaster(src)) continue;
    const url = absolutizeImage(src, pageUrl);
    if (!url) continue;
    const img: ArticleImage = { url, alt: decodeEntities(attr(tag, "alt")).slice(0, 300), section, indexInSection: i++ };
    const w = dimension(tag, "width");
    const h = dimension(tag, "height");
    if (w) img.width = w;
    if (h) img.height = h;
    out.push(img);
  }
  return out;
}

/** Только контент после первого H2: выше — hero/интро/похожие записи. */
export function afterFirstH2(html: string): string {
  const m = html.match(/<h2[^>]*>/i);
  return m && m.index !== undefined ? html.slice(m.index) : html;
}

/** Разбор по H2-секциям: фото каждой секции до следующего заголовка (≤10 000 символов). */
export function extractSectionImages(html: string, pageUrl: string, maxSections = MAX_SECTIONS): ArticleImage[] {
  const clean = stripScripts(html);
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const out: ArticleImage[] = [];
  let sections = 0;
  let m: RegExpExecArray | null;
  while ((m = h2Re.exec(clean)) !== null && sections < maxSections) {
    const heading = decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim();
    if (!heading || heading.length < 3) continue;
    const from = m.index + m[0].length;
    const next = clean.slice(from).match(/<h[1-6][^>]*>/i);
    const to = next && next.index !== undefined ? from + next.index : Math.min(from + 10_000, clean.length);
    // карточки товаров (stl-block) не считаем контентом
    const body = clean
      .slice(from, to)
      .replace(/<div[^>]*class="[^"]*stl-block[^"]*"[\s\S]*?(?=<(?:h[1-6]|section|article|footer|header)\b|$)/gi, "");
    const imgs = imagesIn(body, pageUrl, heading.slice(0, 200));
    if (imgs.length) {
      sections++;
      out.push(...imgs);
    }
  }
  return out;
}

/** Запасной сбор: все фото после первого H2 без разбивки по секциям (скрипты не вырезаем — WP прячет тело в JSON). */
export function extractAllImages(html: string, pageUrl: string, section: string): ArticleImage[] {
  const clean = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  return imagesIn(clean, pageUrl, section);
}

/** Дедупликация по ключу без query и размерного суффикса WP, с пересчётом indexInSection внутри секции. */
export function dedupeImages(images: ArticleImage[]): ArticleImage[] {
  const seen = new Set<string>();
  const perSection = new Map<string, number>();
  const out: ArticleImage[] = [];
  for (const img of images) {
    const key = imageKey(img.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const idx = perSection.get(img.section) ?? 0;
    perSection.set(img.section, idx + 1);
    out.push({ ...img, indexInSection: idx });
  }
  return out;
}

/** Миниатюра записи: og:image / twitter:image, абсолютный адрес. */
export function featuredFromHtml(raw: string, pageUrl: string): string {
  const v = metaContent(raw, "og:image") || metaContent(raw, "twitter:image");
  return v ? absolutizeImage(v, pageUrl) : "";
}

/** Разбор уже загруженного HTML (чистая функция для тестов и REST-варианта). */
export function parseArticleImages(raw: string, pageUrl: string, opts: { featuredOnly: boolean; maxSections?: number }): ArticleImagesResult {
  const html = stripAuthorBox(normalizeHtml(raw));
  const featured = featuredFromHtml(raw, pageUrl);
  const title = decodeEntities(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "").trim() || "Untitled Article";
  const max = Math.min(Math.max(1, opts.maxSections ?? MAX_SECTIONS), MAX_SECTIONS);
  let images = dedupeImages(extractSectionImages(html, pageUrl, max));
  if (!images.length) images = dedupeImages(extractAllImages(afterFirstH2(html), pageUrl, title));

  if (opts.featuredOnly) {
    // Сайт рецептов: одна миниатюра записи, иначе первое фото статьи
    const first = featured || images[0]?.url || "";
    const res: ArticleImagesResult = { images: first ? [{ url: first, alt: title, section: "", indexInSection: 0 }] : [] };
    if (featured) res.featured = featured;
    if (!first) res.error = "No images found";
    return res;
  }
  const res: ArticleImagesResult = { images };
  if (featured) res.featured = featured;
  if (!images.length) res.error = "No images found";
  return res;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** HTML статьи с браузерным UA, 3 попытки с паузой; 4xx (кроме 429) не повторяем. */
export async function fetchArticleHtml(url: string, signal?: AbortSignal): Promise<string> {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const res = await safeFetch(url, {
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_HTML_BYTES,
        accept: "text/html,application/xhtml+xml",
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
        signal,
      });
      if (res.ok) return res.body.toString("utf8");
      lastError = `Failed to fetch article (${res.status})`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : "fetch failed";
      if (/Недопустим|Некорректный|приватную|не допускается/.test(lastError)) break;
    }
    if (attempt < 3) await sleep(attempt * 1200, signal);
  }
  throw new Error(lastError || "fetch failed");
}

/** Загружает статью и возвращает её фото по секциям (или одну миниатюру при featuredOnly); ошибки — в поле error. */
export async function extractArticleImages(
  url: string,
  opts: { featuredOnly: boolean; maxSections?: number; signal?: AbortSignal },
): Promise<ArticleImagesResult> {
  try {
    const raw = await fetchArticleHtml(url, opts.signal);
    return parseArticleImages(raw, url, opts);
  } catch (e) {
    return { images: [], error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/* ------------------------------ выбор фото ------------------------------ */

/** Картинки, встречающиеся на ≥minPages страницах и ≥minShare всех страниц — сайтовые (лого, баннеры), не контент. */
export function frequentImages(pagesImages: string[][], minPages = 3, minShare = 0.5): Set<string> {
  const byUrl = new Map<string, number>();
  for (const page of pagesImages) {
    for (const u of new Set(page)) byUrl.set(u, (byUrl.get(u) ?? 0) + 1);
  }
  const total = Math.max(1, pagesImages.length);
  const out = new Set<string>();
  for (const [u, n] of byUrl) if (n >= minPages && n / total >= minShare) out.add(u);
  return out;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Выбор фото страницы как в collectAutopilotPhotos: только первое фото каждой H2-секции,
 * без фото автора и исключённых адресов, случайные `count` штук; результат — в порядке статьи.
 */
export function pickPhotosForPage<T extends ArticleImage>(
  images: T[],
  opts: { count: number; excludeUrls: Set<string>; rng?: () => number },
): T[] {
  const rng = opts.rng ?? Math.random;
  const seen = new Set<string>();
  const content = images.filter((img) => {
    if (img.indexInSection !== 0 || opts.excludeUrls.has(img.url) || isAuthorPhotoUrl(img.url)) return false;
    if (seen.has(img.url)) return false;
    seen.add(img.url);
    return true;
  });
  const take = Math.max(0, Math.min(content.length, Math.floor(opts.count)));
  const chosen = new Set(shuffle(content.map((c) => c.url), rng).slice(0, take));
  return content.filter((c) => chosen.has(c.url));
}
