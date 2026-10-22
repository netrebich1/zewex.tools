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
