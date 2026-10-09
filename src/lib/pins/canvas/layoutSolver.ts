/** Решатель сцены (порт canvasLayoutSolver.ts): ячейки фото и текстовая зона. */
import { PIN_H, PIN_W, cropRatioForCell, type AccentType } from "./crop";

export interface SceneRect { x: number; y: number; w: number; h: number }
export type CanvasFamily =
  | "editorial-focus" | "modern-poster" | "clean-product" | "photo-story"
  | "balanced-collage" | "dense-inspiration" | "framed-editorial"
  | "text-tile" | "soft-lifestyle" | "neo-deco"
  | "hero-number" | "full-bleed-plate" | "full-bleed-badge"
  | "band-poster" | "contrast-overlay"
  /* v6 */
  | "brush-headline" | "blob-sticker" | "sticker-card" | "tape-zine"
  | "torn-paper" | "ticket-pop" | "arch-editorial" | "swiss-giant"
  | "doodle-pop" | "split-contrast" | "grid-caption" | "domain-bar"
  | "neon-night" | "chrome-gloss";

export type PlateKind =
  | "none" | "card" | "circle" | "band"
  | "brush" | "blob" | "sticker" | "tape" | "torn"
  | "ticket" | "arch" | "ribbon" | "frame-plate" | "glass";

export interface PhotoPlacement extends SceneRect {
  imageIndex: number;
  cropRatio: number;
  contain: boolean;
}

export interface SolvedScene {
  family: CanvasFamily;
  photos: PhotoPlacement[];
  textRect: SceneRect;
  textOnPhoto: boolean;
  plate: PlateKind;
  radius: number;
  gutter: number;
  align: "left" | "center";
  issues: string[];
}

export interface SolveInput {
  family: CanvasFamily;
  count: number;
  imageRatios: number[];
  textHeight: number;
  padding: number;
  radius: number;
  gutter: number;
  align: "left" | "center";
  accent?: AccentType;
  seed: number;
  /** Подложка под текстом на full-bleed макетах. */
  plate?: PlateKind;
  /** Вертикальный центр главного объекта (0..1) на первом фото — для overlay-семейств. */
  focusY?: number;
  /** Зона текста из стиля: top | bottom | side | middle | overlay. Если задана — важнее семейства. */
  zone?: "top" | "bottom" | "overlay" | "middle" | "side";
}

const rect = (x: number, y: number, w: number, h: number): SceneRect => ({ x, y, w, h });

/** Допустимая доля обрезки: фото должно заполнять ячейку, contain — крайний случай. */
export const MAX_CROP_SOFT = 0.42;
export const MAX_CROP_HARD = 0.58;

function rowsGrid(count: number, area: SceneRect, preferredCols: number): SceneRect[] {
  const rows = Math.ceil(count / preferredCols);
  const base = Math.floor(count / rows);
  const extra = count % rows;
  const cells: SceneRect[] = [];
  let used = 0;
  for (let row = 0; row < rows; row++) {
    const inRow = base + (row < extra ? 1 : 0);
    for (let col = 0; col < inRow; col++) {
      cells.push(rect(area.x + area.w * col / inRow, area.y + area.h * row / rows, area.w / inRow, area.h / rows));
      used++;
      if (used === count) return cells;
    }
  }
  return cells;
}

/** Средний кроп для набора ячеек при оптимальном сопоставлении с фото. */
function gridCost(cells: SceneRect[], ratios: number[]) {
  const pool = ratios.slice();
  let sum = 0;
  cells.forEach((cell) => {
    const cellAR = cell.w / Math.max(1, cell.h);
    let best = 0, bestCrop = Infinity;
    pool.forEach((r, i) => { const c = cropRatioForCell(r, cellAR); if (c < bestCrop) { bestCrop = c; best = i; } });
    if (pool.length) { pool.splice(best, 1); sum += bestCrop; }
  });
  return cells.length ? sum / cells.length : 1;
}

function familyCells(family: CanvasFamily, count: number, area: SceneRect, ratios: number[]): SceneRect[] {
  if (count === 1) return [area];
  const options: SceneRect[][] = [];
  if (family === "photo-story" && count >= 3 && count <= 4) {
    const heroW = area.w * 0.62;
    options.push([rect(area.x, area.y, heroW, area.h), ...Array.from({ length: count - 1 }, (_, i) =>
      rect(area.x + heroW, area.y + area.h * i / (count - 1), area.w - heroW, area.h / (count - 1)))]);
  }
  // Кандидаты сеток: берём ту, где суммарный кроп минимален для реальных AR фото.
  const maxCols = Math.min(count, count <= 4 ? 3 : count <= 9 ? 4 : 5);
  for (let cols = 1; cols <= maxCols; cols++) {
    if (Math.ceil(count / cols) > 6) continue;
    options.push(rowsGrid(count, area, cols));
  }
  if (!options.length) options.push(rowsGrid(count, area, 2));
  let best = options[0];
  let bestCost = Infinity;
  options.forEach((cells) => {
    const aspectPenalty = cells.some((c) => c.w / c.h > 3 || c.h / c.w > 3) ? 0.12 : 0;
    const cost = gridCost(cells, ratios) + aspectPenalty;
    if (cost < bestCost) { bestCost = cost; best = cells; }
  });
  return best;
}

function insetCells(cells: SceneRect[], gutter: number): SceneRect[] {
  const half = gutter / 2;
  return cells.map((c) => ({ x: c.x + half, y: c.y + half, w: c.w - gutter, h: c.h - gutter }));
}

/**
 * «Justified gallery»: ширина внутри ряда пропорциональна AR, высота ряда общая.
 */
function justifyRows(area: SceneRect, counts: number[], ratios: number[]): PhotoPlacement[] {
  const rows: number[][] = [];
  let at = 0;
  counts.forEach((n) => { rows.push(Array.from({ length: n }, () => at++)); });
  const sums = rows.map((row) => row.reduce((s, i) => s + Math.max(0.3, ratios[i] || 0.8), 0));
  const rawH = sums.map((s) => area.w / s);
  const total = rawH.reduce((a, b) => a + b, 0) || 1;
  const k = area.h / total;
  const out: PhotoPlacement[] = [];
  let y = area.y;
  rows.forEach((row, ri) => {
    const h = rawH[ri] * k;
    let x = area.x;
    row.forEach((idx, ci) => {
      const ar = Math.max(0.3, ratios[idx] || 0.8);
      const w = ci === row.length - 1 ? area.x + area.w - x : (area.w * ar) / sums[ri];
      const crop = cropRatioForCell(ar, w / Math.max(1, h));
      out.push({ x, y, w, h, imageIndex: idx, cropRatio: crop, contain: false });
      x += w;
    });
    y += h;
  });
  return out;
}

function countsFromCells(cells: SceneRect[]): number[] {
  const rows = new Map<number, number>();
  cells.forEach((c) => { const key = Math.round(c.y); rows.set(key, (rows.get(key) || 0) + 1); });
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
}

function insetPlacements(cells: PhotoPlacement[], gutter: number): PhotoPlacement[] {
  const half = gutter / 2;
  return cells.map((c) => ({ ...c, x: c.x + half, y: c.y + half, w: c.w - gutter, h: c.h - gutter }));
}

function assignImages(cells: SceneRect[], imageRatios: number[]): PhotoPlacement[] {
  const remaining = imageRatios.map((ratio, index) => ({ ratio, index }));
  return cells.map((cell) => {
    let bestAt = 0;
    let bestCrop = Infinity;
    remaining.forEach((img, i) => {
      const crop = cropRatioForCell(img.ratio, cell.w / cell.h);
      if (crop < bestCrop) { bestCrop = crop; bestAt = i; }
    });
    const [chosen] = remaining.splice(bestAt, 1);
    return { ...cell, imageIndex: chosen?.index ?? 0, cropRatio: bestCrop, contain: false };
  });
}

function overlaps(a: SceneRect, b: SceneRect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function sceneIssues(scene: Omit<SolvedScene, "issues">, textHeight: number): string[] {
  const issues: string[] = [];
  if (scene.textRect.h + 1 < textHeight) issues.push("текст не помещается");
  if (!scene.textOnPhoto && scene.photos.some((p) => overlaps(p, scene.textRect))) issues.push("текст пересекает фото");
  if (scene.photos.some((p) => p.w <= 12 || p.h <= 12)) issues.push("слишком узкая фото-ячейка");
  if (scene.photos.some((p) => p.cropRatio > MAX_CROP_HARD + 1e-3 && !p.contain)) issues.push("главный объект может быть срезан");
  if (scene.photos.some((p) => p.contain && p.cropRatio > 0.62)) issues.push("фото не заполняет ячейку");
  const minX = Math.min(scene.textRect.x, ...scene.photos.map((p) => p.x));
  const minY = Math.min(scene.textRect.y, ...scene.photos.map((p) => p.y));
  const maxX = Math.max(scene.textRect.x + scene.textRect.w, ...scene.photos.map((p) => p.x + p.w));
  const maxY = Math.max(scene.textRect.y + scene.textRect.h, ...scene.photos.map((p) => p.y + p.h));
  const coverage = ((maxX - minX) * (maxY - minY)) / (PIN_W * PIN_H);
  if (coverage < 0.9) issues.push("крупная пустая область");
  return issues;
}

export function solveCanvasScene(input: SolveInput): SolvedScene {
  const p = Math.max(36, Math.min(84, input.padding));
  const textH = Math.max(210, Math.min(PIN_H * 0.42, input.textHeight + 72));
  const OVERLAY_FAMILIES = new Set<CanvasFamily>([
    "modern-poster", "neo-deco", "full-bleed-plate", "full-bleed-badge",
    "band-poster", "contrast-overlay",
    "brush-headline", "blob-sticker", "sticker-card", "torn-paper",
    "ticket-pop", "neon-night", "chrome-gloss",
  ]);
  const overlay = input.zone ? input.zone === "overlay" : OVERLAY_FAMILIES.has(input.family);
  const plate: PlateKind = overlay ? (input.plate ?? "none") : "none";
  const side = input.zone ? input.zone === "side" && input.count <= 2 : input.family === "clean-product" && input.count === 1;
  let textRect: SceneRect;
  let photoArea: SceneRect;

  if (overlay) {
    photoArea = rect(0, 0, PIN_W, PIN_H);
    const CENTERED = new Set<PlateKind>(["circle", "card", "blob", "sticker", "ticket", "frame-plate"]);
    const BOTTOM = new Set<PlateKind>(["band", "ribbon", "arch"]);
    if (plate === "circle" || plate === "blob") {
      const size = Math.min(PIN_W - p * 2, Math.max(textH + 120, PIN_W * 0.74));
      textRect = rect((PIN_W - size) / 2 + 46, (PIN_H - size) / 2 + (size - textH) / 2, size - 92, textH);
    } else if (CENTERED.has(plate)) {
      const w = PIN_W - p * 2.6;
      textRect = rect((PIN_W - w) / 2, (PIN_H - textH) / 2, w, textH);
    } else if (BOTTOM.has(plate)) {
      textRect = rect(p, PIN_H - textH - p * 0.8, PIN_W - p * 2, textH);
    } else if (plate === "brush" || plate === "tape" || plate === "torn" || plate === "glass") {
      // Плоские ленты живут в верхней трети либо по центру — зависит от объекта.
      const low = (input.focusY ?? 0.5) > 0.55;
      textRect = low
        ? rect(p, p * 1.4, PIN_W - p * 2, textH)
        : rect(p, PIN_H * 0.56 - textH / 2, PIN_W - p * 2, textH);
    } else {
      // Главный объект внизу кадра — текст уходит наверх.
      const low = (input.focusY ?? 0.5) > 0.58;
      textRect = low ? rect(p, p, PIN_W - p * 2, textH) : rect(p, PIN_H - textH - p, PIN_W - p * 2, textH);
    }
  } else if (side) {
    const textW = Math.min(410, Math.max(330, PIN_W * 0.38));
    textRect = rect(p, p, textW - p, PIN_H - p * 2);
    photoArea = rect(textW, 0, PIN_W - textW, PIN_H);
  } else {
    const TOP_TEXT = new Set<CanvasFamily>([
      "framed-editorial", "soft-lifestyle", "arch-editorial", "swiss-giant", "grid-caption",
    ]);
    const topText = input.zone ? input.zone === "top" || input.zone === "middle" : TOP_TEXT.has(input.family);

    if (topText) {
      textRect = rect(p, p, PIN_W - p * 2, textH);
      photoArea = rect(0, textH + p + 20, PIN_W, PIN_H - textH - p - 20);
    } else {
      let photoH = PIN_H - textH - 20;
      if (input.count === 1) {
        // Одиночное фото: высота фотозоны под пропорцию кадра, остаток — тексту.
        const ar = input.imageRatios[0] || 0.8;
        const ideal = PIN_W / Math.max(0.4, ar);
        photoH = Math.max(PIN_H * 0.46, Math.min(PIN_H - Math.max(210, input.textHeight + 56) - 20, ideal));
      }
      photoArea = rect(0, 0, PIN_W, photoH);
      textRect = rect(p, photoH + 20, PIN_W - p * 2, PIN_H - photoH - 20 - p);
    }
  }

  const raw = familyCells(input.family, input.count, photoArea, input.imageRatios.slice(0, input.count));
  const ratios = input.imageRatios.slice(0, input.count);
  const hero = input.family === "photo-story" && input.count >= 3 && input.count <= 4 && raw.length === input.count
    && Math.abs(raw[0].h - photoArea.h) < 1;
  const placements = hero
    ? assignImages(insetCells(raw, input.gutter), ratios)
    : insetPlacements(justifyRows(photoArea, countsFromCells(raw), ratios), input.gutter);
  const base = {
    family: input.family,
    photos: placements,
    textRect,
    textOnPhoto: overlay,
    plate,
    radius: input.radius,
    gutter: input.gutter,
    align: input.align,
  };
  return { ...base, issues: sceneIssues(base, input.textHeight) };
}
