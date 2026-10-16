import { safeFetch } from "@/lib/pins/fetch";

/**
 * Title / H1 / число контентных фото и H2-секций с фото (порт edge-функции bulk-extract-meta).
 * Чистые функции над HTML; сеть — только через safeFetch.
 */

export type PageMeta = {
  title: string;
  h1: string;
  imageCount: number;
  sectionImageCount: number;
  lang?: string;
  ogImage?: string;
  error?: string;
};

const CONCURRENCY = 6;
const TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Раскодирует частые HTML-сущности. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;|&rsquo;/gi, "’")
    .replace(/&#8211;|&ndash;/gi, "–")
    .trim();
}

/** Убирает теги и схлопывает пробелы. */
export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

const SRC_ATTRS = [
  /\bdata-lazy-src\s*=\s*["']([^"']+)["']/i,
  /\bdata-src\s*=\s*["']([^"']+)["']/i,
  /\bdata-original\s*=\s*["']([^"']+)["']/i,
  /\bdata-srcset\s*=\s*["']([^"']+)["']/i,
  /\bsrcset\s*=\s*["']([^"']+)["']/i,
  /\ssrc\s*=\s*["']([^"']+)["']/i,
];

/** Реальный URL картинки из тега: lazy-атрибуты важнее плейсхолдера в src. */
export function imgSrc(tag: string): string {
  for (const re of SRC_ATTRS) {
    const v = tag.match(re)?.[1]?.trim();
    if (!v) continue;
    const first = v.split(",")[0].trim().split(/\s+/)[0];
    if (first && !/^data:/i.test(first)) return first;
  }
  return "";
}

/** Контентное фото: не иконка/лого/плейсхолдер, растровый формат или аплоад WP. */
export function isContentImg(tag: string): boolean {
  const src = imgSrc(tag);
  if (!src || /^data:/i.test(src)) return false;
  if (/(sprite|icon|logo|avatar|emoji|pixel|placeholder|blank|1x1)/i.test(src)) return false;
  return /\.(jpe?g|png|webp|avif)(\?|$)/i.test(src) || /wp-content\/uploads/i.test(src);
}

/** Ключ дедупликации: без query и без размерного суффикса WP (-1024x572). */
export function imageKey(src: string): string {
  return src.split("?")[0].replace(/-\d{2,4}x\d{2,4}(?=\.\w+$)/i, "");
}

function countIn(clean: string): { imageCount: number; sectionImageCount: number } {
  const imgTags = clean.match(/<img\b[^>]*>/gi) || [];
  const seen = new Set<string>();
  let imageCount = 0;
  for (const tag of imgTags) {
    if (!isContentImg(tag)) continue;
    const key = imageKey(imgSrc(tag));
    if (seen.has(key)) continue;
    seen.add(key);
    imageCount++;
  }
  // Секции только по H2: считаем те, где есть хотя бы одно контентное фото
  const headingRe = /<h2\b[^>]*>/gi;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(clean)) !== null) positions.push(m.index);
  let sectionImageCount = 0;
  for (let i = 0; i < positions.length; i++) {
    const block = clean.slice(positions[i], i + 1 < positions.length ? positions[i + 1] : clean.length);
    const tags = block.match(/<img\b[^>]*>/gi) || [];
    if (tags.some(isContentImg)) sectionImageCount++;
  }
  return { imageCount, sectionImageCount };
}

/** Контент может быть вшит в JSON (экранированные кавычки/слэши) — считаем в обоих вариантах, берём максимум. */
export function countImages(raw: string): { imageCount: number; sectionImageCount: number } {
  const a = countIn(raw);
  const unescaped = raw
    .replace(/\\u003C/gi, "<")
    .replace(/\\u003E/gi, ">")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/");
  const b = unescaped === raw ? a : countIn(unescaped);
  return {
    imageCount: Math.max(a.imageCount, b.imageCount),
    sectionImageCount: Math.max(a.sectionImageCount, b.sectionImageCount),
  };
}

/** Удаляет <script> и <style>. */
export function stripScripts(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
}

/** Значение <meta property|name="..." content="..."> в любом порядке атрибутов. */
export function metaContent(html: string, name: string): string {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1];
  const b = a ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${n}["']`, "i"))?.[1];
  return decodeEntities(b ?? "");
}

/** Разбор уже загруженного HTML страницы (чистая функция, удобно для тестов). */
export function parsePageMeta(html: string): PageMeta {
  const clean = stripScripts(html);
  const titleMatch = clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogTitle = metaContent(clean, "og:title");
  const h1Match = clean.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = stripTags(titleMatch?.[1] || ogTitle || "").slice(0, 300);
  const h1 = stripTags(h1Match?.[1] || "").slice(0, 300);
  const { imageCount, sectionImageCount } = countImages(clean);
  const lang = clean.match(/<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]{2,10})/i)?.[1]?.toLowerCase();
  const ogImage = metaContent(clean, "og:image") || metaContent(clean, "twitter:image");
  const meta: PageMeta = { title, h1, imageCount, sectionImageCount };
  if (lang) meta.lang = lang;
  if (ogImage) meta.ogImage = ogImage;
  if (!title && !h1) meta.error = "No title/h1 found";
  return meta;
}

async function fetchMeta(url: string, signal?: AbortSignal): Promise<PageMeta> {
  try {
    const res = await safeFetch(url, {
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_HTML_BYTES,
      accept: "text/html,application/xhtml+xml",
      headers: { "User-Agent": BROWSER_UA },
      signal,
    });
    if (!res.ok) return { title: "", h1: "", imageCount: 0, sectionImageCount: 0, error: `HTTP ${res.status}` };
    return parsePageMeta(res.body.toString("utf8"));
  } catch (e) {
    return { title: "", h1: "", imageCount: 0, sectionImageCount: 0, error: e instanceof Error ? e.message : "fetch failed" };
  }
}

/** Загружает страницы (6 параллельно, 20 с) и возвращает мета по каждому URL; при отмене необработанные URL в карту не попадают. */
export async function extractMeta(
  urls: string[],
  opts: { signal?: AbortSignal; concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, PageMeta>> {
  const list = Array.from(new Set(urls.map((u) => String(u || "").trim()).filter(Boolean)));
  const out = new Map<string, PageMeta>();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? CONCURRENCY, list.length || 1));
  let cursor = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (cursor < list.length) {
      if (opts.signal?.aborted) return;
      const u = list[cursor++];
      out.set(u, await fetchMeta(u, opts.signal));
      done++;
      opts.onProgress?.(done, list.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
