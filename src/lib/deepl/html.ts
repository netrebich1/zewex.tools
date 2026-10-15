/**
 * Чистые функции конвейера DeepL Articler: нарезка HTML, защита ссылок/картинок/шорткодов служебными тегами
 * <x-ph i="N">, кавычки и вёрстка, контроль целостности, проверка фрагментов, SEO-ключи.
 * Перенесено из article-jumble-maker supabase/functions/_shared/pipeline.ts (строки 34–819, 1101–1120) почти без изменений.
 */

/* ---------------- HTML chunking ---------------- */

const VOID_TAGS = new Set([
  "img", "br", "hr", "input", "meta", "link", "source", "col", "area", "base", "embed", "track", "wbr",
]);

/** Split html into top-level block segments without breaking tags. */
export function splitTopLevelBlocks(html: string): string[] {
  const segments: string[] = [];
  const tagRe = /<\/?([a-zA-Z][\w:-]*)([^>]*)>/g;
  let depth = 0;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const name = m[1].toLowerCase();
    const isClosing = m[0].startsWith("</");
    const selfClosing = m[2].trim().endsWith("/") || VOID_TAGS.has(name);
    if (selfClosing) {
      if (depth === 0) {
        segments.push(html.slice(start, m.index + m[0].length));
        start = m.index + m[0].length;
      }
      continue;
    }
    if (isClosing) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        segments.push(html.slice(start, m.index + m[0].length));
        start = m.index + m[0].length;
      }
    } else {
      depth++;
    }
  }
  if (start < html.length) segments.push(html.slice(start));
  return segments.filter((s) => s.length > 0);
}

/**
 * Разбивает статью на батчи по H2-секциям (по умолчанию 3 секции в батче).
 * Нужно для финальной редактуры: маленькие батчи модель реально правит,
 * а не «пересказывает» целиком.
 */
export function chunkBySections(html: string, perChunk = 3, maxChars = 9000): string[] {
  const idx: number[] = [];
  const re = /<h2\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) idx.push(m.index);
  if (idx.length < 2) return chunkHtml(html, Math.min(maxChars, 5000));

  const sections: string[] = [];
  if (idx[0] > 0) sections.push(html.slice(0, idx[0]));
  for (let i = 0; i < idx.length; i++) {
    sections.push(html.slice(idx[i], i + 1 < idx.length ? idx[i + 1] : html.length));
  }

  const chunks: string[] = [];
  let buf = "";
  let count = 0;
  for (const s of sections) {
    if (buf && (count >= perChunk || (buf + s).length > maxChars)) {
      chunks.push(buf);
      buf = "";
      count = 0;
    }
    buf += s;
    count++;
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [html];
}

/** Group top-level blocks into chunks of at most maxChars characters. */
export function chunkHtml(html: string, maxChars = 6000): string[] {

  const blocks = splitTopLevelBlocks(html);
  const chunks: string[] = [];
  let buf = "";
  for (const b of blocks) {
    if (b.length > maxChars) {
      if (buf) { chunks.push(buf); buf = ""; }
      // hard-split oversized single block on paragraph boundaries as a last resort
      let rest = b;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf("</p>", maxChars);
        if (cut < maxChars * 0.3) cut = maxChars;
        else cut += 4;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      if (rest) chunks.push(rest);
      continue;
    }
    if ((buf + b).length > maxChars && buf) {
      chunks.push(buf);
      buf = b;
    } else {
      buf += b;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [html];
}

/* ---------------- Placeholder protection ---------------- */

export interface Protected {
  text: string;
  tokens: string[];
}

const PROTECT_PATTERNS: RegExp[] = [
  /<script[\s\S]*?<\/script>/gi,
  /<style[\s\S]*?<\/style>/gi,
  /<iframe[\s\S]*?<\/iframe>/gi,
  // ссылка защищается ЦЕЛИКОМ вместе с текстом анкора: ни перевод, ни модель
  // не могут её разорвать, переставить или потерять
  /<a\b[^>]*>[\s\S]*?<\/a\s*>/gi,
  /<img\b[^>]*>/gi,
  /\[\/?[a-zA-Z][^\]\n]{0,200}\]/g, // wp shortcodes
];


/** Плейсхолдер — настоящий HTML-тег: его не трогает ни DeepL (ignore_tags), ни модель. */
export const PH_RE = /<x-ph\s+i="(\d+)"\s*>\s*<\/x-ph>|<x-ph\s+i="(\d+)"\s*\/?>/gi;
const LEGACY_PH_RE = /\[\s*\[\s*\[\s*P\s*(\d+)\s*\]\s*\]\s*\]/g;

export function phToken(i: number): string {
  return `<x-ph i="${i}"></x-ph>`;
}

export function protectHtml(html: string): Protected {
  const tokens: string[] = [];
  let text = html;
  for (const re of PROTECT_PATTERNS) {
    text = text.replace(re, (match) => {
      tokens.push(match);
      return phToken(tokens.length - 1);
    });
  }
  return { text, tokens };
}

/** Тексты анкоров (href → текст) из защищённых токенов — для согласования контекста. */
export function anchorsFromTokens(tokens: string[]): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const t of tokens) {
    const m = t.match(/^<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>$/i);
    if (!m) continue;
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) out.push({ href: m[1], text });
  }
  return out;
}


/**
 * Чинит [caption]…[/caption]: модель/перевод часто разрывает блок абзацами,
 * из-за чего закрывающий шорткод превращается в отдельный маленький абзац.
 */
export function repairCaptions(html: string): string {
  let out = html;
  // закрывающий шорткод, оторванный в свой абзац
  out = out.replace(/<p[^>]*>\s*(\[\/caption\])\s*<\/p>/gi, "$1");
  // открывающий шорткод, обёрнутый в собственный абзац
  out = out.replace(/<p[^>]*>\s*(\[caption\b[^\]]*\])\s*<\/p>/gi, "$1");
  // внутренности блока: одна строка, без абзацев, <br> и пустот
  out = out.replace(/\[caption\b[^\]]*\][\s\S]*?\[\/caption\]/gi, (block) => {
    const open = block.match(/^\[caption\b[^\]]*\]/i)?.[0] ?? "";
    let inner = block.slice(open.length).replace(/\[\/caption\]\s*$/i, "");
    inner = inner
      .replace(/<\/?p[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    // между картинкой и подписью — ровно один пробел, после открытия — ничего
    inner = inner.replace(/(<img\b[^>]*>)\s*/i, "$1 ").trim();
    if (/^<img\b/i.test(inner)) inner = inner.replace(/^(<img\b[^>]*>)\s?/i, "$1 ");
    return `${open}${inner}[/caption]`;
  });
  return out;
}


/* ---------------- Санитайзер верстки и кавычек ---------------- */

const QUOTE_STYLES: Record<string, [string, string]> = {
  UK: ["«", "»"], RU: ["«", "»"], BG: ["«", "»"], BE: ["«", "»"], EL: ["«", "»"],
  FR: ["«", "»"], ES: ["«", "»"], PT: ["«", "»"], IT: ["«", "»"],
  DE: ["„", "“"], PL: ["„", "”"], CS: ["„", "“"], SK: ["„", "“"], HU: ["„", "”"],
  LT: ["„", "“"], LV: ["„", "“"], ET: ["„", "“"], RO: ["„", "”"], SL: ["„", "“"],
};
const ALL_OPEN = `«»„“”"‘’'`;

/** Приводит кавычки к типу целевого языка и удаляет пустые/висящие пары. */
export function normalizeQuotes(html: string, lang?: string | null): string {
  const L = (lang || "").toUpperCase().split("-")[0];
  const [open, close] = QUOTE_STYLES[L] || ['"', '"'];
  return mapTextNodes(html, (t) => {
    let s = t;
    // пустые пары кавычек любого вида: «», " ", „“ …
    s = s.replace(new RegExp(`[${ALL_OPEN}]\\s*[${ALL_OPEN}]`, "g"), "");
    // парные кавычки с содержимым → стиль целевого языка (без скобок шорткодов внутри)
    s = s.replace(/[«„“"”]\s*([^«»„“”"\[\]<>]{1,120}?)\s*[»“”"]/g, (_m, inner) => `${open}${inner}${close}`);
    // одиночная висящая кавычка перед знаком препинания или в конце
    s = s.replace(new RegExp(`[${ALL_OPEN}]\\s*(?=[.,;:!?)]|$)`, "g"), "");
    return s;
  });
}

/**
 * Чинит кавычки вокруг ссылок: модель часто «оборачивает» анкор в кавычки,
 * и закрывающая приклеивается снаружи к </a> (…текст</a>»).
 * Правила внутри каждого блочного тега (p, h1-6, li, blockquote):
 *  - пара кавычек, где закрывающая стоит сразу после </a> или открывающая
 *    сразу перед <a …>, удаляется целиком (обе кавычки);
 *  - оставшиеся непарные открывающие/закрывающие кавычки в блоке удаляются.
 * Теги, атрибуты и шорткоды не трогаем.
 */
export function fixAnchorQuotes(html: string, lang?: string | null): string {
  const L = (lang || "").toUpperCase().split("-")[0];
  const [open, close] = QUOTE_STYLES[L] || ['"', '"'];

  return html.replace(
    /<(p|h[1-6]|li|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (block) => {
      type Ev = { pos: number; kind: "open" | "close" | "aStart" | "aEnd" };
      const events: Ev[] = [];
      const re = /<a\b[^>]*>|<\/a>|[«»„“”"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(block))) {
        const tok = m[0];
        if (tok === "</a>") events.push({ pos: m.index, kind: "aEnd" });
        else if (tok.startsWith("<a")) events.push({ pos: m.index, kind: "aStart" });
        else events.push({ pos: m.index, kind: tok === open ? "open" : tok === close ? "close" : "open" });
      }
      if (!events.some((e) => e.kind === "open" || e.kind === "close")) return block;

      // пары open→close по порядку
      const kill = new Set<number>();
      const stack: number[] = []; // индексы events открывающих
      const pairs: [number, number][] = [];
      events.forEach((e, i) => {
        if (e.kind === "open") stack.push(i);
        else if (e.kind === "close") {
          if (stack.length) pairs.push([stack.pop()!, i]);
          else kill.add(e.pos); // закрывающая без открывающей
        }
      });

      for (const [oi, ci] of pairs) {
        const o = events[oi], c = events[ci];
        const hasAnchor = events.some((e) => (e.kind === "aStart" || e.kind === "aEnd") && e.pos > o.pos && e.pos < c.pos);
        if (!hasAnchor) continue;
        // закрывающая приклеена к концу ссылки: </a>»  (пробелы допустимы)
        const closeGlued = /<\/a>\s*$/.test(block.slice(0, c.pos));
        // открывающая приклеена к началу ссылки: «<a …>
        const openGlued = /^\s*<a\b/.test(block.slice(o.pos + 1));
        if (closeGlued || openGlued) {
          kill.add(o.pos);
          kill.add(c.pos);
        }
      }
      // непарные открывающие
      for (const i of stack) kill.add(events[i].pos);

      if (!kill.size) return block;
      let out = "";
      for (let i = 0; i < block.length; i++) if (!kill.has(i)) out += block[i];
      return out;
    },
  );
}

/**
 * Применяет fn только к текстовым узлам: теги, атрибуты и WP-шорткоды
 * (`[caption id="" width="1080"]`, `[/caption]`) остаются нетронутыми.
 */
function mapTextNodes(html: string, fn: (t: string) => string): string {
  return html
    .split(/(<[^>]+>|\[\/?[a-zA-Z][^\]\n]{0,200}\])/g)
    .map((part) =>
      (part.startsWith("<") && part.endsWith(">")) || (part.startsWith("[") && part.endsWith("]"))
        ? part
        : fn(part),
    )
    .join("");
}


const ONLY_PUNCT = /^[\s.,;:!?—–\-·•"'«»„“”()]*$/;

/**
 * Чинит типичные следы работы ИИ/перевода: осиротевшая пунктуация,
 * разорванные абзацы, лишние пробелы перед знаками.
 */
export function sanitizeLayout(html: string): string {
  let out = html;

  // 1. абзацы, состоящие только из пунктуации или пустые
  out = out.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (m, inner: string) => {
    const plain = inner.replace(/<x-ph[^>]*>[\s\S]*?<\/x-ph>|<x-ph[^>]*>/gi, "").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ");
    if (/<x-ph|<img|<iframe/i.test(inner)) return m;
    return ONLY_PUNCT.test(plain) ? "" : m;
  });

  // 2. склейка разорванного абзаца: предыдущий не закончен, следующий с маленькой буквы
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(
      /<p([^>]*)>([\s\S]*?)<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/gi,
      (m, attrs: string, a: string, b: string) => {
        const endsOpen = !/[.!?:;»”")\]]\s*$/.test(a.replace(/<[^>]+>/g, "").trim());
        const startsLower = /^[a-zа-яёіїєґ]/.test(b.replace(/<[^>]+>/g, "").trim());
        if (!endsOpen || !startsLower || /<x-ph|<img|<h[1-6]/i.test(a + b)) return m;
        return `<p${attrs}>${a.trim()} ${b.trim()}</p>`;
      },
    );
  }

  // 3. то же для сырого WP-текста без <p> (абзацы разделены пустой строкой)
  out = out.replace(/\n{2,}([ \t]*[.,;:!?—–]+[ \t]*)\n{2,}/g, "\n\n");

  return mapTextNodes(out, (t) =>
    t
      // пробел перед знаком препинания
      .replace(/[ \t]+([.,;:!?])/g, "$1")
      // дубли знаков: ". ." / ", ,"
      .replace(/([.,!?])[ \t]*\1+/g, "$1")
      // точка после запятой/тире, оставшаяся от вырезанного куска
      .replace(/([,—–])\s*\./g, "$1")
      .replace(/[ \t]{2,}/g, " "),
  );
}

/**
 * Возвращает исходные фрагменты. Устойчиво к дублям: повторное вхождение
 * одного и того же индекса удаляется, а не клонирует картинку.
 * Многопроходный: токен ссылки может содержать вложенный токен картинки.
 */
export function restoreHtml(text: string, tokens: string[], lang?: string | null): string {
  const seen = new Set<number>();
  const swap = (raw: string) => {
    const idx = Number(raw);
    const t = tokens[idx];
    if (t === undefined) return "";
    if (seen.has(idx)) return "";
    seen.add(idx);
    return t;
  };
  // Чистим кавычки и вёрстку ДО подстановки токенов: содержимое токенов
  // (шорткоды, <img>, ссылки, iframe) возвращается байт в байт.
  let restored = sanitizeLayout(normalizeQuotes(text, lang));
  // Цикл до стабилизации: токен ссылки может нести вложенный токен картинки,
  // а тот — ещё один уровень. Трёх проходов на глубокой вложенности не хватало.
  for (let pass = 0; pass < 10; pass++) {
    const before = restored;
    restored = restored
      .replace(PH_RE, (_f, a, b) => swap(a ?? b))
      .replace(LEGACY_PH_RE, (_f, a) => swap(a));
    if (restored === before) break;
  }
  // Кавычки вокруг ссылок чиним ПОСЛЕ подстановки токенов: до неё ссылки
  // ещё скрыты за плейсхолдерами [[[P0]]] и функция их не увидит.
  return repairCaptions(fixAnchorQuotes(restored, lang));

}


export function countPlaceholders(text: string): number {
  const a = text.match(PH_RE)?.length || 0;
  const b = text.match(LEGACY_PH_RE)?.length || 0;
  return a + b;
}

/** Уникальные индексы плейсхолдеров, реально присутствующие в тексте. */
export function placeholderIds(text: string): Set<number> {
  const ids = new Set<number>();
  for (const m of text.matchAll(PH_RE)) ids.add(Number(m[1] ?? m[2]));
  for (const m of text.matchAll(LEGACY_PH_RE)) ids.add(Number(m[1]));
  return ids;
}

export interface Integrity {
  placeholders: number; links: number; open: number; close: number;
  paragraphs: number; headings: number; shortcodes: string[];
}

/** Список шорткодов в нормализованном виде — для точного сравнения до/после этапа. */
export function shortcodeList(html: string): string[] {
  return (html.match(/\[\/?[a-zA-Z][^\]\n]{0,200}\]/g) || [])
    .map((s) => s.replace(/\s+/g, " ").trim())
    .sort();
}

export function integrityStats(html: string): Integrity {
  return {
    placeholders: placeholderIds(html).size,
    links: (html.match(/<a\b[^>]*href=/gi) || []).length,
    open: (html.match(/<[a-zA-Z][^>]*>/g) || []).length,
    close: (html.match(/<\/[a-zA-Z][^>]*>/g) || []).length,
    paragraphs: (html.match(/<p\b[^>]*>/gi) || []).length,
    headings: (html.match(/<h[23]\b[^>]*>/gi) || []).length,
    shortcodes: shortcodeList(html),
  };
}



/**
 * Проверяет, не потерял ли этап картинки/шорткоды/ссылки.
 * fatal = результат этапа нужно откатить ко входу.
 */
export function checkIntegrity(before: string, after: string): { fatal: boolean; issues: QualityIssue[] } {
  const a = integrityStats(before);
  const b = integrityStats(after);
  const issues: QualityIssue[] = [];
  let fatal = false;
  if (!after.trim()) {
    return { fatal: true, issues: [{ code: "empty", detail: "Пустой результат этапа" }] };
  }
  if (b.placeholders < a.placeholders) {
    fatal = true;
    issues.push({
      code: "lost_media",
      detail: `Потеряно картинок/шорткодов: ${a.placeholders - b.placeholders} (было ${a.placeholders}, стало ${b.placeholders})`,
    });
  }
  if (b.links < a.links) {
    fatal = true;
    issues.push({ code: "lost_links", detail: `Потеряно ссылок: ${a.links - b.links} (было ${a.links}, стало ${b.links})` });
  }
  if (a.paragraphs > 3 && b.paragraphs < Math.floor(a.paragraphs * 0.9)) {
    fatal = true;
    issues.push({ code: "lost_paragraphs", detail: `Потеряно абзацев: было ${a.paragraphs}, стало ${b.paragraphs}` });
  }
  if (b.headings < a.headings) {
    fatal = true;
    issues.push({ code: "lost_headings", detail: `Потеряно заголовков: было ${a.headings}, стало ${b.headings}` });
  }
  if (a.shortcodes.join("|") !== b.shortcodes.join("|")) {
    fatal = true;
    const lost = a.shortcodes.filter((s) => !b.shortcodes.includes(s)).slice(0, 3);
    issues.push({
      code: "broken_shortcodes",
      detail: `Изменены шорткоды (было ${a.shortcodes.length}, стало ${b.shortcodes.length})${lost.length ? `: ${lost.join(", ")}` : ""}`,
    });
  }



  if (after.length < before.length * 0.5) {
    fatal = true;
    issues.push({ code: "truncated", detail: `Текст обрезан (${Math.round((after.length / Math.max(1, before.length)) * 100)}% от исходного)` });
  }
  return { fatal, issues };
}

export interface QualityIssue { code: string; detail: string }

/** Visible article text length, excluding tags and protected service placeholders. */
export function visibleTextLength(html: string): number {
  return html
    .replace(/<x-ph\b[^>]*><\/x-ph>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Honest changed-word count: linear sync diff with a bounded look-ahead window,
 * so a single early edit no longer marks the whole article as changed.
 */
export function textWords(html: string): string[] {
  return html
    .replace(/<x-ph\b[^>]*><\/x-ph>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}’'-]+/gu) || [];
}

export function changedWordCount(before: string, after: string): number {
  const words = textWords;
  const a = words(before);
  const b = words(after);
  const W = 48;

  let i = 0, j = 0, changed = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    let best = -1, bestDa = 0, bestDb = 0;
    for (let k = 1; k <= W && best < 0; k++) {
      for (let da = 0; da <= k; da++) {
        const db = k - da;
        if (i + da >= a.length || j + db >= b.length) continue;
        if (a[i + da] === b[j + db] && a[i + da + 1] === b[j + db + 1]) {
          best = k; bestDa = da; bestDb = db; break;
        }
      }
    }
    if (best < 0) { changed += (a.length - i) + (b.length - j); return changed; }
    changed += bestDa + bestDb;
    i += bestDa; j += bestDb;
  }
  changed += (a.length - i) + (b.length - j);
  return changed;
}

/**
 * Доля переписанного текста, % (0 — фрагмент не тронут, 100 — переписан целиком).
 * Нужна для постредактуры: после перевода допустима только точечная правка слов,
 * а не пересказ абзацев своими словами.
 */
export function rewritePct(before: string, after: string): number {
  const a = textWords(before).length;
  const b = textWords(after).length;
  const total = a + b;
  if (!total) return 0;
  return Math.round((changedWordCount(before, after) / total) * 100);
}


/**
 * Модель иногда дублирует служебный тег <x-ph i="N"> или придумывает лишний id.

 * Раньше это давало «Плейсхолдеры: было 18, стало 19» и откат всего фрагмента —
 * правки терялись целиком. Чиним механически: лишние повторы и чужие id убираем.
 */
export function repairPlaceholders(source: string, output: string): string {
  const count = (h: string) => {
    const m = new Map<number, number>();
    for (const x of h.matchAll(PH_RE)) {
      const id = Number(x[1] ?? x[2]);
      m.set(id, (m.get(id) || 0) + 1);
    }
    return m;
  };
  const src = count(source);
  const out = count(output);
  let dirty = false;
  for (const [id, n] of out) if (n > (src.get(id) || 0)) dirty = true;
  if (!dirty) return output;
  const seen = new Map<number, number>();
  return output.replace(PH_RE, (full, a, b) => {
    const id = Number(a ?? b);
    const used = seen.get(id) || 0;
    if (used >= (src.get(id) || 0)) return "";
    seen.set(id, used + 1);
    return full;
  });
}

/** Инлайновые теги оформления, которые переводчик иногда добавляет от себя. */
const DRIFT_TAGS = ["b", "i", "em", "strong", "span", "u", "mark", "small"];

const tagCounts = (h: string) => {
  const m = new Map<string, number>();
  for (const x of h.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
    const k = `${x[1] ? "/" : ""}${x[2].toLowerCase()}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
};

/**
 * DeepL иногда добавляет от себя <b>/<i>/<span>, которых во входном фрагменте не было.
 * Раньше это давало «Теги: было 47/47, стало 50/50», фатальный откат фрагмента и остановку
 * всей цепочки. Механически убираем именно такие лишние теги — текст при этом не страдает.
 */
export function repairTagDrift(source: string, output: string): string {
  const src = tagCounts(source);
  let res = output;
  for (const t of DRIFT_TAGS) {
    if ((src.get(t) || 0) === 0 && (src.get(`/${t}`) || 0) === 0) {
      const re = new RegExp(`</?${t}\\b[^>]*>`, "gi");
      if (re.test(res)) res = res.replace(re, "");
    }
  }
  return res;
}

/**
 * Расхождение по тегам считаем безопасным, если оно затрагивает только оформление:
 * структурные теги (p, li, h2, figure, a…) не потеряны, потери допустимы лишь среди
 * инлайновых DRIFT_TAGS, по каждому имени открывающие и закрывающие сходятся,
 * а суммарное расхождение мало. Такой фрагмент принимаем с предупреждением.
 */
export function tagsAreSafeDrift(source: string, output: string): boolean {
  const a = tagCounts(source);
  const b = tagCounts(output);
  const names = new Set<string>();
  for (const k of [...a.keys(), ...b.keys()]) names.add(k.replace(/^\//, ""));
  let total = 0;
  for (const name of names) {
    const dOpen = (b.get(name) || 0) - (a.get(name) || 0);
    const dClose = (b.get(`/${name}`) || 0) - (a.get(`/${name}`) || 0);
    if (dOpen !== dClose) return false;
    if (dOpen < 0 && !DRIFT_TAGS.includes(name)) return false;
    total += Math.abs(dOpen) + Math.abs(dClose);
  }
  const base = [...a.values()].reduce((s, n) => s + n, 0);
  return total <= Math.max(4, Math.round(base * 0.1));
}

/** Detect truncated / broken translations. */
export function validateChunk(source: string, output: string): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (!output || !output.trim()) {
    issues.push({ code: "empty", detail: "Пустой ответ" });
    return issues;
  }
  const ph1 = countPlaceholders(source);
  const ph2 = countPlaceholders(output);
  if (ph1 !== ph2) {
    issues.push({ code: "placeholders", detail: `Плейсхолдеры: было ${ph1}, стало ${ph2}` });
  }
  const openA = (source.match(/<[a-zA-Z][^>]*>/g) || []).length;
  const openB = (output.match(/<[a-zA-Z][^>]*>/g) || []).length;
  const closeA = (source.match(/<\/[a-zA-Z][^>]*>/g) || []).length;
  const closeB = (output.match(/<\/[a-zA-Z][^>]*>/g) || []).length;
  if (openA !== openB || closeA !== closeB) {
    const safe = tagsAreSafeDrift(source, output);
    issues.push({
      code: safe ? "tags_drift" : "tags",
      detail: `Теги: было ${openA}/${closeA}, стало ${openB}/${closeB}${safe ? " (безопасный прирост оформления, принято)" : ""}`,
    });
  }
  const ratio = output.length / Math.max(1, source.length);
  if (ratio < 0.45) {
    issues.push({ code: "truncated", detail: `Подозрительно короткий результат (${Math.round(ratio * 100)}%)` });
  }
  return issues;
}

/** Фатальные проблемы фрагмента: перевод/редактуру такого фрагмента нельзя использовать. */
export function chunkIsFatal(issues: QualityIssue[], relaxTags = false): boolean {
  return issues.some((x) =>
    x.code === "empty" || x.code === "truncated" || x.code === "placeholders" || x.code === "text_growth" ||
    x.code === "rewrite" ||
    (x.code === "tags" && !relaxTags)

  );
}


/** Проверка языка результата по алфавиту (кириллица/латиница/греческий/CJK). */
export function detectLangMismatch(html: string, expectedLang: string): string | null {
  if (!expectedLang || expectedLang === "auto") return null;
  const t = html.replace(/<[^>]+>/g, " ").replace(/<x-ph[^>]*>/g, " ");
  const letters = t.match(/[A-Za-zА-Яа-яЁё\u0370-\u03FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g) || [];
  if (!letters.length) return null;
  const total = letters.length;
  let expected = 0;
  const L = expectedLang.toUpperCase();
  if (L === "RU" || L === "UK" || L === "BG" || L === "BE" || L.startsWith("SR")) {
    expected = (t.match(/[А-Яа-яЁё]/g) || []).length;
  } else if (L === "EL") {
    expected = (t.match(/[\u0370-\u03FF]/g) || []).length;
  } else if (L === "ZH" || L.startsWith("ZH-") || L === "JA" || L === "KO") {
    expected = (t.match(/[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g) || []).length;
  } else {
    expected = (t.match(/[A-Za-z]/g) || []).length;
  }
  return expected / total < 0.6 ? `текст не похож на целевой язык ${expectedLang} (алфавит совпадает на ${Math.round((expected / total) * 100)}%)` : null;
}


/* ---------------- SEO-ключи ---------------- */

const STOPWORDS = new Set(
  ("the and for you your with that this from are was има які його щоб коли така таке такий тому дуже може бути було буде " +
    "або але для про під над без між тільки саме інші інша інший цього цьому цієї який яка яке яку ваша ваш ваші наш наша " +
    "это как что для при так они она они его ему них тоже если чтобы этот эта эти более менее очень можно нужно быть " +
    "und der die das den dem ein eine mit von auch nicht sind für auf ist als aus dass sich noch nur wie bei")
    .split(/\s+/),
);

/** Видимый текст статьи: без тегов, плейсхолдеров (значит и без анкоров) и подписей. */
export function visibleText(html: string): string {
  return html
    .replace(PH_RE, " ")
    .replace(LEGACY_PH_RE, " ")
    .replace(/\[caption[\s\S]*?\[\/caption\]/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface KeywordStat { key: string; source: number; current: number; min: number; max: number; ok: boolean }

export function countKeyword(html: string, key: string): number {
  const k = key.trim();
  if (!k) return 0;
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s\\-–—]+");
  // границы слова с поддержкой кириллицы
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu");
  return (visibleText(html).match(re) || []).length;
}

/** Частотные ключевые слова и словосочетания (1–4 слова) из исходной статьи. */
export function extractKeywords(html: string, title?: string | null, limit = 12): string[] {
  const text = `${title || ""}. ${visibleText(html)}`.toLowerCase();
  // предложения — границы фраз, чтобы n-граммы не склеивались через точку/запятую
  const sentences = text.split(/[.!?;:,()«»"“”\n]+/u);
  const freq = new Map<string, number>();
  const bump = (p: string) => freq.set(p, (freq.get(p) || 0) + 1);

  for (const s of sentences) {
    const words = s
      .split(/[^\p{L}\p{N}\-’']+/u)
      .filter((w) => w.length > 1 && !/^\d+$/.test(w));
    for (let i = 0; i < words.length; i++) {
      // одиночное слово — только значимое
      if (words[i].length >= 4 && !STOPWORDS.has(words[i])) bump(words[i]);
      // словосочетания: стоп-слова допустимы ВНУТРИ («сукня для дівчинки»), но не по краям
      for (let n = 2; n <= 4; n++) {
        const j = i + n - 1;
        if (j >= words.length) break;
        if (STOPWORDS.has(words[i]) || STOPWORDS.has(words[j])) continue;
        if (words[i].length < 3 || words[j].length < 3) continue;
        bump(words.slice(i, j + 1).join(" "));
      }
    }
  }

  const scored = [...freq.entries()]
    .filter(([p, n]) => {
      const w = p.split(" ").length;
      return w === 1 ? n >= 3 && p.length >= 5 : n >= 2;
    })
    // многословные фразы важнее одиночных слов
    .map(([p, n]) => [p, n * (1 + 0.8 * (p.split(" ").length - 1))] as [string, number])
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);

  const picked: string[] = [];
  for (const [p] of scored) {
    if (picked.length >= limit) break;
    // не берём фразу, которая уже входит в выбранную (или наоборот), если частоты близки
    const clash = picked.some((x) => {
      const inside = x.includes(p) || p.includes(x);
      if (!inside) return false;
      const a = freq.get(x) || 0;
      const b = freq.get(p) || 0;
      return b <= a * 1.3;
    });
    if (clash) continue;
    picked.push(p);
  }
  return picked;
}

/**
 * Целевой коридор вхождений ключа.
 * Ключ, которого не было в исходнике (ручной список), всё равно должен попасть
 * в текст — иначе постредактура его просто игнорирует (было: min=max=0).
 */
export function keywordTarget(source: number, minPct: number, maxPct: number): { min: number; max: number } {
  if (source > 0) {
    const min = Math.max(1, Math.round((source * minPct) / 100));
    return { min, max: Math.max(min, Math.round((source * maxPct) / 100)) };
  }
  return { min: 1, max: 2 };
}

/** Отчёт по ключам: сколько было в исходнике, сколько сейчас, попадает ли в диапазон. */
export function keywordReport(
  sourceHtml: string,
  currentHtml: string,
  keys: string[],
  minPct: number,
  maxPct: number,
): KeywordStat[] {
  return keys
    .map((k) => k.trim())
    .filter(Boolean)
    .map((key) => {
      const source = countKeyword(sourceHtml, key);
      const current = countKeyword(currentHtml, key);
      const { min, max } = keywordTarget(source, minPct, maxPct);
      return { key, source, current, min, max, ok: current >= min && current <= max };
    });
}



const plainText = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/**
 * Контроль пола автора: после перевода часто остаются «я обрав / я був / я зробил».
 * Не правим автоматически (это работа модели), но показываем в предупреждениях,
 * чтобы было видно, что постредактура пропустила согласование.
 */
export function detectMasculineVoice(html: string): string[] {
  const text = plainText(html);
  const hits = new Set<string>();
  // укр.: «я обрав», «я був радий», «я не знайшов»; рус.: «я выбрал», «я не смог»
  // \b в JS не работает с кириллицей — границы задаём через классы букв
  const re = /(?:^|[^\p{L}])(я\s+(?:не\s+|вже\s+|уже\s+|б\s+|би\s+)?([а-яёіїєґ']{3,}(?:в|вся|л|лся)))(?![\p{L}])/giu;
  for (const m of text.matchAll(re)) {
    const w = m[2].toLowerCase();
    // «я вважаю/маю» — не прошедшее время; отсекаем частые ложные срабатывания
    if (/(?:ів|ов|ев)$/.test(w)) continue;
    hits.add(m[1].trim());
    if (hits.size >= 20) break;
  }
  return [...hits];
}
