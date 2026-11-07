/**
 * Минимальная таблица макетов: движок использует только id и число фото
 * (ячейки считает layoutSolver). Порт CANVAS_LAYOUTS без геометрии.
 */
export type TextZone = "bottom" | "top" | "overlay";

export interface CanvasLayout { id: string; photos: number; textZone: TextZone }

export const CANVAS_LAYOUTS: CanvasLayout[] = [
  { id: "editorial", photos: 1, textZone: "bottom" },
  { id: "split", photos: 1, textZone: "bottom" },
  { id: "magazine", photos: 1, textZone: "top" },
  { id: "banner", photos: 1, textZone: "overlay" },
  { id: "overlay", photos: 1, textZone: "overlay" },
  { id: "ribbon", photos: 1, textZone: "bottom" },
  { id: "polaroid", photos: 1, textZone: "bottom" },
  { id: "arch", photos: 1, textZone: "bottom" },
  { id: "card", photos: 1, textZone: "bottom" },
  { id: "fullbleed", photos: 1, textZone: "overlay" },
  { id: "duo-v", photos: 2, textZone: "bottom" },
  { id: "duo-h", photos: 2, textZone: "bottom" },
  { id: "duo-ba", photos: 2, textZone: "bottom" },
  { id: "duo-big", photos: 2, textZone: "bottom" },
  { id: "hero3", photos: 3, textZone: "bottom" },
  { id: "stripes3", photos: 3, textZone: "bottom" },
  { id: "grid4", photos: 4, textZone: "bottom" },
  { id: "hero4", photos: 4, textZone: "bottom" },
  { id: "stripes4", photos: 4, textZone: "bottom" },
  { id: "grid4n", photos: 4, textZone: "bottom" },
  { id: "grid6", photos: 6, textZone: "bottom" },
  { id: "grid6w", photos: 6, textZone: "bottom" },
  { id: "hero6", photos: 6, textZone: "bottom" },
  { id: "grid6n", photos: 6, textZone: "bottom" },
  { id: "grid8", photos: 8, textZone: "bottom" },
  { id: "grid8w", photos: 8, textZone: "bottom" },
  { id: "hero8", photos: 8, textZone: "bottom" },
  { id: "grid8n", photos: 8, textZone: "bottom" },
  { id: "grid12", photos: 12, textZone: "bottom" },
  { id: "grid12w", photos: 12, textZone: "bottom" },
  { id: "grid12n", photos: 12, textZone: "bottom" },
  { id: "grid14", photos: 14, textZone: "bottom" },
  { id: "mosaic14", photos: 14, textZone: "bottom" },
];

export const LAYOUT_PHOTO_COUNTS = [1, 2, 3, 4, 6, 8, 12, 14];

export function getLayout(id: string): CanvasLayout {
  return CANVAS_LAYOUTS.find((l) => l.id === id) || CANVAS_LAYOUTS[0];
}

export function layoutsByPhotos(n: number): CanvasLayout[] {
  return CANVAS_LAYOUTS.filter((l) => l.photos === n);
}

/** Сколько фото нужно рецепту: photoCount, иначе макет, иначе число в id макета. */
export function recipePhotos(r: { photoCount?: number; layout?: string }): number {
  if (r.photoCount) return r.photoCount;
  const layout = r.layout ? CANVAS_LAYOUTS.find((l) => l.id === r.layout) : undefined;
  if (layout) return layout.photos;
  const n = Number((r.layout || "").match(/\d+/)?.[0]);
  return n > 0 ? n : 1;
}
