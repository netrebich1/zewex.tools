/**
 * План Canvas-пинов: какой стиль и на сколько фото собирать для каждого URL.
 * Правила: только форматы, которые страница может заполнить резервом фото; форматы 1/2/3/4
 * предпочтительнее 6; стили чередуются сбалансированно по прогону и не повторяются на странице;
 * внутри страницы число фото по возможности не повторяется. Детерминировано по seed.
 */
import { BalancedPicker, exclusionSet } from "@/lib/pins/plan/balanced";
import { mulberry32 } from "@/lib/pins/plan/seed";

/** Допустимые форматы Canvas по числу фото. */
export const CANVAS_PHOTO_COUNTS = [1, 2, 3, 4, 6] as const;
export type CanvasPhotoCount = (typeof CANVAS_PHOTO_COUNTS)[number];

export interface CanvasPlanPage {
  id: string;
  /** Сколько фото страницы доступно для коллажей (резерв + опубликованные). */
  poolPhotoCount: number;
  existingCanvasCount: number;
  /** Пер-URL квота (PinRunPage.canvasQuota); null/0 → perPage. */
  quota?: number | null;
  /** Тема страницы — для исключений (kind = canvas). */
  topic?: string;
  /** Стили уже собранных Canvas-пинов страницы — не повторять при дозаполнении. */
  existingStyleIds?: string[];
}

export interface CanvasStyleLike {
  id: string;
  /** Числа фото, которые умеет стиль (неподдерживаемые значения игнорируются). */
  counts: number[];
}

export interface CanvasPlanInput {
  pages: CanvasPlanPage[];
  /** Стили выбранных Canvas-наборов (уже отфильтрованные по набору страницы). */
  styles: CanvasStyleLike[];
  /** Сколько Canvas-пинов на URL по рецепту (mix.canvas). */
  perPage: number;
  seed: number;
  exclusions?: Array<{ topic: string; styleId: string }>;
  usedCounts?: Map<string, number>;
}

export interface CanvasPlanRow {
  pageId: string;
  styleId: string;
  photoCount: CanvasPhotoCount;
  sortOrder: number;
}

const isAllowedCount = (n: number): n is CanvasPhotoCount => (CANVAS_PHOTO_COUNTS as readonly number[]).includes(n);

/** Форматы стиля, которые страница может заполнить `pool` фото (только 1/2/3/4/6, по возрастанию). */
export function feasibleCounts(style: CanvasStyleLike, pool: number): CanvasPhotoCount[] {
  const set = new Set<CanvasPhotoCount>();
  for (const n of style.counts) if (isAllowedCount(n) && n <= pool) set.add(n);
  return [...set].sort((a, b) => a - b);
}

/** Строит строки будущих PinRunItem (engine CANVAS) только для недостающих пинов каждой страницы. */
export function planCanvasPins(input: CanvasPlanInput): CanvasPlanRow[] {
  const styles = input.styles.filter((s) => s.counts.some(isAllowedCount));
  if (!styles.length) return [];
  const rng = mulberry32(input.seed);
  const picker = new BalancedPicker(rng);
  picker.seedCounts(input.usedCounts);
  const excluded = exclusionSet(input.exclusions);
  const styleById = new Map(styles.map((s) => [s.id, s] as const));
  const out: CanvasPlanRow[] = [];

  for (const page of input.pages) {
    const existing = Math.max(0, Math.floor(page.existingCanvasCount || 0));
    const override = Number(page.quota ?? 0);
    const quota = override > 0 ? Math.floor(override) : Math.max(0, Math.floor(Number(input.perPage) || 0));
    const need = quota - existing;
    const pool = Math.max(0, Math.floor(page.poolPhotoCount || 0));
    if (need <= 0 || pool <= 0) continue;

    const topic = (page.topic || "").trim();
    const fit = styles.filter((s) => feasibleCounts(s, pool).length > 0).map((s) => s.id);
    const ok = fit.filter((id) => !excluded.has(`${topic}|${id}`));
    const candidates = ok.length ? ok : fit;
    if (!candidates.length) continue;

    const have = (page.existingStyleIds ?? []).filter(Boolean);
    const usedOnPage = new Set<CanvasPhotoCount>();
    picker.pick(candidates, need, have).forEach((styleId, i) => {
      const style = styleById.get(styleId);
      const feasible = style ? feasibleCounts(style, pool) : [];
      const photoCount = chooseCount(feasible, usedOnPage, rng);
      usedOnPage.add(photoCount);
      out.push({ pageId: page.id, styleId, photoCount, sortOrder: existing + i });
    });
  }
  return out;
}

/** Выбор числа фото: сначала форматы, ещё не взятые на странице; 1/2/3/4 важнее 6; среди равных — случайно. */
function chooseCount(feasible: CanvasPhotoCount[], usedOnPage: ReadonlySet<CanvasPhotoCount>, rng: () => number): CanvasPhotoCount {
  if (!feasible.length) return 1;
  const fresh = feasible.filter((n) => !usedOnPage.has(n));
  const base = fresh.length ? fresh : feasible;
  const small = base.filter((n) => n !== 6);
  const tier = small.length ? small : base;
  return tier[Math.floor(rng() * tier.length)];
}
