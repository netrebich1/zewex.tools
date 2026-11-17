/**
 * Подпись источника под фото статьи (порт _shared/photoCaption.ts + buildCaption из photoSearch.ts:621-627).
 * Режимы из сценария (`photoSearch.captionMode`): none — без подписи, domain — текст,
 * domain_link — текст со ссылкой на страницу-источник (nofollow). Шаблон: {credit} {domain} {url}.
 */
import type { PhotoSearchConfig } from "@/lib/articles/types";

/** оригинал: photoCaption.ts:1-7 */
export const PHOTO_CREDIT_PREFIXES = ["Photo credit:", "Image credit:", "Source:", "Via", "Courtesy of:"];

export function escapeCaptionHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Детерминированный выбор префикса по seed (оригинал: :17-22). */
export function captionCredit(seed?: string | number | null): string {
  const raw = String(seed ?? "");
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash * 31) + raw.charCodeAt(i)) >>> 0;
  return PHOTO_CREDIT_PREFIXES[hash % PHOTO_CREDIT_PREFIXES.length];
}

export function fillCaptionTemplate(template: string | null | undefined, domain: string, pageUrl: string, seed?: string | number | null): string {
  const tpl = template || "{credit} {domain}";
  return tpl
    .replace(/\{credit\}/g, captionCredit(seed || pageUrl || domain))
    .replace(/\{domain\}/g, domain)
    .replace(/\{url\}/g, pageUrl || domain);
}

/** оригинал: photoCaption.ts:37-55 */
export function buildCaptionHtml(
  template: string | null | undefined,
  domain: string,
  pageUrl: string,
  mode: "domain" | "domain_link" | "full_link",
  seed?: string | number | null,
): string {
  const label = domain || pageUrl;
  const text = fillCaptionTemplate(template, label, pageUrl, seed || pageUrl || domain);
  if (mode === "domain" || !pageUrl) return escapeCaptionHtml(text);

  const safeUrl = escapeCaptionHtml(pageUrl);
  const safeLabel = escapeCaptionHtml(label);
  const safeText = escapeCaptionHtml(text);
  const linkedLabel = `<a href="${safeUrl}" target="_blank" rel="nofollow noopener noreferrer">${safeLabel}</a>`;
  return safeText.includes(safeLabel) ? safeText.replace(safeLabel, linkedLabel) : `${safeText} ${linkedLabel}`.trim();
}

/** Хост страницы без www (оригинал: photoSearch.ts:264-272). */
export function hostOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Подпись под фото по настройкам сценария (оригинал: photoSearch.ts:621-627). null — без подписи. */
export function buildCaption(cfg: Pick<PhotoSearchConfig, "captionMode" | "captionTemplate">, domain: string | null, pageUrl: string | null): string | null {
  if (cfg.captionMode === "none") return null;
  const dom = domain || hostOf(pageUrl) || "";
  const tpl = cfg.captionTemplate || "{credit} {domain}";
  if (cfg.captionMode === "domain") return fillCaptionTemplate(tpl, dom, pageUrl || dom, pageUrl || dom);
  return buildCaptionHtml(tpl, dom, pageUrl || "", "domain_link", pageUrl || dom);
}
