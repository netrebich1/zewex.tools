/**
 * Статья по адресу: заголовок, текст для модели и фото тела статьи (прямые публичные ссылки — их же отдаём Metricool).
 * Загрузка и разбор фото — общие с сервисом пинов.
 */
import { extractBodyImages, fetchArticleHtml } from "@/lib/pins/stages/photos";
import { stripHtml } from "@/lib/pins/wp/client";
import type { ArticleImageRef } from "./types";

export type Article = { title: string; description: string; text: string; lang: string; images: ArticleImageRef[] };

const meta = (html: string, name: string): string => {
  const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0] ?? "";
  return stripHtml(tag.match(/content\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/content\s*=\s*'([^']*)'/i)?.[1] ?? "").trim();
};

/** Текст статьи: от H1 (или <article>) до подвала, заголовки H2/H3 помечены, без скриптов и стилей. */
export function articleText(html: string): string {
  // Сначала только то, что не текст; <header> не трогаем — в нём у многих тем лежит H1 статьи.
  let body = html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const h1 = body.search(/<h1[\s>]/i);
  const art = body.search(/<article[\s>]/i);
  body = body.slice(h1 >= 0 ? h1 : art >= 0 ? art : 0);
  const end = body.search(/<footer[\s>]|<(?:div|section|aside)[^>]*(?:class|id)\s*=\s*["'][^"']*(related|comments|comment-respond|sidebar|author-box|newsletter|read-next|post-nav)[^"']*["']/i);
  if (end > 1500) body = body.slice(0, end);
  body = body.replace(/<(form|nav|aside|button|figcaption)\b[\s\S]*?<\/\1>/gi, " ");
  body = body
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|ul|ol|blockquote|figure|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return stripHtml(body.replace(/\n/g, "\u0001"))
    .replace(/\u0001/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

const BAD_IMAGE = /(logo|avatar|gravatar|favicon|sprite|emoji|placeholder|[-_/]banner|[-_/]ads?[-_/]|pixel|1x1)/i;

export async function loadArticle(url: string, signal?: AbortSignal): Promise<Article> {
  const html = await fetchArticleHtml(url, signal);
  const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").trim();
  const title = h1 || meta(html, "og:title") || stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const seen = new Set<string>();
  const images: ArticleImageRef[] = [];
  const push = (u: string, alt: string) => {
    const clean = u.split("#")[0];
    if (!/^https?:\/\//i.test(clean) || seen.has(clean) || BAD_IMAGE.test(clean) || /\.(svg|gif)(\?|$)/i.test(clean)) return;
    seen.add(clean);
    images.push({ url: clean, alt: alt.trim().slice(0, 300) });
  };
  const og = meta(html, "og:image");
  for (const im of extractBodyImages(html, url)) {
    // Мелкие картинки (иконки, смайлы) в пост не годятся; без размеров в разметке — берём.
    if ((im.width && im.width < 400) || (im.height && im.height < 300)) continue;
    push(im.url, im.alt);
  }
  // Миниатюра записи — запасной вариант, если в теле статьи фото нет.
  if (!images.length && og) push(og, title);
  return {
    title,
    description: meta(html, "og:description") || meta(html, "description"),
    text: articleText(html).slice(0, 14_000),
    lang: (html.match(/<html[^>]*\blang\s*=\s*["']([a-zA-Z-]{2,10})["']/i)?.[1] ?? "").toLowerCase(),
    images,
  };
}
