/**
 * Повторы между секциями мешапа, найденные кодом: фразы из 2–4 слов и зачины предложений, встречающиеся в ≥ minSections
 * секциях. Нужны проходу против повторов (worker/articles/stages/copyDedupe.ts): flash-lite сам повторов не видит
 * и возвращает текст без изменений, а с конкретным списком «фраза → секции» переписывает прицельно.
 */

const STOP = new Set(["the", "a", "an", "and", "with", "of", "on", "in", "at", "to", "for", "is", "are", "that", "this", "her", "its", "into", "over", "from", "by", "as", "or", "it", "be", "so", "than", "but", "if", "you", "your", "when", "which", "who", "what", "where", "then", "there", "they", "them", "these", "those", "one", "more", "most", "very", "just", "also", "can", "will", "would", "has", "have", "had", "do", "does", "not", "no", "up", "out", "off", "all", "any", "some", "both", "each", "much", "own", "same", "too", "s"]);

export type Repeat = { phrase: string; sections: number[] };
export type RepeatReport = { phrases: Repeat[]; openers: Repeat[] };

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9'\- ]/g, " ").split(/\s+/).filter(Boolean);

/**
 * @param htmls HTML секций в порядке статьи (индекс → номер секции n = i + 1)
 * @param lockWords слова темы: фразы, целиком состоящие из них, не считаются повтором (тема и должна звучать)
 * @param minSections с какого числа секций фраза считается повтором (по умолчанию 3)
 */
export function findRepeats(htmls: string[], lockWords: string[], minSections = 3): RepeatReport {
  const lock = new Set(lockWords.map((w) => w.toLowerCase()));
  const phraseSecs = new Map<string, Set<number>>();
  const openerSecs = new Map<string, Set<number>>();
  htmls.forEach((html, i) => {
    const text = textOf(html);
    const words = tokens(text);
    const seen = new Set<string>();
    for (let n = 2; n <= 4; n++) {
      for (let k = 0; k + n <= words.length; k++) {
        const gram = words.slice(k, k + n);
        if (STOP.has(gram[0]) || STOP.has(gram[n - 1])) continue;
        // Фраза со словом темы («pink to white ombre») — название идеи, оно и должно звучать; не повтор.
        if (gram.some((w) => lock.has(w))) continue;
        if (gram.some((w) => /^\d/.test(w))) continue;
        const p = gram.join(" ");
        if (p.length >= 9) seen.add(p);
      }
    }
    for (const p of seen) (phraseSecs.get(p) ?? phraseSecs.set(p, new Set()).get(p)!).add(i + 1);
    // Зачины: первые два слова каждого предложения (без цифр и стоп-слов не фильтруем — «If you», «This is» как раз важны).
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20);
    const starts = new Set(sentences.map((s) => tokens(s).slice(0, 2).join(" ")).filter((s) => s.split(" ").length === 2));
    for (const s of starts) (openerSecs.get(s) ?? openerSecs.set(s, new Set()).get(s)!).add(i + 1);
  });
  // Длинные фразы раньше коротких; короткая, целиком входящая в уже взятую длинную с тем же набором секций, пропускается.
  const phrases: Repeat[] = [];
  const candidates = [...phraseSecs.entries()].filter(([, s]) => s.size >= minSections).sort((a, b) => b[0].length - a[0].length || b[1].size - a[1].size);
  for (const [p, secs] of candidates) {
    if (phrases.some((t) => t.phrase.includes(p) && secs.size <= t.sections.length)) continue;
    phrases.push({ phrase: p, sections: [...secs].sort((x, y) => x - y) });
    if (phrases.length >= 25) break;
  }
  const openers: Repeat[] = [...openerSecs.entries()].filter(([, s]) => s.size >= Math.max(minSections, 4)).sort((a, b) => b[1].size - a[1].size).slice(0, 10).map(([p, s]) => ({ phrase: p, sections: [...s].sort((x, y) => x - y) }));
  return { phrases, openers };
}
