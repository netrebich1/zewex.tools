/**
 * HTML статьи: блок фото с подписью источника, alt/title/data-pin-description, чистка текста автора,
 * итоговая сборка. Порт stage7-assemble-html/index.ts (buildImageBlock, buildAltText, buildPinDescription,
 * textToHtml, stripImageArtifacts, dedupeImageBlocks, normalizeArticleHtml) и _shared/photoCaption.ts.
 * Один источник правды о фото — ArtPhoto (URL, размеры, источник); текст автора хранится отдельно
 * от собранного HTML (аудит 03, §8).
 */
import { balanceParagraphs, stripEmphasis } from "./textGuards";
import { patchCount } from "./countToken";

// ───────────────────────── подпись источника (оригинал: _shared/photoCaption.ts) ─────────────────────────

export const PHOTO_CREDIT_PREFIXES = ["Photo credit:", "Image credit:", "Source:", "Via", "Courtesy of:"];

export type CaptionMode = "none" | "domain" | "domain_link" | "full_link";
export type CaptionCfg = { mode: CaptionMode; template: string };

export const DEFAULT_CAPTION_TEMPLATE = "{credit} {domain}";

/** Настройка подписи из рецепта поиска фото (оригинал: assemble:71-77). */
export function captionCfgFrom(mode: unknown, template: unknown): CaptionCfg {
  const m = String(mode || "");
  return {
    mode: (["none", "domain", "domain_link", "full_link"].includes(m) ? m : "domain_link") as CaptionMode,
    template: String(template || "").trim() || DEFAULT_CAPTION_TEMPLATE,
  };
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Один из пяти префиксов по хэшу позиции/URL — подписи не выглядят штампованными. (оригинал: photoCaption.ts:17-22) */
export function captionCredit(seed?: string | number | null): string {
  const raw = String(seed ?? "");
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash * 31) + raw.charCodeAt(i)) >>> 0;
  return PHOTO_CREDIT_PREFIXES[hash % PHOTO_CREDIT_PREFIXES.length];
}

export function fillCaptionTemplate(template: string | null | undefined, domain: string, pageUrl: string, seed?: string | number | null): string {
  const tpl = template || DEFAULT_CAPTION_TEMPLATE;
  return tpl
    .replace(/\{credit\}/g, captionCredit(seed || pageUrl || domain))
    .replace(/\{domain\}/g, domain)
    .replace(/\{url\}/g, pageUrl || domain);
}

/** HTML подписи: только домен, домен-ссылка или полный URL (ссылка nofollow noopener noreferrer). (оригинал: photoCaption.ts:37-54) */
export function buildCaptionHtml(template: string | null | undefined, domain: string, pageUrl: string, mode: Exclude<CaptionMode, "none">, seed?: string | number | null): string {
  const label = mode === "full_link" ? (pageUrl || domain) : (domain || pageUrl);
  const text = fillCaptionTemplate(template, label, pageUrl, seed || pageUrl || domain);
  if (mode === "domain" || !pageUrl) return escapeHtml(text);

  const safeUrl = escapeHtml(pageUrl);
  const safeLabel = escapeHtml(label);
  const safeText = escapeHtml(text);
  const linkedLabel = `<a href="${safeUrl}" target="_blank" rel="nofollow noopener noreferrer">${safeLabel}</a>`;
  return safeText.includes(safeLabel) ? safeText.replace(safeLabel, linkedLabel) : `${safeText} ${linkedLabel}`.trim();
}

// ───────────────────────── alt / pin description (оригинал: assemble:440-474) ─────────────────────────

/** Заголовки чужих страниц («… | Who What Wear UK») в alt не допускаются. */
export function looksLikeForeignPageTitle(alt: string): boolean {
  const s = String(alt || "");
  if (!s.trim()) return true;
  if (/[|»]|\s[-–—]\s(?:[A-Z][\w']*\s?){1,4}$/.test(s)) return true;
  if (/\b(?:magazine|vogue|wear|glamour|allure|byrdie|instagram|pinterest|blog|\.com|\.co\.uk)\b/i.test(s)) return true;
  return false;
}

export type ImageLike = {
  url: string;
  width?: number | null;
  height?: number | null;
  sourcePageUrl?: string | null;
  sourceDomain?: string | null;
  /** Готовый alt/описание пина, если уже есть (ArtPhoto.altText / caption) */
  altText?: string | null;
  pinDescription?: string | null;
  position?: number | null;
};

/** Alt: заголовок секции без префикса «N. », иначе alt фото, иначе ключ; ключ дописывается, если его нет; ≤125. */
export function buildAltText(img: ImageLike, heading: string, keyword: string, fallbackNoun = "idea"): string {
  const h = String(heading || "").replace(/^\s*\d+\.\s*/, "").trim();
  const base = h || String(img.altText || "").trim();
  const kw = String(keyword || "").trim();
  let alt = base;
  // Нишевая заглушка оригинала «Nail design idea» заменена на ключ/нейтральное слово (аудит 03, §7.10)
  if (!alt || looksLikeForeignPageTitle(alt)) alt = kw || fallbackNoun;
  if (kw && !alt.toLowerCase().includes(kw.toLowerCase())) alt = `${alt} — ${kw}`;
  return alt.slice(0, 125);
}

export function buildPinDescription(img: ImageLike, heading: string, keyword: string): string {
  const h = String(heading || "").replace(/^\s*\d+\.\s*/, "").trim();
  const kw = String(keyword || "").trim();
  const existing = String(img.pinDescription || "").trim();
  if (existing && !looksLikeForeignPageTitle(existing)) return existing.slice(0, 480);
  const parts = [h, kw ? `${kw} inspiration to save for later` : "Save this idea for later"];
  return parts.filter(Boolean).join(" — ").slice(0, 480);
}

/**
 * Блок фото секции: `[caption]<img …/> <span class="photo-credit">…</span>[/caption]` при подписи,
 * иначе `<figure class="outfit-photo">`. (оригинал: assemble:478-506)
 */
export function buildImageBlock(img: ImageLike, opts: { heading?: string; keyword?: string; caption?: CaptionCfg } = {}): string {
  const heading = String(opts.heading || "");
  const keyword = String(opts.keyword || "");
  const alt = buildAltText(img, heading, keyword);
  const pin = buildPinDescription(img, heading, keyword);
  const title = heading.replace(/^\s*\d+\.\s*/, "").trim() || alt;
  const width = Math.max(1, Number(img.width) || 335);
  const height = Number(img.height) > 0 ? Number(img.height) : null;
  const dimensions = ` width="${width}"${height ? ` height="${height}"` : ""}`;
  const image = `<img src="${escapeHtml(img.url)}" alt="${escapeHtml(alt)}" title="${escapeHtml(title)}" data-pin-description="${escapeHtml(pin)}" loading="lazy"${dimensions} style="display:block; margin-left:auto; margin-right:auto;" />`;
  const sourceUrl = String(img.sourcePageUrl || "").trim();
  const domain = String(img.sourceDomain || "").trim() || (sourceUrl.match(/^https?:\/\/([^/]+)/i)?.[1] || "").replace(/^www\./i, "");

  const mode = opts.caption?.mode || "domain_link";
  const template = opts.caption?.template || DEFAULT_CAPTION_TEMPLATE;
  if (mode !== "none" && (sourceUrl || domain)) {
    const body = buildCaptionHtml(template, domain || sourceUrl, sourceUrl, mode, img.position || sourceUrl);
    const credit = `<span class="photo-credit" style="font-size:12px; color:#777; font-weight:400;">${body}</span>`;
    return `[caption id="" align="alignnone" width="${width}"]${image} ${credit}[/caption]\n`;
  }

  return `<figure class="outfit-photo" style="text-align:center; margin-left:auto; margin-right:auto;">\n  ${image}\n</figure>\n`;
}

// ───────────────────────── текст автора ─────────────────────────

/** Фенсы markdown и выделения — вон. (оригинал: assemble:417-427) */
export function stripMarkdown(text: unknown): string {
  return stripEmphasis(String(text ?? "").replace(/```(?:html)?\s*/gi, "").replace(/```/g, ""));
}

/** Абзацы из текста: уже HTML — как есть, иначе разбиение по пустым строкам с экранированием. (оригинал: assemble:410-415) */
export function textToHtml(text: string | null | undefined): string {
  if (!text) return "";
  const clean = stripMarkdown(String(text).trim());
  if (/<(?:p|ul|ol|blockquote)\b/i.test(clean)) return clean;
  return clean.split(/\n\s*\n/).filter(Boolean).map((p) => `<p>${escapeHtml(p.trim())}</p>`).join("\n");
}

/**
 * Единая пост-обработка текста из модели: снять выделения, обернуть «голые» строки в <p>, снять выделения ещё раз.
 * Объединяет три postProcessHtml оригинала (72:606, 73:2025, 74:368 — последняя добавляла <b>, это ошибка; аудит 03, §7.7).
 */
export function cleanArticleHtml(text: unknown): string {
  if (!text) return "";
  let html = stripEmphasis(String(text).trim());
  if (!/<(?:p|div|h[1-6]|ul|ol|li|table|figure|blockquote)[\s>]/i.test(html)) {
    html = html.split(/\n\n+/).filter(Boolean).map((p) => `<p>${p.replace(/\n/g, " ").trim()}</p>`).join("\n");
  } else {
    // Строки вне тегов (модель смешала HTML и голый текст)
    html = html.replace(/^([^<\n].+)$/gm, (match) => {
      const trimmed = match.trim();
      if (!trimmed || /^</.test(trimmed)) return match;
      return `<p>${trimmed}</p>`;
    });
  }
  return stripEmphasis(html);
}

/** Следы прошлой сборки в тексте секции: <figure>, [caption], photo-credit, <img>, <h2>. (оригинал: assemble:366-372, 200-202) */
export function stripImageArtifacts(text: string): string {
  return String(text || "")
    .replace(/<h2[^>]*>[\s\S]*?<\/h2>\s*/gi, "")
    .replace(/<figure[^>]*>[\s\S]*?<\/figure>\s*/gi, "")
    .replace(/\[caption\b[^\]]*\][\s\S]*?\[\/caption\]\s*/gi, "")
    .replace(/<span class="photo-credit"[\s\S]*?<\/span>\s*/gi, "")
    .replace(/<img\b[^>]*>\s*/gi, "");
}

/** Одна и та же картинка дважды подряд — оставляем первую. (оригинал: assemble:376-389) */
export function dedupeImageBlocks(html: string): string {
  const seen = new Set<string>();
  return String(html || "").replace(
    /(?:\[caption\b[^\]]*\][\s\S]*?\[\/caption\]|<figure[^>]*>[\s\S]*?<\/figure>)\s*/gi,
    (block) => {
      const src = (block.match(/<img[^>]*\ssrc="([^"]+)"/i) || [])[1] || "";
      if (!src) return block;
      if (seen.has(src)) return "";
      seen.add(src);
      return block;
    },
  );
}

function mergeStyle(tag: string, required: string): string {
  if (/\sstyle\s*=\s*["']/i.test(tag)) {
    return tag.replace(/\sstyle\s*=\s*(["'])(.*?)\1/i, (_m, quote: string, value: string) => {
      const suffix = String(value).trim().replace(/;?$/, ";");
      return ` style=${quote}${suffix} ${required}${quote}`;
    });
  }
  return tag.replace(/>$/, ` style="${required}">`);
}

/** Все внешние ссылки — доноры: target=_blank rel=nofollow noopener noreferrer; якоря не трогаем. (оригинал: assemble:519-526) */
export function normalizeExternalLinks(html: string): string {
  return String(html || "").replace(/<a\b[^>]*\bhref\s*=\s*(["'])https?:\/\/[^"']+\1[^>]*>/gi, (tag) => {
    const next = tag
      .replace(/\srel\s*=\s*(["']).*?\1/gi, "")
      .replace(/\starget\s*=\s*(["']).*?\1/gi, "");
    return next.replace(/>$/, ' target="_blank" rel="nofollow noopener noreferrer">');
  });
}

/** Темы WordPress разные — центрирование фото и безопасность донорских ссылок задаём инлайн. (оригинал: assemble:528-532) */
export function normalizeArticleHtml(html: string): string {
  return normalizeExternalLinks(String(html || ""))
    .replace(/<figure\b[^>]*>/gi, (tag) => mergeStyle(tag, "text-align:center; margin-left:auto; margin-right:auto;"))
    .replace(/<img\b[^>]*>/gi, (tag) => mergeStyle(tag, "display:block; margin-left:auto; margin-right:auto;"));
}

// ───────────────────────── итоговая сборка ─────────────────────────

/** Заголовок заключения — жёстко, как в оригинале (assemble:272). */
export const OUTRO_HEADING = "Final Thoughts";

export type AssembleSection = {
  position: number;
  heading: string;
  /** Текст автора (только <p>/<ul>/<li>) */
  html: string;
  photo: ImageLike | null;
};

export type AssembleInput = {
  introHtml: string;
  outroHtml: string;
  sections: AssembleSection[];
  keyword: string;
  caption: CaptionCfg;
  /** Фактическое число фото — подставляется вместо {{COUNT}} и «живых» чисел */
  count: number;
};

export type AssembleOutput = { html: string; toc: Array<{ heading: string; anchor: string; level: number }>; wordCount: number };

/**
 * Порядок: вступление → секции по позиции (H2 + фото + текст автора как есть) → «Final Thoughts» + заключение.
 * Число идей везде подставляется patchCount. (оригинал: assemble:142-279)
 */
export function assembleArticleHtml(input: AssembleInput): AssembleOutput {
  const fix = (t: unknown) => patchCount(String(t ?? ""), input.count);
  const toc: AssembleOutput["toc"] = [];
  const parts: string[] = [];
  let words = 0;
  const countWords = (h: string) => h.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;

  // Парность <p> на каждом блоке и на итоговом HTML: никаких </p></p> (аудит text-v2, bubble bob).
  const intro = balanceParagraphs(textToHtml(fix(input.introHtml)));
  words += countWords(intro);
  parts.push(intro);

  for (const s of input.sections) {
    const anchor = `outfit-${s.position}`;
    const h2 = fix(s.heading) || `${s.position}. Idea`;
    let writerText = stripMarkdown(fix(s.html));
    writerText = balanceParagraphs(stripImageArtifacts(writerText).trim());
    toc.push({ heading: h2, anchor, level: 2 });
    let block = `<h2 id="${anchor}">${escapeHtml(h2)}</h2>\n`;
    if (s.photo?.url) block += buildImageBlock(s.photo, { heading: h2, keyword: input.keyword, caption: input.caption });
    block += writerText + "\n";
    words += countWords(writerText);
    parts.push(block);
  }

  const outro = balanceParagraphs(textToHtml(fix(input.outroHtml)));
  words += countWords(outro);
  toc.push({ heading: OUTRO_HEADING, anchor: "conclusion", level: 2 });
  parts.push(`<h2 id="conclusion">${OUTRO_HEADING}</h2>\n${outro}`);

  const html = dedupeImageBlocks(normalizeArticleHtml(parts.join("\n\n"))).replace(/<\/p>(\s*)<\/p>/gi, "</p>$1");
  return { html, toc, wordCount: words };
}
