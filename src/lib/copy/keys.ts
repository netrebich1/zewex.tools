/**
 * Article Copy: разбор ключа статьи на ядро и формулировку.
 * «Classy Almond Nails 2027» → ядро «almond nails», формулировка «classy». Формулировки одного ядра владелец делал
 * специально разными для разных сайтов, поэтому похожие ключи считаются одной темой.
 */
export const PROJECT_SLUG = "copy";
export const COPY = "/pinterest/copy";

/** Стандартный набор формулировок («» — ключ без приставки). */
export const FORMULATIONS = ["", "classy", "trendy", "simple", "aesthetic", "cute", "elegant", "chic"] as const;
/** Слова-приставки, которые не меняют тему (стоят первым словом ключа). */
const LEAD = new Set(["classy", "trendy", "simple", "aesthetic", "cute", "elegant", "chic", "easy", "best", "stunning", "charming", "dreamy", "gorgeous", "pretty", "beautiful", "stylish", "lovely"]);
/** Хвосты, которые не меняют тему. */
const TAIL = new Set(["ideas", "idea", "inspo", "inspiration"]);
const YEAR = /^20\d\d$/;

export type KeyParts = { core: string; modifier: string };

export function splitKeyword(keyword: string): KeyParts {
  let t = (keyword.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !YEAR.test(w));
  let modifier = "";
  if (t.length > 1 && LEAD.has(t[0])) {
    modifier = t[0];
    t = t.slice(1);
  }
  while (t.length > 1 && TAIL.has(t[t.length - 1])) t = t.slice(0, -1);
  return { core: t.join(" ").slice(0, 191), modifier };
}

export const groupOf = (niche: string | null | undefined) => (niche === "interior" || niche === "decor" || niche === "outdoor" ? "interior" : "women");
export const GROUP_LABEL: Record<string, string> = { women: "Женские", interior: "Интерьер" };
export const NICHE_LABEL: Record<string, string> = { outfits: "Образы", hair: "Волосы", nails: "Ногти", interior: "Интерьер", makeup: "Макияж", tattoo: "Тату", other: "Без ниши" };
export const nicheLabel = (n: string) => NICHE_LABEL[n] ?? n;
export const modifierLabel = (m: string) => m || "без приставки";

/** Сколько статей выходит из банка ядра: статьи по N фото, из каждой старой статьи в новую — не больше доли maxOverlapPct. */
export function capacityByPhotos(p: { published: number; reserve: number; articles: number; perArticle: number; maxOverlapPct: number }): number {
  const n = Math.max(1, p.perArticle);
  const fromOne = Math.floor((n * p.maxOverlapPct) / 100);
  const total = Math.floor((p.published + p.reserve) / n);
  const perNew = fromOne * p.articles;
  if (perNew >= n) return total;
  return Math.min(total, Math.floor(p.reserve / (n - perNew)));
}
