/**
 * Текстовые помощники инфо-статей: чистка HTML секции до разрешённых тегов, таблицы с <thead>, подсчёт слов,
 * короткие сводки для промтов. Тире, американское написание и парность <p> — общие функции статей (polish.ts).
 */
import { polishHtml, type PolishOpts } from "@/lib/articles/text/polish";
import { balanceParagraphs } from "@/lib/articles/text/textGuards";
import type { BlogBrief, BlogOutline, OutlineSection } from "./types";

export function countWords(html: unknown): number {
  return String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").split(/\s+/).filter(Boolean).length;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Markdown-фенсы и «мысли» вон; **жирный** → <strong> (метки «Tip:» модели иногда пишут маркдауном). */
export function markdownToHtmlLite(text: string): string {
  let s = String(text ?? "").replace(/```(?:html)?\s*/gi, "").replace(/```/g, "");
  s = s.replace(/\*\*([^*\n]{1,80})\*\*/g, "<strong>$1</strong>");
  return s;
}

/**
 * Оставить только разрешённые теги: прочие теги снимаются (текст остаётся), атрибуты у разрешённых удаляются
 * (кроме <a href> при allowLinks). Заголовки <h2> внутри секции → <h3>, <h1>/<h4+> → <h3> или <p>.
 */
export function sanitizeHtml(html: string, allowed: string[], opts: { allowLinks?: boolean } = {}): string {
  const allow = new Set(allowed.map((t) => t.toLowerCase()));
  if (allow.has("strong")) allow.add("b");
  let s = markdownToHtmlLite(html);
  // Заголовки: h2 → h3 (внутри секции H2 — заголовок секции), h1/h4-h6 → h3 если разрешён, иначе p
  s = s.replace(/<\/?h[1-6]\b[^>]*>/gi, (tag) => {
    const closing = tag.startsWith("</");
    const to = allow.has("h3") ? "h3" : "p";
    return closing ? `</${to}>` : `<${to}>`;
  });
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (whole, name: string, attrs: string) => {
    const n = name.toLowerCase();
    const closing = whole.startsWith("</");
    if (n === "br") return " ";
    if (!allow.has(n)) {
      if (n === "a" && opts.allowLinks) {
        if (closing) return "</a>";
        const href = (attrs.match(/href\s*=\s*"([^"]+)"/i) || attrs.match(/href\s*=\s*'([^']+)'/i))?.[1] ?? "";
        return /^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener noreferrer">` : "";
      }
      return "";
    }
    const out = n === "b" ? "strong" : n;
    if (closing) return `</${out}>`;
    if (n === "td" || n === "th") {
      const span = attrs.match(/colspan\s*=\s*"?(\d+)"?/i)?.[1];
      return span ? `<${out} colspan="${span}">` : `<${out}>`;
    }
    return `<${out}>`;
  });
  s = s.replace(/<p>\s*<\/p>/gi, "").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** У каждой таблицы — <thead> с первой строкой-заголовком (ячейки <th>). Таблица без строк удаляется. */
export function ensureTableHead(html: string): string {
  return String(html ?? "").replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner: string) => {
    if (/<thead\b/i.test(inner)) return `<table>${inner}</table>`;
    const rows: string[] = inner.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
    const first = rows[0];
    if (!first) return "";
    const head = first.replace(/<td\b([^>]*)>/gi, "<th$1>").replace(/<\/td>/gi, "</th>");
    const body = rows.slice(1).join("\n");
    return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  });
}

/** Таблицы без тела (только заголовок) и пустые списки — вон. */
export function dropEmptyStructures(html: string): string {
  return String(html ?? "")
    .replace(/<table\b[^>]*>(?:(?!<tr)[\s\S])*?<\/table>/gi, "")
    .replace(/<(ul|ol)>\s*<\/\1>/gi, "");
}

/** «Голые» строки вне тегов → абзацы (когда модель смешала HTML и текст). */
export function wrapBareLines(html: string): string {
  const s = String(html ?? "").trim();
  if (!/<(?:p|ul|ol|table|h3|div)\b/i.test(s)) {
    return s.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p.replace(/\n/g, " ")}</p>`).join("\n");
  }
  return s.replace(/^([^<\n][^\n]*)$/gm, (m) => (/^\s*$/.test(m) ? m : `<p>${m.trim()}</p>`));
}

/** Полная чистка текста секции: markdown → теги, разрешённые теги, таблицы с <thead>, полировка, парность <p>. */
export function cleanSectionHtml(raw: string, allowed: string[], pol: PolishOpts, opts: { allowLinks?: boolean } = {}): string {
  let s = wrapBareLines(sanitizeHtml(raw, allowed, opts));
  s = ensureTableHead(s);
  s = dropEmptyStructures(s);
  s = polishHtml(s, pol);
  return balanceParagraphs(s).trim();
}

/** Модель вернула JSON или рассуждения вместо текста. */
export function looksLikeJunk(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return true;
  if (/^[{[]/.test(t) && /"(?:html|sections|position)"\s*:/.test(t)) return true;
  if (/\b(?:as an ai|i cannot|i can't help|let me think|we need to write|the user wants)\b/i.test(t.slice(0, 300))) return true;
  return false;
}

/** Первые N слов текста без тегов. */
export function firstWords(html: unknown, n = 40): string {
  return String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, n).join(" ");
}

/* ───────── Сводки для промтов ───────── */

export function briefShort(b: BlogBrief | null): string {
  if (!b) return "No research brief.";
  const lines: string[] = [];
  lines.push(`Intent: ${b.intent}. Topic domain: ${b.topicDomain}. Audience: ${b.audience}. ${b.ymyl ? "HEALTH/SAFETY-SENSITIVE TOPIC (YMYL): careful wording, no diagnoses, recommend a professional where appropriate." : ""}`.trim());
  if (b.summary) lines.push(`Summary: ${b.summary}`);
  if (b.facts?.length) lines.push(`Facts (confidence in brackets; use only high/medium, phrase low-confidence ones as possibilities):\n${b.facts.map((f) => `- ${f.text} [${f.confidence}]`).join("\n")}`);
  if (b.dos?.length) lines.push(`Do: ${b.dos.join("; ")}`);
  if (b.donts?.length) lines.push(`Don't: ${b.donts.join("; ")}`);
  if (b.mistakes?.length) lines.push(`Common mistakes: ${b.mistakes.join("; ")}`);
  if (b.safety?.length) lines.push(`Safety: ${b.safety.join("; ")}`);
  if (b.materials?.length) lines.push(`Materials/tools: ${b.materials.join("; ")}`);
  if (b.timeline) lines.push(`Timeline: ${b.timeline}`);
  return lines.join("\n");
}

export function articleMap(o: BlogOutline | null, sections?: Array<{ position: number; kind: string; heading: string; status?: string }>): string {
  const list = sections?.length ? sections : (o?.sections ?? []).map((s) => ({ position: s.position, kind: s.kind, heading: s.heading }));
  return list.map((s) => `${s.position}. [${s.kind}] ${s.heading}${"status" in s && s.status === "written" ? " (written)" : ""}`).join("\n");
}

export function sectionBriefText(s: OutlineSection, allowed: string[], hasImage: boolean): string {
  const lines = [
    `SECTION ${s.position} — "${s.heading}"`,
    `  BLOCK: ${s.kind}`,
    `  TARGET LENGTH: ${Math.round(s.targetWords * 0.85)}-${Math.round(s.targetWords * 1.15)} words`,
    `  ALLOWED HTML: ${allowed.map((t) => `<${t}>`).join(" ")} (no other tags, no <h2>, no markdown)`,
    `  KEY POINTS TO COVER:\n${(s.keyPoints ?? []).map((k) => `    - ${k}`).join("\n")}`,
  ];
  if (s.notes) lines.push(`  NOTES: ${s.notes}`);
  if (hasImage) lines.push(`  PHOTO: a real photo illustrating this section appears right under the heading. Never write "in the photo", "pictured above" or describe the image.`);
  return lines.join("\n");
}
