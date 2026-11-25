/**
 * Единый slugify и правила URL/года (оригинал держал четыре slugify: stage-photo-plan:38, stage65:71,
 * assemble:534, stage77:130 — аудит 03, §7.11). Правила ключа цельным блоком, безопасных слов и формы URL —
 * из stage77-generate-seo-meta/index.ts.
 */

/** Год в ключе: любой 20xx (оригинал: stage77:6-7). */
export const YEAR_PATTERN = /\b20\d{2}\b/g;
export const YEAR_TEST_PATTERN = /\b20\d{2}\b/;

/** Транслит не нужен: ключи английские; апострофы (прямой и типографский) вырезаются, остальное → дефис. ≤90 символов. */
export function slugify(v: unknown, max = 90): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** Слова, которые можно добавлять в URL: они расширяют тему, но не переопределяют её. (оригинал: stage77:108-113) */
export const SLUG_SAFE_WORDS = new Set([
  "trendy", "cute", "chic", "classy", "elegant", "pretty", "simple", "easy", "modern",
  "aesthetic", "stylish", "cool", "fresh", "bold", "soft", "best", "top", "popular",
  "ideas", "idea", "inspiration", "inspo", "designs", "design", "looks", "gallery",
  "guide", "examples", "picks", "to", "try", "for", "women", "girls", "her", "you",
]);

/**
 * Форма URL: только блок ключевого слова (без года). Раньше к ключу добавлялись 1–3 «расширяющих» слова
 * (cute-…-ideas, chic-…-looks, …-for-women) — аудит text-v2: это мусор в адресе, слова-пустышки теперь
 * вырезаются (polish.ts → stripSlugFiller). Массив оставлен, чтобы форма выбиралась тем же кодом.
 */
export const SLUG_SHAPES = ["{kw}"];

/** Стабильное число 0-99 из строки: розыгрыш года в URL не меняется при повторном запуске. (оригинал: stage77:831-838) */
export function hashPercent(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100;
}

/** Год берётся ТОЛЬКО из ключа; нет года — нет года в мета. (оригинал: stage77:176-182) */
export function keywordYear(keyword: string): string {
  const m = String(keyword || "").match(YEAR_TEST_PATTERN);
  return m ? m[0] : "";
}

/** Ключ без года и лишних пробелов. (оригинал: stage77:183) */
export function stripYear(keyword: string): string {
  return String(keyword || "").replace(YEAR_PATTERN, "").replace(/\s{2,}/g, " ").trim();
}

/** Все годы в тексте → целевой; без целевого — годы вырезаются. (оригинал: stage77:714-720) */
export function normalizeMetaYear(value: string, targetYear: string): string {
  const cleaned = String(value || "").trim();
  if (targetYear) {
    return cleaned.replace(YEAR_PATTERN, targetYear).replace(/\s{2,}/g, " ").trim();
  }
  return cleaned.replace(YEAR_PATTERN, "").replace(/\s{2,}/g, " ").trim();
}

/** Процент статей с годом в URL: настройка запуска → сценарий → 100. (оригинал: stage77:196-201) */
export function yearPercentOf(runPercent: number | null | undefined, recipePercent: number | null | undefined): number {
  let p = Number(runPercent);
  if (!Number.isFinite(p)) p = Number(recipePercent);
  if (!Number.isFinite(p)) p = 100;
  return Math.max(0, Math.min(100, Math.round(p)));
}

/** Розыгрыш «год в URL» один раз на статью (детерминированно по id). (оригинал: stage77:203) */
export function yearInSlugFor(articleId: string, year: string, percent: number): boolean {
  return Boolean(year) && percent > 0 && hashPercent(articleId) < percent;
}

/** Детерминированная форма URL для статьи. (оригинал: stage77:227-229) */
export function slugExampleFor(articleId: string, kwSlug: string): string {
  const shape = SLUG_SHAPES[hashPercent(articleId + "|slug") % SLUG_SHAPES.length];
  return shape.replace("{kw}", kwSlug);
}

/**
 * Проверка URL: ключ одним неразрывным блоком, ≤3 добавочных слов и все из SLUG_SAFE_WORDS (год не считается).
 * (оригинал: stage77:600-607)
 */
export function slugOk(slug: string, kwSlug: string, year: string): boolean {
  if (!kwSlug) return true;
  const s = `-${slug}-`;
  if (!s.includes(`-${kwSlug}-`)) return false;
  const extras = s.replace(`-${kwSlug}-`, "-").split("-").filter(Boolean).filter((w) => !(year && w === year));
  return extras.length <= 3 && extras.every((w) => SLUG_SAFE_WORDS.has(w));
}

/** Применить правило года к URL: дописать `-YYYY` или вырезать все 20xx. (оригинал: stage77:615-625) */
export function applySlugYear(slug: string, year: string, yearInSlug: boolean): string {
  let s = slug;
  if (!year) return s.replace(/\b20\d{2}\b/g, "").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (yearInSlug) {
    if (!s.includes(year)) s = `${s.replace(/-+$/, "")}-${year}`;
  } else {
    s = s.replace(/\b20\d{2}\b/g, "").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  }
  return s;
}

/** Служебные слова: в адрес не идут, если их нет в самом ключе. */
const SLUG_STOP = new Set([
  "a", "an", "the", "and", "or", "but", "to", "for", "of", "in", "on", "at", "by", "with", "from", "into", "over", "under",
  "your", "you", "yours", "my", "our", "we", "i", "it", "its", "this", "that", "these", "those", "how", "what", "why", "when",
  "which", "who", "is", "are", "be", "can", "do", "does", "will", "should", "vs", "versus", "like", "as", "so", "than", "up",
  "out", "about", "all", "every", "any", "more", "most", "really", "just", "very", "ever", "s", "t", "count",
]);

/** Пустышки и «продающие» слова: контекста не добавляют (аудит text-v2), плюс глаголы-зачины заголовков. */
const SLUG_CONTEXT_SKIP = new Set([
  "cute", "trendy", "best", "top", "chic", "classy", "elegant", "pretty", "stylish", "aesthetic", "cool", "fresh", "popular",
  "amazing", "stunning", "gorgeous", "perfect", "ultimate", "beautiful", "awesome", "incredible", "effortless", "effortlessly",
  "elevate", "must", "know", "complete", "simple", "easy", "actually", "truly", "ideas", "idea", "inspo", "inspiration",
  "gallery", "picks", "examples", "guide", "step", "steps", "achieve", "discover", "learn", "master", "unlock", "get", "make",
  "try", "need", "want", "find", "use", "using", "give", "keep", "start", "new", "way", "ways", "things", "thing",
  "work", "works", "help", "helps", "move", "go", "feel", "right", "wrong", "really", "here", "everything", "anything",
]);

const UNIT_WORDS = new Set(["day", "days", "week", "weeks", "minute", "minutes", "min", "hour", "hours", "month", "months", "step", "steps", "second", "seconds"]);

const stemOf = (w: string) => (w.length >= 5 ? w.slice(0, 5) : w);

/**
 * Адрес статьи по контексту, а не голым ключом (просьба владельца 31.10: адреса «строго по ключу» палевные).
 * Слова ключа — все и как в ключе; к ним 2–3 смысловых слова из H1 (по запасным фразам — темы, LSI, если в H1 нет),
 * порядок как в H1, когда весь ключ там есть. Число добавочных слов — детерминированно по seed (id статьи),
 * чтобы соседние статьи не были одного шаблона. Без года (его ставит applySlugYear), ≤ maxLen символов.
 */
export function contextSlug(o: { keyword: string; h1: string; extra?: string[]; seed: string; maxLen?: number }): string {
  const maxLen = o.maxLen ?? 60;
  const kwSlug = slugify(stripYear(o.keyword), 200);
  const kwWords = kwSlug.split("-").filter(Boolean);
  if (!kwWords.length) return slugify(stripYear(o.h1), maxLen);
  const kwSet = new Set(kwWords);
  const kwStems = new Set(kwWords.filter((w) => w.length >= 4).map(stemOf));
  const isExtra = (w: string) => !kwSet.has(w) && !/^\d+$/.test(w) && w.length > 1 && !SLUG_STOP.has(w) && !SLUG_CONTEXT_SKIP.has(w) && !(w.length >= 4 && kwStems.has(stemOf(w)));
  // «7-Day», «10-Minute»: без числа единица смысла не несёт — уходит вместе с ним
  const words = (s: string) => slugify(stripYear(s), 300).split("-").filter(Boolean).filter((w, i, a) => !(i > 0 && /^\d+$/.test(a[i - 1]) && UNIT_WORDS.has(w)));

  const h1 = words(o.h1);
  const want = 2 + (hashPercent(`${o.seed}|ctx-slug`) % 2);
  const extras: string[] = [];
  const addFrom = (list: string[]) => { for (const w of list) if (extras.length < want && isExtra(w) && !extras.includes(w)) extras.push(w); };
  addFrom(h1);
  for (const e of o.extra ?? []) addFrom(words(e));

  let seq: string[];
  const allInH1 = kwWords.every((w) => h1.includes(w));
  if (allInH1 && !`-${h1.join("-")}-`.includes(`-${kwSlug}-`)) {
    // Ключ в H1 вразбивку: порядок H1 (естественная фраза), каждое слово один раз
    const kwLeft = [...kwWords];
    seq = [];
    for (const w of h1) {
      const k = kwLeft.indexOf(w);
      if (k >= 0) { seq.push(w); kwLeft.splice(k, 1); } else if (extras.includes(w) && !seq.includes(w)) seq.push(w);
    }
  } else if (allInH1) {
    // Ключ цельным блоком: слова H1 до и после блока
    const at = h1.join("-").indexOf(kwSlug);
    const before = h1.join("-").slice(0, at).split("-").filter((w) => extras.includes(w));
    const rest = extras.filter((w) => !before.includes(w));
    seq = [...before, ...kwWords, ...rest];
  } else {
    seq = [...kwWords, ...extras];
  }
  // Длина: снимаем добавочные слова с конца, ключ не трогаем
  while (seq.join("-").length > maxLen && seq.some((w) => !kwSet.has(w))) {
    for (let i = seq.length - 1; i >= 0; i--) if (!kwSet.has(seq[i])) { seq.splice(i, 1); break; }
  }
  return seq.join("-") || kwSlug;
}
