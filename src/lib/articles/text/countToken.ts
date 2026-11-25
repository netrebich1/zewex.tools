/**
 * Количество идей/фото в статье: метка вместо цифры (порт _shared/countToken.ts оригинала).
 *
 * Тексты (вступление, заключение, секции, мета) пишутся с меткой {{COUNT}}.
 * Фактическое число подставляется только при сборке HTML (patchCount), поэтому исключение
 * фото на модерации автоматически меняет число везде. Для старых текстов с цифрой — retargetCount().
 */

export const COUNT_TOKEN = "{{COUNT}}";

/** Все варианты написания метки, которые может вернуть модель. (оригинал: countToken.ts:13) */
const TOKEN_RE = /\{\{\s*COUNT\s*\}\}|\{\s*COUNT\s*\}|\[\s*COUNT\s*\]/gi;

const NUMBER_WORDS: Record<number, string> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven",
  8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve", 13: "thirteen",
  14: "fourteen", 15: "fifteen", 16: "sixteen", 17: "seventeen", 18: "eighteen",
  19: "nineteen", 20: "twenty", 21: "twenty-one", 22: "twenty-two",
  23: "twenty-three", 24: "twenty-four", 25: "twenty-five", 26: "twenty-six",
  27: "twenty-seven", 28: "twenty-eight", 29: "twenty-nine", 30: "thirty",
};

const WORD_TO_NUMBER: Record<string, number> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([n, w]) => [w, Number(n)]),
);

export function numberWord(n: number): string {
  return NUMBER_WORDS[n] || String(n);
}

/** Существительные, рядом с которыми число означает количество идей в статье. (оригинал: countToken.ts:33-39) */
const ITEM_NOUNS = [
  "outfits?", "looks?", "ensembles?", "combinations?", "ideas?", "designs?",
  "styles?", "sets?", "photos?", "pictures?", "inspirations?", "picks?",
  "variations?", "options?", "hairstyles?", "haircuts?", "cuts?", "colors?",
  "colours?", "manicures?", "nails?", "tattoos?", "rooms?", "spaces?",
  "looks to try", "образ(?:ов|а|ы)?", "идей",
].join("|");

/** Слова, после которых число — не количество идей (защита от ложных замен). */
const UNIT_GUARD = /^(?:min|mins|minutes?|hours?|px|cm|mm|inch(?:es)?|%|days?|weeks?|months?|years?|usd|dollars?)\b/i;

/** Между числом и существительным до четырёх определений: «25 Cozy Winter Teacher Outfits». */
const GAP = "(?:\\s+[A-Za-z][A-Za-z'’-]*){0,4}\\s+";

/** Слова-разделители: если стоят между числом и существительным — это не количество. */
const GAP_STOP = /\b(?:of|per|out|to|and|or|in|on|for|with|from|min|mins|minutes?|hours?|days?|weeks?|months?|years?|percent|px)\b/i;

/** Подставляет фактическое количество вместо метки {{COUNT}}. */
export function renderCount(text: string | null | undefined, n: number): string {
  if (!text) return String(text ?? "");
  if (!Number.isFinite(n) || n <= 0) return String(text);
  return String(text).replace(TOKEN_RE, String(n));
}

/** Есть ли в тексте метка количества. */
export function hasCountToken(text: string | null | undefined): boolean {
  // Новый regex на каждый вызов: у глобального остаётся lastIndex
  return new RegExp(TOKEN_RE.source, "i").test(String(text || ""));
}

/** Приводит варианты записи метки ({COUNT}, [COUNT], {{count}}) к каноническому {{COUNT}}. (оригинал: stage77:638) */
export function keepToken(text: string | null | undefined): string {
  return String(text ?? "").replace(/\{\{\s*count\s*\}\}|\{\s*count\s*\}|\[\s*count\s*\]/gi, COUNT_TOKEN);
}

/**
 * Пересчёт «на живом» тексте: меняет число рядом с предметным существительным на актуальное.
 * Год и числа с единицами измерения не трогаются. (оригинал: countToken.ts:74-103)
 */
export function patchCount(text: string | null | undefined, actual: number): string {
  const src = String(text ?? "");
  if (!src || !Number.isFinite(actual) || actual <= 0) return src;

  let out = renderCount(src, actual);

  const digitRe = new RegExp(`\\b(\\d{1,2})(${GAP}(?:${ITEM_NOUNS}))\\b`, "gi");
  out = out.replace(digitRe, (match: string, num: string, rest: string, offset: number, whole: string) => {
    const n = parseInt(num, 10);
    if (n < 5 || n > 40 || n === actual) return match;
    if (GAP_STOP.test(rest)) return match;
    if (/\b(?:out\s+of|of)\s*$/i.test(whole.slice(0, offset))) return match;

    const after = whole.slice(offset + match.length).trimStart();
    if (UNIT_GUARD.test(after)) return match;
    return `${actual}${rest}`;
  });

  const wordsPattern = Object.values(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|");
  const wordRe = new RegExp(`\\b(${wordsPattern})(${GAP}(?:${ITEM_NOUNS}))\\b`, "gi");
  out = out.replace(wordRe, (match: string, word: string, rest: string) => {
    const n = WORD_TO_NUMBER[String(word).toLowerCase()];
    if (!n || n < 5 || n > 40 || n === actual) return match;
    if (GAP_STOP.test(rest)) return match;
    return `${numberWord(actual)}${rest}`;
  });

  return out;
}

/**
 * Точечная замена известного старого числа на новое (мета-теги, оглавление).
 * Год (20xx) и части больших чисел не затрагиваются. (оригинал: countToken.ts:109-123)
 */
export function retargetCount(text: string | null | undefined, oldN: number, newN: number): string {
  const src = String(text ?? "");
  if (!src || !Number.isFinite(oldN) || !Number.isFinite(newN) || oldN === newN) return src;
  const re = new RegExp(`(?<![\\d.,])${oldN}(?![\\d.,])`, "g");
  let out = src.replace(re, String(newN));
  const oldWord = NUMBER_WORDS[oldN];
  if (oldWord) {
    out = out.replace(new RegExp(`\\b${oldWord}\\b`, "gi"), numberWord(newN));
  }
  return out;
}

/**
 * Привести «живую» цифру количества в заголовке к метке: «25 Short Nails …» → «{{COUNT}} Short Nails …».
 * Нужна плану (H1 обязан содержать метку); года (20xx) и числа вне 1–99 не трогаются.
 */
export function ensureCountToken(text: string | null | undefined): string {
  const s = keepToken(text);
  if (hasCountToken(s)) return s;
  const replaced = s.replace(/(?<![\d.,])(\d{1,2})(?![\d.,])/, COUNT_TOKEN);
  if (replaced !== s) return replaced;
  return `${COUNT_TOKEN} ${s}`.trim();
}

/** Блок инструкции для промтов: как писать количество. (оригинал: countToken.ts:126-131) */
export function countTokenPromptBlock(): string {
  return `ARTICLE COUNT
- The number of ideas/photos in this article can still change during moderation.
- Whenever you need to mention that number, write the literal placeholder ${COUNT_TOKEN} instead of a digit or a number word.
- Example: "${COUNT_TOKEN} looks that actually work" — never "25 looks".
- Write ${COUNT_TOKEN} exactly as shown, with both pairs of braces, and never inside any other number.`;
}
