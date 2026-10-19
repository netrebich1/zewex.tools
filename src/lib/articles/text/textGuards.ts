/**
 * Общие защиты текста статьи (порт _shared/textGuards.ts оригинала, имена экспортов сохранены):
 *  • sanitizeTopic — убирает служебные пометки из темы (NEW/OLD/ТЕСТ, «(…)»)
 *  • headingKey / uniqueHeading — уникальные заголовки секций
 *  • looksLikeFactDump / stripLeadingFactDump — текст начинается с перечисления признаков фото
 *  • containsInternalLabel / stripInternalLabels — в тексте осталась служебная пометка
 *  • stripEmphasis — полный запрет выделений
 * Единственная копия для всей цепочки (план, секции, вступление, сборка, публикация) — аудит 03, §8.
 */
import { sanitizeFacts } from "@/lib/articles/photo/factSanitize";

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

// оригинал: textGuards.ts:52-56 — там были только «ногтевые» слова; добавлены общие слова ниш (одежда, волосы, интерьер),
// иначе слова ключа (jeans, skirt, cut, bob…) считались отличительными и почти любые два H2 статьи выглядели дублями (аудит 2026-10-14).
const HEADING_STOPWORDS = new Set([
  "nail", "nails", "manicure", "pedicure", "design", "designs", "look", "looks", "idea", "ideas",
  "style", "styles", "set", "sets", "the", "a", "an", "and", "with", "for", "of", "in", "on",
  "your", "this", "that", "very", "super",
  "outfit", "outfits", "wear", "wearing", "styling", "hair", "hairstyle", "hairstyles", "haircut", "haircuts",
  "room", "rooms", "decor", "inspo", "inspiration", "to", "try", "best", "cute", "easy",
]);

/** Предел длины H2: длиннее — обрезаем по границе слова (склейки «признак + заголовок» давали 80–100 символов). */
export const MAX_HEADING_CHARS = 70;

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

/**
 * Слова ключа статьи как стоп-слова сравнения: «Wolf Cut With Curtain Bangs» и «Wolf Cut For Thick Hair» отличаются
 * только хвостом, общие «wolf cut» дублем не делают. Передаётся в uniqueHeading через opts.keyword.
 */
export function keywordStopwords(keyword: unknown): Set<string> {
  return new Set(headingKey(keyword).split(" ").filter(Boolean));
}

/** Слова ключа сравнения без стоп-слов ключа; если не осталось ничего — исходные слова (заголовок из одного ключа тоже уникален). */
function significantWords(key: string, stop: Set<string>): Set<string> {
  const all = key.split(" ").filter(Boolean);
  const rest = all.filter((w) => !stop.has(w));
  return new Set(rest.length ? rest : all);
}

/** Обрезать заголовок до `max` символов по границе слова, без висящих союзов/предлогов и тире на конце. */
export function capHeading(heading: string, max = MAX_HEADING_CHARS): string {
  let s = String(heading ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  s = s.slice(0, max + 1).replace(/\s+\S*$/, "");
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/[\s,;:—–\-&+]+$/, "").replace(/\s+(?:and|or|with|for|of|in|on|to|the|a|an|&)$/i, "");
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

// оригинал: textGuards.ts:69-72
const FACT_PRIORITY = [
  "length", "shape", "shape_length", "finish", "color", "colour", "colors", "shade", "art", "decor", "details", "detail",
  "technique", "bangs", "texture", "silhouette", "accent",
];

/**
 * Поля фактов, которые не годятся в хвост H2: оценка исполнения, сложность, кадр, повод и «что заметно первым» —
 * это мнение о кадре, а не признак дизайна («…, Salon-Leaning», «…, One Hand», «…, The Single Detail…»).
 */
const NO_TAIL_FACTS = new Set(["craft", "difficulty", "framing", "standout", "occasion", "description_facts", "healed", "size_feel"]);
/** Хвост H2 — только короткое описание признака: без «none/any», без «/ | +», без связок-обрывков. */
const BAD_TAIL_RE = /[/|+&]|\b(?:none|n\/?a|any|unknown|visible|not|no)\b/i;

function factWords(facts: unknown): string[] {
  // Заглушки и копии описаний полей схемы (аудит text-v3: «Milky White Pearl Chrome Almond Nails, None»,
  // «Soft Pink French Almonds, The Single Detail A Reader Notices First») отсеиваются до выбора хвоста.
  const f = sanitizeFacts(facts);
  if (!f) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    const raw = String(v ?? "").trim();
    if (!raw || BAD_TAIL_RE.test(raw)) return;
    // Только первая часть перечня: «shimmer, high gloss» → «shimmer»
    const first = raw.split(/[,;]/)[0];
    const s = first.replace(/[^a-zA-Zа-яА-ЯёЁ0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
    if (s && s.length <= 40 && s.split(" ").length <= 5) out.push(s);
  };
  for (const key of FACT_PRIORITY) if (key in f && !NO_TAIL_FACTS.has(key)) push(f[key]);
  for (const [k, v] of Object.entries(f)) if (!FACT_PRIORITY.includes(k) && !NO_TAIL_FACTS.has(k)) push(v);
  return out;
}

function titleCaseWords(s: string): string {
  return s.replace(/\b([a-zа-яё])/g, (m) => m.toUpperCase());
}

/**
 * Считаем заголовок повтором, если его слова — подмножество уже занятого (или наоборот). (оригинал: textGuards.ts:91-105)
 * Слова ключа статьи (`stop`) из сравнения выбрасываются с обеих сторон, поэтому множество `used` можно заполнять
 * обычным headingKey без знания ключа.
 */
function isTakenHeading(key: string, used: Set<string>, stop: Set<string> = new Set()): boolean {
  if (!key) return true;
  if (used.has(key)) return true;
  const words = significantWords(key, stop);
  if (words.size === 0) return true;
  for (const taken of used) {
    const tw = significantWords(taken, stop);
    if (tw.size === 0) continue;
    let shared = 0;
    for (const w of words) if (tw.has(w)) shared++;
    const similarity = shared / Math.max(words.size, tw.size);
    if (similarity === 1 || (shared >= 2 && similarity >= 0.7)) return true; // дубль или почти-дубль
  }
  return false;
}

/**
 * Возвращает уникальный заголовок: при повторе добавляет хвост через запятую (не тире — аудит text-v2) с отличающимся признаком этого фото
 * (никогда не в начало: «Black Pointed-Toe Heels Professional Plaid…» — аудит 2026-10-14), а если признаков нет
 * или хвост делает H2 длиннее предела — осмысленный уточнитель. Номеров не добавляем. Результат ≤ MAX_HEADING_CHARS.
 * `keyword` — ключ статьи: его слова не считаются отличительными при сравнении. (оригинал: textGuards.ts:111-156)
 */
export function uniqueHeading(
  heading: string,
  used: Set<string>,
  opts: { facts?: unknown; description?: string | null; keyword?: string | null } = {},
): string {
  const base = capHeading(String(heading || "").trim() || "Nail Design");
  const stop = keywordStopwords(opts.keyword);
  const key = headingKey(base);
  if (!isTakenHeading(key, used, stop)) {
    used.add(key);
    return base;
  }

  // Слова сравниваются без окончания -s («Almonds» и «Short Almond» — повтор).
  const stem = (w: string) => w.replace(/(?:es|s)$/, "");
  const baseWords = new Set(headingKey(base).split(" ").filter(Boolean).map(stem));
  // Хвост годится, если не повторяет слов заголовка и не делает его длиннее предела.
  const tailOk = (tail: string) => {
    const tw = headingKey(tail).split(" ").filter(Boolean);
    return tw.length > 0 && !tw.some((w) => baseWords.has(stem(w))) && `${base}, ${tail}`.length <= MAX_HEADING_CHARS;
  };
  const candidates: string[] = [];
  for (const w of factWords(opts.facts)) {
    const tail = titleCaseWords(w);
    if (tailOk(tail)) candidates.push(`${base}, ${tail}`);
  }
  // Из описания — только короткие признаки, не целые предложения («…, The Finish Is Glossy» — аудит text-v3).
  const desc = String(opts.description || "")
    .split(/[.,;]/)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 40 && !/\b(?:is|are|was|were|has|have|shows?|features?|sits?|reads?|creates?|adds?|gives?)\b/i.test(s))
    // и не про кадр: фон, рука, свет, поза, одежда в кадре («…, Slightly Textured Background»)
    .filter((s) => !/\b(?:background|backdrop|hand|hands|finger|fingers|light|lighting|lit|posed?|shot|photo|image|frame|framed|sweater|sleeve|ring|rings|surface|fabric)\b/i.test(s));
  for (const d of desc) {
    const tail = titleCaseWords(d);
    if (tailOk(tail)) candidates.push(`${base}, ${tail}`);
  }

  const fallbackQualifiers = [
    "Close-Up Take", "Everyday Version", "Softer Variation", "Bolder Variation",
    "Second Look", "Subtle Twist", "Party Version", "Minimal Version",
    "Weekend Version", "Office-Safe Version", "Statement Version", "Low-Key Version",
  ];
  // Длинный заголовок укорачиваем, чтобы уточнитель влез в предел.
  for (const q of fallbackQualifiers) candidates.push(`${capHeading(base, MAX_HEADING_CHARS - q.length - 2)}, ${q}`);

  for (const c of candidates) {
    const k = headingKey(c);
    if (!isTakenHeading(k, used, stop)) {
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
    const hasVerbOrVoice = /\b(i|you|we|it|this|these|is|are|was|were|feels?|looks?|reads?|love|hate|keep|works?|wears?|think|swear|admit|will|would|can|don't|doesn't|choose|pick|go|ask|apply|try|use|opt|add|avoid|skip|start|book|pair|let|make|get|give|take|save|swap|tuck|consider|stick|aim|reach|bring|treat|protect)\b/i
      .test(firstSentence);
    const facty = /\b(shape|shaped|length|finish|glossy|matte|filed|tips?|almond|coffin|square|oval|stiletto|chrome|glitter|nude|french)\b/i
      .test(firstSentence);
    if (!hasVerbOrVoice && facty) return true;
  }
  return false;
}

/**
 * Вырезает ведущее перечисление признаков (первый абзац/предложение). (оригинал: textGuards.ts:181-199)
 * Первое предложение режется ВНУТРИ первого <p>, открывающий тег сохраняется (раньше регулярка срезала его вместе
 * с предложением и оставалась сирота </p> — аудит 2026-10-14, italian bob); на выходе абзацы всегда парные.
 */
export function stripLeadingFactDump(html: unknown): string {
  let s = String(html ?? "");
  for (let i = 0; i < 2; i++) {
    if (!looksLikeFactDump(s)) break;
    const m = s.match(/^\s*<p[^>]*>[\s\S]*?<\/p>\s*/i);
    if (m && s.slice(m[0].length).replace(/<[^>]*>/g, "").trim().length > 60) {
      s = s.slice(m[0].length);
      continue;
    }
    // Один абзац или текст без абзацев: убираем первое предложение, не трогая открывающий <p>
    const plainCut = s.replace(/^(\s*(?:<p[^>]*>)?)\s*[^.!?<]{20,400}[.!?]\s*/i, "$1");
    if (plainCut !== s && plainCut.replace(/<[^>]*>/g, "").trim().length > 60) {
      s = plainCut.replace(/^(\s*(?:<p[^>]*>)?\s*)([a-zа-яё])/, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
      continue;
    }
    break;
  }
  return balanceParagraphs(s.trim());
}

const BLOCK_TAG_RE = /<\/?(?:h[1-6]|ul|ol|li|div|figure|figcaption|table|blockquote|section|img|hr)\b/i;

/**
 * Страховка парности <p>…</p>: сирота </p> без открытия — текст перед ней оборачивается в <p> (или тег убирается,
 * если текста нет), незакрытый <p> закрывается перед следующим <p> и в конце, висячий текст между абзацами — в <p>.
 * Блочные элементы (заголовки, списки, figure) не трогаются.
 */
export function balanceParagraphs(html: unknown): string {
  const src = String(html ?? "");
  if (!/<\/?p\b/i.test(src)) return src;
  const re = /<(\/?)p\b[^>]*>/gi;
  let out = "";
  let open = false;
  let last = 0;
  let segStart = 0; // начало «висячего» текста в out (после последнего закрытого абзаца)
  const wrapLoose = () => {
    const loose = out.slice(segStart);
    if (loose.replace(/<[^>]*>/g, "").trim() && !BLOCK_TAG_RE.test(loose)) {
      out = `${out.slice(0, segStart)}<p>${loose.trim()}</p>`;
    }
  };
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out += src.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[1]) {
      if (open) {
        out += m[0];
        open = false;
      } else wrapLoose(); // сирота </p>
      segStart = out.length;
    } else {
      if (open) out += "</p>";
      else wrapLoose();
      out += m[0];
      open = true;
    }
  }
  out += src.slice(last);
  if (open) out += "</p>";
  else wrapLoose();
  return out;
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
