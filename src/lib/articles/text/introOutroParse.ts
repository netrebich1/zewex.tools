/**
 * Устойчивый разбор ответа модели для вступления и заключения (порт _shared/introOutroParse.ts оригинала
 * + normalizeIntroParagraphs из stage7-write-intro). Модели часто отдают JSON с реальными переносами строк
 * внутри строковых значений — строгий JSON.parse на таком падает. Здесь несколько уровней восстановления
 * + извлечение полей регулярками как последний рубеж.
 */

export interface IntroOutroPayload {
  intro_html: string;
  outro_html: string;
  faq_html: string;
  faq_items: Array<{ question: string; answer: string }>;
  h2_heading: string | null;
  parse_mode: "json" | "repaired" | "fields";
}

const INTRO_KEYS = ["intro_html", "intro_text", "intro", "html", "text", "content"];
const OUTRO_KEYS = ["outro_html", "outro_text", "outro", "conclusion_html", "conclusion"];
const FAQ_KEYS = ["faq_html", "faq", "faq_section_html"];

/** Похоже ли, что в секцию попал сырой JSON-ответ модели, а не HTML. (оригинал: introOutroParse.ts:20-25) */
export function looksLikeRawJson(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (/^[{\[]/.test(t)) return true;
  return /"(?:intro_html|outro_html|faq_html|intro_text|outro_text|html_content|sections)"\s*:/.test(t);
}

/**
 * Похоже ли на черновой поток мыслей модели («We need to write an intro… P1 hook… Let's draft»).
 * Такой текст никогда не может попасть в статью. (оригинал: introOutroParse.ts:31-56)
 */
export function looksLikeModelThinking(text: string): boolean {
  const plain = String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return false;
  const head = plain.slice(0, 1200);

  const strong = [
    /\b(?:we|i)\s+(?:need|have)\s+to\s+(?:write|produce|craft|draft|output|return)\b/i,
    /\blet(?:'|’)?s\s+(?:draft|write|start|begin|do)\b/i,
    /\bi(?:'|’)?ll\s+(?:draft|write|now|start|produce)\b/i,
    /\b(?:the\s+)?(?:user|prompt|instructions?|task)\s+(?:says?|asks?|wants?|requires?|specifies?)\b/i,
    /\bword\s*count\s*[:=]/i,
    /\b(?:P1|P2|P3)\s*[:\-—]\s*(?:hook|intro|body|promise|close)/i,
    /\baccording to the (?:brief|prompt|instructions)\b/i,
    /\boutput\s+(?:must|should)\s+be\s+json\b/i,
    /\bnow\s+(?:write|produce)\s+the\s+(?:intro|conclusion|json)\b/i,
  ];
  if (strong.some((re) => re.test(head))) return true;

  // Слабые признаки: срабатываем только при двух и более
  const weak = [
    /\bhook\b/i, /\bconclusion\b.*\bmust\b/i, /\bjson\b/i, /\bplaceholder\b/i,
    /\bavoid\s+(?:em\s*dash|clich)/i, /\bmax(?:imum)?\s+\d+\s+words\b/i,
    /\bkeep\s+it\s+under\s+\d+\s+words\b/i, /\btone\s*[:=]/i,
  ];
  return weak.filter((re) => re.test(head)).length >= 2;
}

function stripFences(raw: string): string {
  let s = (raw || "").trim();
  const fence = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fence) s = fence[1].trim();
  return s.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
}

/** Экранирует «сырые» переносы строк и табы внутри строковых значений JSON. */
export function escapeRawNewlinesInStrings(src: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of src) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += ch === "\t" ? "\\t" : "\\n";
      continue;
    }
    out += ch;
  }
  return out;
}

function tryParse(s: string): unknown | null {
  try { return JSON.parse(s); } catch { return null; }
}

/** Достаёт строковое значение поля даже из невалидного JSON. (оригинал: introOutroParse.ts:88-111) */
export function extractStringField(raw: string, key: string): string {
  const start = raw.search(new RegExp(`"${key}"\\s*:\\s*"`));
  if (start === -1) return "";
  const valueStart = raw.indexOf('"', raw.indexOf(":", start) + 1) + 1;
  let i = valueStart;
  let escaped = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (escaped) { escaped = false; i++; continue; }
    if (ch === "\\") { escaped = true; i++; continue; }
    if (ch === '"') {
      // Конец значения: дальше должна идти запятая/закрывающая скобка либо новый ключ.
      const rest = raw.slice(i + 1, i + 40);
      if (/^\s*(,|\}|$)/.test(rest)) break;
    }
    i++;
  }
  const rawValue = raw.slice(valueStart, i);
  try {
    return JSON.parse(`"${escapeRawNewlinesInStrings(rawValue).replace(/"/g, '\\"').replace(/\\\\"/g, '\\"')}"`) as string;
  } catch {
    return rawValue.replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  }
}

function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const nested = o.html || o.text || o.intro_text || o.outro_text;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return "";
}

export function normalizeFaqItems(input: unknown): Array<{ question: string; answer: string }> {
  if (!Array.isArray(input)) return [];
  return input
    .map((it) => {
      const o = (it ?? {}) as Record<string, unknown>;
      return { question: String(o.question || o.q || "").trim(), answer: String(o.answer || o.a || "").trim() };
    })
    .filter((it) => it.question && it.answer);
}

/** Парсит FAQ из HTML: h3/h4/strong-вопрос + следующий абзац. */
export function parseFaqItemsFromHtml(faqHtml: string): Array<{ question: string; answer: string }> {
  if (!faqHtml) return [];
  const items: Array<{ question: string; answer: string }> = [];
  const strip = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const re = /<(h[234]|strong|b)[^>]*>([\s\S]*?)<\/\1>\s*([\s\S]*?)(?=<(?:h[234]|strong|b)[^>]*>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(faqHtml)) !== null) {
    const question = strip(m[2]);
    const answer = strip(m[3]);
    if (question && answer) items.push({ question, answer });
  }
  if (items.length) return items;
  const lines = strip(faqHtml).split(/(?<=\?)\s+/).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i += 2) {
    if (lines[i].endsWith("?")) items.push({ question: lines[i], answer: lines[i + 1] });
  }
  return items;
}

/**
 * Разбирает ответ модели в блоки. Бросает ошибку, если не удалось получить ни вступления,
 * ни заключения — чтобы шаг повторился, а не записал мусор. (оригинал: introOutroParse.ts:160-231)
 */
export function parseIntroOutroResponse(rawContent: string): IntroOutroPayload {
  const raw = stripFences(rawContent || "");
  if (!raw) throw new Error("Пустой ответ модели для вступления/заключения");

  let parsed = tryParse(raw);
  let mode: IntroOutroPayload["parse_mode"] = "json";

  if (!parsed) {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    const subset = first !== -1 && last > first ? raw.slice(first, last + 1) : raw;
    parsed =
      tryParse(escapeRawNewlinesInStrings(subset)) ||
      tryParse(escapeRawNewlinesInStrings(subset).replace(/,\s*([}\]])/g, "$1"));
    if (parsed) mode = "repaired";
  }

  let intro = "";
  let outro = "";
  let faqHtml = "";
  let faqItems: Array<{ question: string; answer: string }> = [];
  let h2: string | null = null;

  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    intro = pick(p, INTRO_KEYS);
    outro = pick(p, OUTRO_KEYS);
    faqHtml = pick(p, FAQ_KEYS);
    const faq = p.faq as Record<string, unknown> | undefined;
    faqItems = normalizeFaqItems(p.faq_items || faq?.faq_items || p.faqs);
    h2 = (typeof p.h2_heading === "string" ? p.h2_heading : typeof p.heading === "string" ? p.heading : null);
  }

  if (!intro || (!outro && /"outro_(?:html|text)"\s*:/.test(raw))) {
    mode = "fields";
    intro = intro || INTRO_KEYS.map((k) => extractStringField(raw, k)).find((v) => v) || "";
    outro = outro || OUTRO_KEYS.map((k) => extractStringField(raw, k)).find((v) => v) || "";
    faqHtml = faqHtml || FAQ_KEYS.map((k) => extractStringField(raw, k)).find((v) => v) || "";
  }

  // Если это не JSON вовсе — считаем весь текст вступлением, но только если он
  // не похож на JSON и не является черновыми размышлениями модели.
  if (!intro && !outro && !faqHtml && !looksLikeRawJson(raw)) {
    if (looksLikeModelThinking(raw)) {
      throw new Error(
        "Модель вернула черновые размышления вместо текста статьи — шаг повторяется. Начало: " +
          raw.slice(0, 200).replace(/\s+/g, " "),
      );
    }
    intro = raw;
  }

  if (!faqItems.length && faqHtml) faqItems = parseFaqItemsFromHtml(faqHtml);

  intro = intro.trim();
  outro = outro.trim();
  faqHtml = faqHtml.trim();

  if (looksLikeRawJson(intro) || looksLikeRawJson(outro)) {
    throw new Error("Не удалось разобрать ответ модели: в тексте остался сырой JSON");
  }
  if (looksLikeModelThinking(intro) || looksLikeModelThinking(outro)) {
    throw new Error("Модель вернула черновые размышления вместо текста статьи — шаг повторяется");
  }
  if (!intro && !outro) {
    throw new Error(
      "Не удалось извлечь вступление/заключение из ответа модели. Начало ответа: " +
        raw.slice(0, 300).replace(/\s+/g, " "),
    );
  }

  return { intro_html: intro, outro_html: outro, faq_html: faqHtml, faq_items: faqItems, h2_heading: h2, parse_mode: mode };
}

export function countWords(html: string): number {
  return (html || "").replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;
}

/**
 * Модель иногда отдаёт вступление без <p> или одним блоком. Приводим к ровно двум абзацам,
 * не меняя текст — падать из-за вёрстки нельзя. (оригинал: stage7-write-intro/index.ts:13-42)
 */
export function normalizeIntroParagraphs(html: string): string {
  const raw = String(html || "").trim();
  if (!raw) return raw;

  let chunks: string[] = [];
  const pMatches = raw.match(/<p[^>]*>[\s\S]*?<\/p>/gi);
  if (pMatches && pMatches.length > 0) {
    chunks = pMatches.map((p) => p.replace(/<\/?p[^>]*>/gi, "").trim()).filter(Boolean);
  } else {
    chunks = raw
      .replace(/<br\s*\/?>/gi, "\n")
      .split(/\n\s*\n|\n/)
      .map((s) => s.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);
  }
  if (chunks.length === 0) return raw;

  if (chunks.length === 1) {
    const sentences = chunks[0].match(/[^.!?]+[.!?]+(\s|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];
    if (sentences.length >= 2) {
      const half = Math.ceil(sentences.length / 2);
      chunks = [sentences.slice(0, half).join(" "), sentences.slice(half).join(" ")];
    }
  } else if (chunks.length > 2) {
    const half = Math.ceil(chunks.length / 2);
    chunks = [chunks.slice(0, half).join(" "), chunks.slice(half).join(" ")];
  }

  return chunks.map((c) => `<p>${c}</p>`).join("\n");
}
