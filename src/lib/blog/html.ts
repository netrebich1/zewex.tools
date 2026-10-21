/**
 * HTML инфо-статьи: вступление → главное фото → ключевые выводы → секции (H2 + фото слота + текст блока) → FAQ →
 * заключение → дисклеймер → последнее фото. Блок фото с подписью источника — из статей (buildImageBlock);
 * таблицам и блоку выводов — инлайн-стили (темы WordPress разные). Внешние ссылки — nofollow.
 */
import { buildImageBlock, dedupeImageBlocks, normalizeArticleHtml, type CaptionCfg, type ImageLike } from "@/lib/articles/text/html";
import { balanceParagraphs } from "@/lib/articles/text/textGuards";
import { countWords, escapeHtml } from "./text";

export const CONCLUSION_HEADING = "Final Thoughts";
export const FAQ_HEADING = "Frequently Asked Questions";
export const TAKEAWAYS_HEADING = "Key Takeaways";

export type AssembleSection = { position: number; kind: string; heading: string; html: string; photo: ImageLike | null };
export type AssembleInput = {
  introHtml: string;
  hero: ImageLike | null;
  takeawaysHtml: string | null;
  sections: AssembleSection[];
  faq: Array<{ question: string; answer: string }>;
  conclusionHtml: string;
  disclaimerHtml: string | null;
  closing: ImageLike | null;
  keyword: string;
  caption: CaptionCfg;
  /** JSON-LD (готовый объект) — вставляется <script type="application/ld+json"> в конец */
  jsonLd?: unknown | null;
};
export type AssembleOutput = { html: string; toc: Array<{ heading: string; anchor: string }>; wordCount: number };

const TABLE_STYLE = 'style="width:100%; border-collapse:collapse; margin:16px 0; font-size:0.95em;"';
const TH_STYLE = 'style="text-align:left; padding:10px 12px; border-bottom:2px solid #e5e5e5; background:#f7f7f7;"';
const TD_STYLE = 'style="padding:10px 12px; border-bottom:1px solid #eee; vertical-align:top;"';

/** Инлайн-стили таблиц и полосатые строки. */
export function styleTables(html: string): string {
  return String(html ?? "")
    .replace(/<table\b[^>]*>/gi, `<table ${TABLE_STYLE}>`)
    .replace(/<th\b([^>]*)>/gi, (_m, a: string) => `<th${a.replace(/\s*style="[^"]*"/i, "")} ${TH_STYLE}>`)
    .replace(/<td\b([^>]*)>/gi, (_m, a: string) => `<td${a.replace(/\s*style="[^"]*"/i, "")} ${TD_STYLE}>`);
}

export function anchorOf(position: number, heading: string): string {
  const base = heading.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return base ? `${base}-${position}` : `section-${position}`;
}

export function takeawaysBlock(html: string): string {
  return `<div class="zx-takeaways" style="margin:20px 0; padding:16px 20px; border-left:4px solid #d9a441; background:#fbf7ee; border-radius:6px;">\n<p style="margin:0 0 8px; font-weight:600;">${TAKEAWAYS_HEADING}</p>\n${html}\n</div>\n`;
}

export function faqBlock(faq: Array<{ question: string; answer: string }>): string {
  if (!faq.length) return "";
  const items = faq.map((f) => `<h3>${escapeHtml(f.question)}</h3>\n${f.answer}`).join("\n");
  return `<h2 id="faq">${FAQ_HEADING}</h2>\n${items}\n`;
}

export function disclaimerBlock(html: string): string {
  return `<div class="zx-disclaimer" style="margin:24px 0 8px; padding:12px 16px; font-size:0.9em; color:#555; background:#f5f5f5; border-radius:6px;">\n${html}\n</div>\n`;
}

export function assemblePostHtml(input: AssembleInput): AssembleOutput {
  const toc: AssembleOutput["toc"] = [];
  const parts: string[] = [];
  let words = 0;
  // Alt — описание кадра от vision-оценки (что на фото), а не заголовок секции; ключ buildImageBlock допишет сам.
  // Alt — описание кадра (что на фото), обрезанное по слову так, чтобы с ключом уложиться в 125 символов.
  const altFor = (p: ImageLike, heading: string) => {
    const base = (p.altText || "").trim().replace(/[.\s]+$/, "") || heading;
    if (base.toLowerCase().includes(input.keyword.toLowerCase())) return base.slice(0, 125);
    const room = Math.max(40, 125 - input.keyword.length - 3);
    return base.length <= room ? base : base.slice(0, room).replace(/\s+\S*$/, "");
  };
  const img = (p: ImageLike, heading: string) => buildImageBlock(p, { heading: altFor(p, heading), keyword: input.keyword, caption: input.caption });

  const intro = balanceParagraphs(input.introHtml);
  words += countWords(intro);
  parts.push(intro);
  if (input.hero?.url) parts.push(img(input.hero, input.keyword));
  if (input.takeawaysHtml?.trim()) { parts.push(takeawaysBlock(input.takeawaysHtml)); words += countWords(input.takeawaysHtml); }

  for (const s of input.sections) {
    const anchor = anchorOf(s.position, s.heading);
    toc.push({ heading: s.heading, anchor });
    let block = `<h2 id="${anchor}">${escapeHtml(s.heading)}</h2>\n`;
    if (s.photo?.url) block += img(s.photo, s.heading);
    const body = balanceParagraphs(styleTables(s.html));
    block += body + "\n";
    words += countWords(s.html);
    parts.push(block);
  }

  if (input.faq.length) {
    toc.push({ heading: FAQ_HEADING, anchor: "faq" });
    parts.push(faqBlock(input.faq));
    words += input.faq.reduce((n, f) => n + countWords(f.question) + countWords(f.answer), 0);
  }
  const conclusion = balanceParagraphs(input.conclusionHtml);
  toc.push({ heading: CONCLUSION_HEADING, anchor: "conclusion" });
  parts.push(`<h2 id="conclusion">${CONCLUSION_HEADING}</h2>\n${conclusion}`);
  words += countWords(conclusion);
  if (input.disclaimerHtml?.trim()) parts.push(disclaimerBlock(input.disclaimerHtml));
  if (input.closing?.url) parts.push(img(input.closing, `${input.keyword} result`));
  if (input.jsonLd) parts.push(`<script type="application/ld+json">${JSON.stringify(input.jsonLd).replace(/<\/script/gi, "<\\/script")}</script>`);

  const html = dedupeImageBlocks(normalizeArticleHtml(parts.join("\n\n")))
    .replace(/<\/p>(\s*)<\/p>/gi, "</p>$1")
    // buildImageBlock и normalizeArticleHtml оба ставят центрирование — оставляем одно
    .replace(/(display:block; margin-left:auto; margin-right:auto;)(\s*display:block; margin-left:auto; margin-right:auto;)+/g, "$1");
  return { html, toc, wordCount: words };
}
