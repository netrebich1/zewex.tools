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
};

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
export const CATEGORY_ORDER: Record<string, number> = { magazine: 0, soft: 1, ctr: 2, traffic: 3 };
export const CATEGORY_ORDER_FALLBACK = 50;

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
