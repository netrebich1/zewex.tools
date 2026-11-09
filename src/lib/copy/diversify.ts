/**
 * Разнообразие описаний кадров мешапа (тест v3, 07.11.2026): описатель пишет одну и ту же фразу для десятка фото
 * («fine, wavy texture», «air-dried finish», «middle parting»), план и писатель её копируют, и статья читается как
 * повтор. Здесь, без модели: фразы, которые встречаются во многих описаниях статьи, остаются в каждом третьем
 * описании, в остальных заменяются синонимом из словаря или теряют первое слово-прилагательное
 * («fine, wavy texture» → «wavy texture»). Слова темы (ядра) не трогаются никогда.
 */

/** Словарь замен: фраза → варианты по кругу. Регистр исходника сохраняется для первой буквы. */
const SYNONYMS: Array<[RegExp, string[]]> = [
  [/\bfine,? wavy texture\b/i, ["soft waves", "a light wave", "fine waves"]],
  [/\bthick,? wavy texture\b/i, ["full waves", "dense waves", "heavy wave pattern"]],
  [/\bwavy texture\b/i, ["waves", "a wave pattern", "loose waves"]],
  [/\bair-dried (?:finish|texture|waves?)\b/i, ["loose finish", "undone texture", "natural waves"]],
  [/\bair-dried\b/i, ["loose", "undone", "unstyled"]],
  [/\bmiddle part(?:ing)?\b/i, ["center part", "a part down the middle", "centered parting"]],
  [/\bcenter part(?:ing)?\b/i, ["middle part", "a part down the middle", "centered parting"]],
  [/\bside part(?:ing)?\b/i, ["off-center part", "a part to one side", "side parting"]],
  [/\bsoft curtain bangs\b/i, ["curtain bangs", "a parted fringe", "face-framing fringe"]],
  [/\bface-framing (?:layers|pieces)\b/i, ["front layers", "pieces around the face", "shorter front sections"]],
  [/\bsubtle highlights\b/i, ["lighter pieces", "thin lighter strands", "fine highlights"]],
  [/\bglossy finish\b/i, ["high-shine finish", "shiny top coat", "gloss"]],
  [/\bsheer (?:nude|pink) base\b/i, ["translucent base", "see-through base", "milky base"]],
  [/\bwhite french tips?\b/i, ["white tips", "a white smile line", "white tip line"]],
  [/\bstraight-leg jeans\b/i, ["straight jeans", "jeans with a straight leg", "straight-cut denim"]],
  [/\bwhite sneakers\b/i, ["white trainers", "clean white shoes", "low white sneakers"]],
  [/\boversized (?:blazer|jacket|shirt)\b/i, ["roomy $1", "loose $1", "boxy $1"]],
];

/** Прилагательные, которые можно отбросить без потери факта (не цвет, не форма, не длина, не техника). */
const DROPPABLE = new Set(["fine", "soft", "subtle", "gentle", "loose", "natural", "lived-in", "relaxed", "classic", "simple", "clean", "sleek", "smooth", "delicate", "slight", "elegant", "modern", "casual", "effortless", "polished", "chic", "pretty", "neat", "minimal", "understated", "fresh", "cute", "stylish", "trendy", "feminine", "timeless", "flattering"]);

const STOP = new Set(["the", "a", "an", "and", "with", "of", "on", "in", "at", "to", "for", "is", "are", "that", "this", "her", "its", "into", "over", "from", "by", "as"]);

export type DiversifyResult = { out: string[]; phrases: Array<{ phrase: string; count: number; changed: number }> };

/** Фразы из 2–3 слов, повторяющиеся в ≥ minCount описаниях; слова темы исключены. */
function repeatedPhrases(descs: string[], lockWords: Set<string>, minCount: number): string[] {
  const perDesc = descs.map((d) => {
    const words = d.toLowerCase().replace(/[^a-z0-9'\- ]/g, " ").split(/\s+/).filter(Boolean);
    const set = new Set<string>();
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const clean = words.slice(i, i + n);
        if (STOP.has(clean[0]) || STOP.has(clean[clean.length - 1])) continue;
        if (clean.some((w) => lockWords.has(w) || /^\d/.test(w))) continue;
        const phrase = clean.join(" ");
        if (phrase.length >= 9) set.add(phrase);
      }
    }
    return set;
  });
  const count = new Map<string, number>();
  for (const set of perDesc) for (const p of set) count.set(p, (count.get(p) ?? 0) + 1);
  // Длинные фразы раньше коротких, чтобы «fine, wavy texture» обработалась до «wavy texture».
  return [...count.entries()].filter(([, c]) => c >= minCount).sort((a, b) => b[0].length - a[0].length || b[1] - a[1]).map(([p]) => p);
}

const keepCase = (src: string, out: string) => (src[0] === src[0].toUpperCase() && /[A-Za-z]/.test(src[0]) ? out[0].toUpperCase() + out.slice(1) : out);

/** Заменить фразу: синоним из словаря по кругу, иначе отбросить первое слово (прилагательное), если слов ≥ 2. */
function replacement(phrase: string, k: number): string | null {
  for (const [re, variants] of SYNONYMS) {
    const m = phrase.match(re);
    if (m && m[0].length >= phrase.length - 1) {
      const v = variants[k % variants.length];
      return v.includes("$1") && m[1] ? v.replace("$1", m[1]) : v;
    }
  }
  // Без словаря отбрасывается только «мягкое» прилагательное: цвет, форма, длина и техника — факты, их не трогаем
  // («brown hair» никогда не станет «hair»).
  const words = phrase.split(" ");
  if (words.length >= 2 && DROPPABLE.has(words[0])) return words.slice(1).join(" ");
  return null;
}

/**
 * Пройти описания статьи: каждая повторяющаяся фраза остаётся в каждом третьем описании (первом, четвёртом…),
 * в остальных заменяется. Чистая функция, порядок описаний сохраняется.
 */
export function diversifyDescriptions(descs: string[], lockWordsList: string[], minCount?: number): DiversifyResult {
  const lockWords = new Set(lockWordsList.map((w) => w.toLowerCase()).filter((w) => w.length > 2));
  const min = minCount ?? Math.max(4, Math.ceil(descs.length / 6));
  const phrases = repeatedPhrases(descs, lockWords, min);
  const out = [...descs];
  const report: DiversifyResult["phrases"] = [];
  const touched = new Set<string>();
  for (const phrase of phrases) {
    // Фраза, уже входящая в более длинную обработанную, пропускается, если она в ней целиком.
    if ([...touched].some((t) => t.includes(phrase))) continue;
    // Между словами допускается запятая: фраза «fine wavy texture» найдёт и «fine, wavy texture».
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, ",?\\s+")}\\b`, "i");
    let seen = 0, changed = 0;
    for (let i = 0; i < out.length; i++) {
      const m = out[i].match(re);
      if (!m) continue;
      const idx = seen++;
      if (idx % 3 === 0) continue;
      const rep = replacement(m[0].toLowerCase(), idx);
      if (!rep) continue;
      out[i] = out[i].replace(re, keepCase(m[0], rep)).replace(/\b(a|an|the) (a|an|the) /gi, "$1 ").replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1");
      changed++;
    }
    if (changed) { touched.add(phrase); report.push({ phrase, count: seen, changed }); }
  }
  return { out, phrases: report };
}
