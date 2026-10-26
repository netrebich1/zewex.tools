/**
 * Библиотека стилей ИИ-пинов (бывший styles.json функции generate-pin-prompt).
 * Данные лежат в src/data/pins/ai-styles.json — код их только читает.
 *
 * BalancedPicker здесь нет: он жил в pinPlanner.ts, который портируется отдельно.
 */

import stylesConfig from "@/data/pins/ai-styles.json";

export type AiStyle = {
  id: string;
  num: number;
  name: string;
  /** magazine | soft | ctr | traffic | newyear */
  category: string;
  /** collage | listicle | lifestyle | … — тип раскладки. */
  type?: string;
  variantOf?: string;
  variantLabel?: string;
  baseName?: string;
  concept: string;
  layout: string;
  typography: string;
  colorLogic: string;
  decorative: string;
  avoid: string;
  gold: string;
  examples?: string[];
  /** Ниши, под которые стиль сделан (decor, interior, …) — фильтр «только декор» в галерее. Пусто — универсальный. */
  niches?: string[];
  /** Блоговые стили (категория blog): типы статей, к которым стиль подходит (src/lib/pins/articleKind.ts). */
  articleKinds?: string[];
  /** Блоговые стили: разделы статьи, пункты которых стиль показывает (steps, mistakes, tips, what_you_need…), по порядку. */
  pointsFrom?: string[];
  /** Блоговые стили: цифра на пине — число пунктов показанного раздела («6 Steps», «5 Mistakes»). */
  countable?: boolean;
};

/** Подписи ниш стилей для фильтра. */
export const STYLE_NICHE_LABELS: Record<string, string> = { decor: "Декор", interior: "Интерьер", beauty: "Бьюти", fashion: "Мода", food: "Еда" };

export type AiStyleCategory = { id: string; label: string; note?: string };
export type AiStyleType = { id: string; label: string; ru?: string; color?: string; desc?: string };

type RawStyle = Partial<AiStyle> & { id?: unknown; num?: unknown };
type RawConfig = { categories?: unknown; types?: unknown; styles?: unknown };

const raw = stylesConfig as unknown as RawConfig;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function normalizeStyle(s: RawStyle): AiStyle | null {
  const id = str(s.id).trim();
  if (!id) return null;
  const examples = Array.isArray(s.examples) ? s.examples.filter((e): e is string => typeof e === "string") : undefined;
  return {
    id,
    num: typeof s.num === "number" ? s.num : 0,
    name: str(s.name) || id,
    category: str(s.category) || "soft",
    type: str(s.type) || undefined,
    variantOf: str(s.variantOf) || undefined,
    variantLabel: str(s.variantLabel) || undefined,
    baseName: str(s.baseName) || undefined,
    concept: str(s.concept),
    layout: str(s.layout),
    typography: str(s.typography),
    colorLogic: str(s.colorLogic),
    decorative: str(s.decorative),
    avoid: str(s.avoid),
    gold: str(s.gold),
    examples: examples && examples.length ? examples : undefined,
    niches: Array.isArray(s.niches) ? s.niches.filter((n): n is string => typeof n === "string" && n !== "") : undefined,
    articleKinds: Array.isArray(s.articleKinds) ? s.articleKinds.filter((n): n is string => typeof n === "string" && n !== "") : undefined,
    pointsFrom: Array.isArray(s.pointsFrom) ? s.pointsFrom.filter((n): n is string => typeof n === "string" && n !== "") : undefined,
    countable: s.countable === true,
  };
}

const STYLES: AiStyle[] = (Array.isArray(raw.styles) ? (raw.styles as RawStyle[]) : [])
  .map(normalizeStyle)
  .filter((s): s is AiStyle => s !== null);

const BY_ID: Map<string, AiStyle> = new Map(STYLES.map((s) => [s.id, s]));

/** Категории из библиотеки: magazine / soft / ctr / traffic / newyear. */
export const styleCategories: AiStyleCategory[] = (Array.isArray(raw.categories) ? (raw.categories as Array<Record<string, unknown>>) : [])
  .map((c) => ({ id: str(c.id), label: str(c.label) || str(c.id), note: str(c.note) || undefined }))
  .filter((c) => c.id !== "");

/** Типы раскладок (collage, listicle, …) — для фильтров в UI. */
export const styleTypes: AiStyleType[] = (Array.isArray(raw.types) ? (raw.types as Array<Record<string, unknown>>) : [])
  .map((t) => ({
    id: str(t.id),
    label: str(t.label) || str(t.id),
    ru: str(t.ru) || undefined,
    color: str(t.color) || undefined,
    desc: str(t.desc) || undefined,
  }))
  .filter((t) => t.id !== "");

/** Порядок категорий при сортировке результатов (как в generate-pin-prompt). */
export const CATEGORY_ORDER: Record<string, number> = { magazine: 0, soft: 1, ctr: 2, traffic: 3, modern2027: 4, newyear: 5 };
export const CATEGORY_ORDER_FALLBACK = 50;

/** Категория ИИ-стилей для блоговых / информационных статей. */
export const BLOG_AI_CATEGORY = "blog";
export const isBlogAiStyle = (id: string | null | undefined): boolean => !!id && BY_ID.get(id)?.category === BLOG_AI_CATEGORY;

/** Блоговые ИИ-стили под тип статьи; нет подходящих — все блоговые. */
export function blogAiStylesFor(kind: string | null | undefined): AiStyle[] {
  const all = STYLES.filter((s) => s.category === BLOG_AI_CATEGORY);
  const fit = kind ? all.filter((s) => (s.articleKinds ?? []).includes(kind)) : [];
  return fit.length ? fit : all;
}

export function getAiStyle(id: string): AiStyle | undefined {
  return BY_ID.get(id);
}

/** Все стили в порядке файла; при `category` — только из этой категории. */
export function listAiStyles(category?: string): AiStyle[] {
  return category ? STYLES.filter((s) => s.category === category) : STYLES.slice();
}

/** Сортировка по категории, затем по номеру — как сортировались ответы старой функции. */
export function sortByCategory<T extends { styleId: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => {
    const sa = BY_ID.get(a.styleId);
    const sb = BY_ID.get(b.styleId);
    const ca = sa ? CATEGORY_ORDER[sa.category] ?? CATEGORY_ORDER_FALLBACK : 99;
    const cb = sb ? CATEGORY_ORDER[sb.category] ?? CATEGORY_ORDER_FALLBACK : 99;
    if (ca !== cb) return ca - cb;
    return (sa?.num ?? 0) - (sb?.num ?? 0);
  });
}
