import { LIMITS } from "@/lib/pins/types";

/**
 * Чистые правила для текстов пина (порт из bulk-generate-descriptions,
 * bulk-job-worker.stageTexts и BulkRunWizard.stripAiMentions).
 * Без сети и без Prisma — только строки.
 */

export type PinTexts = { title: string; description: string; altText: string };

/* ------------------------------- обрезка -------------------------------- */

/** Обрезает до max символов по границе слова (если граница не раньше 60% длины). */
export function truncateAtWord(s: string, max: number): string {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = cut.lastIndexOf(" ");
  return (i > max * 0.6 ? cut.slice(0, i) : cut).trim();
}

/* -------------------------------- эмодзи -------------------------------- */

/**
 * Пиктограммы (кроме ©®™), ZWJ, селекторы начертания, модификаторы тона кожи,
 * региональные индикаторы, кейкапы и теги-эмодзи.
 */
const EMOJI_RE = /(?![©®™])\p{Extended_Pictographic}|‍|︎|️|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}]|⃣|[\u{E0020}-\u{E007F}]/gu;

/** Полностью убирает эмодзи и пробелы, оставшиеся после них. */
export function stripEmoji(s: string): string {
  return tidy(String(s || "").replace(EMOJI_RE, ""));
}

/* ----------------------------- упоминания ИИ ----------------------------- */

const B0 = "(?<![\\p{L}\\p{N}_])";
const B1 = "(?![\\p{L}\\p{N}_])";

/**
 * Фразы про генерацию картинок ИИ: английские, русские, украинские.
 * Границы — Unicode-aware (\\b в JS не знает кириллицу).
 */
const AI_MENTION_RE = new RegExp(
  B0 +
    "(?:(?:от|від|from|by|with|via|using)\\s+)?" +
    "(?:" +
    [
      "ai[\\s-]?(?:generated|made|created|art|artwork|image|images|photo|photos|render|rendered)",
      "(?:generated|made|created|rendered)\\s+(?:by|with|using)\\s+(?:an?\\s+)?ai",
      "midjourney",
      "dall[\\s·.-]?e(?:\\s?[23])?",
      "stable\\s+diffusion",
      "нейросет\\p{L}*",
      "нейромереж\\p{L}*",
      "искусственн\\p{L}+\\s+интеллект\\p{L}*",
      "штучн\\p{L}+\\s+інтелект\\p{L}*",
      "сгенерирован\\p{L}*\\s+(?:ии|ai|нейросетью)",
      "згенерован\\p{L}*\\s+(?:ші|ai|нейромережею)",
      "ии",
      "ші",
    ].join("|") +
    ")" +
    B1,
  "giu",
);

/** Только хэштеги буквально про ИИ; #nails, #hair, #braids не трогаем. */
const AI_HASHTAG_RE = new RegExp(
  "#(?:" +
    [
      "ai",
      "ai_?(?:art|artwork|generated|generator|image|images|photo|photos|photography|design|fashion|style|pin|pins)",
      "generatedbyai",
      "madebyai",
      "midjourney(?:art)?",
      "dall_?e",
      "stablediffusion",
      "sdxl",
      "нейросет\\p{L}*",
      "нейромереж\\p{L}*",
      "нейроарт",
      "ии",
      "ші",
      "искусственныйинтеллект",
      "штучнийінтелект",
    ].join("|") +
    ")" +
    B1,
  "giu",
);

/** Схлопывает пробелы, чинит пунктуацию и пустые скобки после вырезания слов. */
function tidy(s: string): string {
  return s
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:)])/g, "$1")
    .replace(/[,;:]+(?=\s*[.!?])/g, "")
    .replace(/\(\s+/g, "(")
    .replace(/([,;:·|–—-])\s*(?:[,;:·|–—-]\s*)+/g, "$1 ")
    .replace(/^[\s,;:·|–—-]+|[\s,;:·|–—-]+$/g, "")
    .trim();
}

/** Убирает из текста любые упоминания того, что картинка сделана ИИ. */
export function stripAiMentions(text: string | null | undefined): string {
  return tidy(String(text || "").replace(AI_HASHTAG_RE, "").replace(AI_MENTION_RE, ""));
}

/* -------------------------------- сезоны -------------------------------- */

export const SEASON_WORD_RE =
  /(?<![\p{L}\p{N}])(?:winter|wintery|wintry|spring|springtime|summer|summertime|fall|autumn|зим\p{L}*|весен\p{L}*|весн\p{L}*|летн\p{L}*|лето|осен\p{L}*|зимов\p{L}*|веснян\p{L}*|літн\p{L}*|літо|осін\p{L}*|herbst\p{L}*|frühling\p{L}*|sommer\p{L}*|invierno|invernal\p{L}*|primavera|verano|otoño|hiver|hivernal\p{L}*|printemps|été|automne|inverno|invernale\p{L}*|estate|autunno|zima|zimow\p{L}*|wiosna|wiosenn\p{L}*|lato|letn\p{L}*|jesień|jesienn\p{L}*|verão|outono)(?![\p{L}\p{N}])/giu;

/** Сезонные слова из любых значений, уникальные без учёта регистра, не больше 3. */
export function seasonalTerms(...values: unknown[]): string[] {
  const found = values.flatMap((value) => String(value ?? "").match(SEASON_WORD_RE) ?? []);
  return [...new Map(found.map((term) => [term.toLocaleLowerCase(), term])).values()].slice(0, 3);
}

function includesTerm(value: string, term: string): boolean {
  return value.toLocaleLowerCase().includes(term.toLocaleLowerCase());
}

/**
 * Гарантирует присутствие всех терминов: недостающие ставятся в начало
 * («winter — …» для заголовка, «winter. …» для описания), чтобы не выпасть при обрезке.
 */
export function requireTerms(text: string, terms: string[], style: "dash" | "sentence" = "dash"): string {
  const t = (text || "").trim();
  const missing = terms.map((x) => x.trim()).filter((x) => x && !includesTerm(t, x));
  if (!missing.length) return t;
  const prefix = `${missing.join(" · ")}${style === "sentence" ? "." : " —"}`;
  return t ? `${prefix} ${t}` : missing.join(" · ");
}

/** Один обязательный сезонный термин (пустое слово — ничего не делает). */
export function ensureSeasonWord(text: string, word: string, style: "dash" | "sentence" = "dash"): string {
  return word.trim() ? requireTerms(text, [word], style) : (text || "").trim();
}

/* -------------------------------- хэштеги -------------------------------- */

const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const TRAILING_TAGS_RE = /(?:\s*#[\p{L}\p{N}_]+)+\s*$/u;

/** Убирает все хэштеги из текста. */
export function stripHashtags(s: string): string {
  return tidy(String(s || "").replace(HASHTAG_RE, ""));
}

/**
 * HASHTAGS=no → полная зачистка «#».
 * HASHTAGS=yes → все теги переносятся в конец, строчными, без повторов, не больше max.
 */
export function normalizeHashtags(desc: string, enabled: boolean, max = 5): string {
  const text = String(desc || "");
  if (!enabled) return stripHashtags(text);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of text.match(HASHTAG_RE) ?? []) {
    const tag = raw.toLocaleLowerCase();
    if (tag.length < 3 || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= max) break;
  }
  const body = stripHashtags(text);
  if (!tags.length) return body;
  return body ? `${body} ${tags.join(" ")}` : tags.join(" ");
}

/** Запасные хэштеги из ключа и доски (строчные, слова длиннее 2 символов, до max). */
export function makeHashtags(keyword: string, board = "", max = 4): string {
  const words = `${keyword || ""} ${board || ""}`
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    tags.push(`#${w}`);
    if (tags.length >= max) break;
  }
  return tags.join(" ");
}

/* --------------------------------- лимиты -------------------------------- */

/**
 * Лимиты Pinterest: title ≤ 100, alt ≤ 490, description ≤ 500 (≤ 350 с хэштегами).
 * Хвост из хэштегов сохраняется целиком — обрезается только текст перед ним.
 */
export function applyLimits(texts: PinTexts, hasHashtags: boolean): PinTexts {
  const title = truncateAtWord(texts.title, LIMITS.title);
  const altText = truncateAtWord(texts.altText, LIMITS.alt);
  const max = hasHashtags ? LIMITS.descriptionWithTags : LIMITS.description;
  const desc = (texts.description || "").trim();
  const m = hasHashtags ? desc.match(TRAILING_TAGS_RE) : null;
  if (!m || m.index === undefined) return { title, description: truncateAtWord(desc, max), altText };
  const tags = m[0].trim();
  const body = desc.slice(0, m.index).trim();
  const room = max - tags.length - 1;
  if (room <= 0) return { title, description: truncateAtWord(tags, max), altText };
  const shortBody = truncateAtWord(body, room);
  return { title, description: shortBody ? `${shortBody} ${tags}` : tags, altText };
}

/* --------------------------- детерминированный выбор --------------------------- */

/** FNV-1a 32-bit: стабильный хэш строки. */
export function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Попадает ли элемент в долю percent (0–100) — стабильно для одного id при повторных запусках. */
export function inShare(id: string, percent: number): boolean {
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  if (p <= 0) return false;
  if (p >= 100) return true;
  return hashId(id) % 100 < p;
}

/** Убирает кавычки и хэштеги из заголовка (Pinterest их не любит, legacy тоже вырезал). */
export function cleanTitle(s: string): string {
  return tidy(stripHashtags(String(s || "").replace(/["«»“”„]/g, "")));
}
