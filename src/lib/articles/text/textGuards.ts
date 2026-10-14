/**
 * Общие защиты текста статьи (порт _shared/textGuards.ts оригинала, имена экспортов сохранены):
 *  • sanitizeTopic — убирает служебные пометки из темы (NEW/OLD/ТЕСТ, «(…)»)
 *  • headingKey / uniqueHeading — уникальные заголовки секций
 *  • looksLikeFactDump / stripLeadingFactDump — текст начинается с перечисления признаков фото
 *  • containsInternalLabel / stripInternalLabels — в тексте осталась служебная пометка
 *  • stripEmphasis — полный запрет выделений
 * Единственная копия для всей цепочки (план, секции, вступление, сборка, публикация) — аудит 03, §8.
 */

// оригинал: _shared/textGuards.ts:9-14
const LABEL_WORDS = [
  "new", "old", "test", "testing", "draft", "copy", "dup", "duplicate", "variant", "version",
  "control", "baseline", "benchmark", "experiment", "temp", "tmp", "debug", "wip",
  "нов", "новые", "новый", "стар", "старые", "старый", "тест", "тестовый", "черновик",
  "копия", "дубль", "вариант", "версия", "проверка", "эксперимент",
];

const LABEL_PREFIX_RE = new RegExp(
  `^\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\))?\\s*(?:${LABEL_WORDS.join("|")})[a-zA-Zа-яА-ЯёЁ]*\\s*[0-9]*\\s*[—–\\-:|>»]+\\s*`,
  "i",
);

/** Убирает служебные пометки: «NEW — Тема (новые настройки)» → «Тема». (оригинал: textGuards.ts:22-50) */
export function sanitizeTopic(input: unknown): string {
  let s = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";

  // Служебные префиксы могут идти цепочкой: «TEST — OLD — Тема»
  for (let i = 0; i < 4; i++) {
    const next = s.replace(LABEL_PREFIX_RE, "").trim();
    if (next === s || !next) break;
    s = next;
  }

  // Хвостовые пояснения в скобках, если внутри служебное слово
  for (let i = 0; i < 3; i++) {
    const m = s.match(/[\(\[]([^\)\]]*)[\)\]]\s*$/);
    if (!m) break;
    const inner = m[1].toLowerCase();
    const isLabel = LABEL_WORDS.some((w) => inner.includes(w));
    if (!isLabel) break;
    s = s.slice(0, m.index).trim();
  }

  // Хвостовые служебные пометки после тире: «Тема — OLD»
  s = s.replace(
    new RegExp(`\\s*[—–\\-|]{1,2}\\s*(?:${LABEL_WORDS.join("|")})[a-zA-Zа-яА-ЯёЁ]*\\s*[0-9]*\\s*$`, "i"),
    "",
  ).trim();

  return s.replace(/^[\s—–\-:|]+/, "").replace(/[\s—–\-:|]+$/, "").trim();
}

// оригинал: textGuards.ts:52-56
const HEADING_STOPWORDS = new Set([
  "nail", "nails", "manicure", "pedicure", "design", "designs", "look", "looks", "idea", "ideas",
  "style", "styles", "set", "sets", "the", "a", "an", "and", "with", "for", "of", "in", "on",
  "your", "this", "that", "very", "super",
]);

/** «Скелет» заголовка: ловит почти-дубли («Vibrant Glossy Red Almond Nails» = «Glossy Red Almond Nails»). (оригинал: textGuards.ts:59-67) */
export function headingKey(heading: unknown): string {
  const words = String(heading ?? "")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-zа-яё0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w && !HEADING_STOPWORDS.has(w));
  return [...new Set(words)].sort().join(" ");
}

// оригинал: textGuards.ts:69-72
const FACT_PRIORITY = [
  "length", "shape", "finish", "color", "colour", "shade", "art", "decor", "details", "detail",
  "technique", "occasion", "season", "vibe", "accent",
];

function factWords(facts: unknown): string[] {
  if (!facts || typeof facts !== "object") return [];
  const f = facts as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = String(v ?? "").replace(/[^a-zA-Zа-яА-ЯёЁ0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
    if (s && s.length <= 40) out.push(s);
  };
  for (const key of FACT_PRIORITY) if (key in f) push(f[key]);
  for (const [k, v] of Object.entries(f)) if (!FACT_PRIORITY.includes(k)) push(v);
  return out;
}

function titleCaseWords(s: string): string {
  return s.replace(/\b([a-zа-яё])/g, (m) => m.toUpperCase());
}

/** Считаем заголовок повтором, если его слова — подмножество уже занятого (или наоборот). (оригинал: textGuards.ts:91-105) */
function isTakenHeading(key: string, used: Set<string>): boolean {
  if (!key) return true;
  if (used.has(key)) return true;
  const words = new Set(key.split(" ").filter(Boolean));
  if (words.size === 0) return true;
  for (const taken of used) {
    const tw = new Set(taken.split(" ").filter(Boolean));
    if (tw.size === 0) continue;
    let shared = 0;
    for (const w of words) if (tw.has(w)) shared++;
    const similarity = shared / Math.max(words.size, tw.size);
    if (shared >= 2 && similarity >= 0.7) return true; // почти-дубль
  }
  return false;
}

/**
 * Возвращает уникальный заголовок: при повторе добавляет отличающийся признак
 * этого фото, а если признаков нет — осмысленный уточнитель. Номеров не добавляем. (оригинал: textGuards.ts:111-156)
 */
export function uniqueHeading(
  heading: string,
  used: Set<string>,
  opts: { facts?: unknown; description?: string | null } = {},
): string {
  const base = String(heading || "").trim() || "Nail Design";
  const key = headingKey(base);
  if (!isTakenHeading(key, used)) {
    used.add(key);
    return base;
  }

  const candidates: string[] = [];
  const words = factWords(opts.facts);
  for (const w of words) {
    if (headingKey(base).includes(headingKey(w))) continue;
    candidates.push(`${titleCaseWords(w)} ${base}`);
    candidates.push(`${base} — ${titleCaseWords(w)}`);
  }
  const desc = String(opts.description || "")
    .split(/[.,;]/)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 40);
  for (const d of desc) candidates.push(`${base} — ${titleCaseWords(d)}`);

  const fallbackQualifiers = [
    "Close-Up Take", "Everyday Version", "Softer Variation", "Bolder Variation",
    "Second Look", "Subtle Twist", "Party Version", "Minimal Version",
    "Weekend Version", "Office-Safe Version", "Statement Version", "Low-Key Version",
  ];
  for (const q of fallbackQualifiers) candidates.push(`${base} — ${q}`);

  for (const c of candidates) {
    const k = headingKey(c);
    if (!isTakenHeading(k, used)) {
      used.add(k);
      return c.replace(/\s+/g, " ").trim();
    }
  }

  // Крайний случай: ключ занимаем, чтобы дальше не плодить дубли
  let attempt = 2;
  while (used.has(`${key} v${attempt}`)) attempt++;
  used.add(`${key} v${attempt}`);
  return base;
}

/** Похоже ли на сырое перечисление признаков фото («shape: long coffin; finish: glossy»). (оригинал: textGuards.ts:159-178) */
export function looksLikeFactDump(text: unknown): boolean {
  const raw = String(text ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return false;
  const head = raw.slice(0, 400);

  // Пары «признак: значение» — два и более
  const pairs = head.match(/\b[a-zA-Zа-яА-ЯёЁ_ ]{3,20}:\s*[^:;.]{2,40}(?:;|,|$)/g) || [];
  if (pairs.length >= 2) return true;

  // Перечисление признаков без глаголов: «Long coffin shape, filed to a sharp point, glossy red»
  const firstSentence = head.split(/(?<=[.!?])\s/)[0] || head;
  if (firstSentence.length > 40 && (firstSentence.match(/,/g) || []).length >= 2) {
    const hasVerbOrVoice = /\b(i|you|we|it|this|these|is|are|was|were|feels?|looks?|reads?|love|hate|keep|works?|wears?|think|swear|admit|will|would|can|don't|doesn't)\b/i
      .test(firstSentence);
    const facty = /\b(shape|shaped|length|finish|glossy|matte|filed|tips?|almond|coffin|square|oval|stiletto|chrome|glitter|nude|french)\b/i
      .test(firstSentence);
    if (!hasVerbOrVoice && facty) return true;
  }
  return false;
}

/** Вырезает ведущее перечисление признаков (первый абзац/предложение). (оригинал: textGuards.ts:181-199) */
export function stripLeadingFactDump(html: unknown): string {
  let s = String(html ?? "");
  for (let i = 0; i < 2; i++) {
    if (!looksLikeFactDump(s)) break;
    const m = s.match(/^\s*<p[^>]*>[\s\S]*?<\/p>\s*/i);
    if (m && s.slice(m[0].length).replace(/<[^>]*>/g, "").trim().length > 60) {
      s = s.slice(m[0].length);
      continue;
    }
    // Без абзацев: убираем первое предложение
    const plainCut = s.replace(/^\s*[^.!?]{20,400}[.!?]\s*/, "");
    if (plainCut !== s && plainCut.replace(/<[^>]*>/g, "").trim().length > 60) {
      s = plainCut;
      continue;
    }
    break;
  }
  return s.trim();
}

/** Осталась ли в тексте служебная пометка или полное название задачи из очереди. (оригинал: textGuards.ts:202-219) */
export function containsInternalLabel(text: unknown, rawTitle?: string | null): boolean {
  const s = String(text ?? "");
  if (!s.trim()) return false;
  const plain = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  if (rawTitle) {
    const raw = String(rawTitle).replace(/\s+/g, " ").trim();
    const clean = sanitizeTopic(raw);
    if (raw && clean && raw.toLowerCase() !== clean.toLowerCase() && plain.toLowerCase().includes(raw.toLowerCase())) {
      return true;
    }
  }

  // Пометка вида «NEW — …» / «(старые настройки)» внутри текста
  if (/\b(NEW|OLD|TEST|DRAFT|COPY)\s*[—–\-|:]\s*\S/.test(plain)) return true;
  if (/\((?:нов|стар|тест)[^)]*настройк[^)]*\)/i.test(plain)) return true;
  return false;
}

/** Убирает служебные вставки из уже готового текста. (оригинал: textGuards.ts:222-234) */
export function stripInternalLabels(html: unknown, rawTitle?: string | null): string {
  let s = String(html ?? "");
  if (rawTitle) {
    const raw = String(rawTitle).trim();
    const clean = sanitizeTopic(raw);
    if (raw && clean && raw.toLowerCase() !== clean.toLowerCase()) {
      s = s.split(raw).join(clean);
    }
  }
  s = s.replace(/\b(NEW|OLD|TEST|DRAFT|COPY)\s*[—–\-|:]\s*/g, "");
  s = s.replace(/\s*\((?:нов|стар|тест)[^)]*настройк[^)]*\)/gi, "");
  return s.replace(/\s{2,}/g, " ").trim();
}

/**
 * Полный запрет выделений в тексте: убирает <strong>/<b>/<em>/<i>/<u>/<mark>
 * и markdown-звёздочки/подчёркивания. Ключевые слова никогда не выделяем. (оригинал: textGuards.ts:240-247)
 */
export function stripEmphasis(html: unknown): string {
  let s = String(html ?? "");
  s = s.replace(/<\/?(?:strong|b|em|i|u|mark)(?:\s[^>]*)?>/gi, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1$2");
  return s;
}

/** Снимает служебные пометки и выделения с текста, идущего в статью (ключ/тема — для поиска сырого названия). */
export function cleanLabelsAndEmphasis(html: unknown, rawTitles: Array<string | null | undefined>): string {
  let s = stripEmphasis(html);
  for (const t of rawTitles) if (t && containsInternalLabel(s, t)) s = stripInternalLabels(s, t);
  return s;
}

/** Слова в тексте без тегов (общий счётчик для секций, вступления, заключения). */
export function countWordsFromHtml(html: unknown): number {
  const text = String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.split(" ").length : 0;
}
