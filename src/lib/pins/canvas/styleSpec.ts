/**
 * StyleSpec — одна модель Canvas-стиля вместо 14 понятий легаси.
 *
 * Стиль — это зафиксированный дизайн: раскладка, пара шрифтов, 1–4 палитры,
 * правила заголовка, подложка/цифра/кнопка/домен/рамка/выделение. Вариативность
 * при рендере даёт только seed (выбор палитры), фото и хук.
 *
 *  - `toRecipe(spec, seed, photoCount)` — детерминированно собирает CanvasRecipe
 *    той же формы, что выдавал canvasMixerV9 (kit, fonts, roleFonts, fontPair, …),
 *    чтобы перенесённый движок рендерил стиль без изменений.
 *  - `validateStyle(spec)` — правила вкуса из плана (≤2 семейства, ≤3 строки,
 *    фото 1/2/3/4/6, один «громкий» элемент, скрим 0.30–0.55, контраст 4.5/3).
 *  - `specFromRecipe(id, name, recipe)` — обратное отображение легаси-шаблона
 *    в спецификацию с «успокоением» (skew 0, тень none|soft, скрим в диапазоне,
 *    дудлы только если это единственный громкий элемент).
 *
 * Файл самодостаточен: каталоги раскладок/сеток и контраст встроены, чтобы не
 * зависеть от порта движка. Из него берутся только типы рецепта.
 */

import type { CanvasPalette, CanvasRecipe } from "./recipe";

/* ---------- производные типы из рецепта (не дублируем union'ы движка) ---------- */

type CanvasFamily = CanvasRecipe["family"];
type PlateKind = NonNullable<CanvasRecipe["plate"]>;
type KitSpec = NonNullable<CanvasRecipe["kit"]>;
type TextZone = CanvasRecipe["textZone"];
type CtaArrow = NonNullable<CanvasRecipe["ctaArrow"]>;
type CtaStyle = CanvasRecipe["ctaStyle"];
type NumberMode = NonNullable<CanvasRecipe["numberMode"]>;

/* ---------- публичные типы ---------- */

export type StyleCount = 1 | 2 | 3 | 4 | 6;
export const STYLE_COUNTS: readonly StyleCount[] = [1, 2, 3, 4, 6];

/** Поле пина по плану: 56 px, константа движка. */
export const STYLE_PADDING = 56;
export const OVERLAY_MIN = 0.3;
export const OVERLAY_MAX = 0.55;
export const OVERLAY_DEFAULT = 0.42;
export const TITLE_MAX_LINES = 3;
export const CONTRAST_TEXT = 4.5;
export const CONTRAST_ACCENT = 3;

export interface StyleFonts {
  display: string;
  sans: string;
  body: string;
  script?: string;
}

export interface StyleRoleFonts {
  kicker?: string;
  number?: string;
  cta?: string;
  subtext?: string;
}

export interface StyleTitle {
  font: "display" | "sans";
  case: "upper" | "title" | "sentence";
  weight: number;
  align: "left" | "center";
  /** Максимум строк заголовка (правило вкуса: ≤ 3). */
  maxLines: number;
  /** Разрядка, px. */
  tracking?: number;
  /** Красить последнее слово акцентом (только если акцент читается на фоне). */
  accentWord?: boolean;
}

export interface StylePlate {
  /** id из PLATE_KITS: `plate-<shape>-<deco>`. */
  kit: string;
}

export interface StyleNumber {
  /** id из NUMBER_KITS: `num-<shape>-<treat>` или `num-plain[-treat]`. */
  kit: string;
  /** id из NUMBER_PLACEMENTS: `np-*`. */
  place: string;
  mode: "required" | "optional";
}

export interface StyleCta {
  /** id из CTA_KITS: `cta-<shape>-<fill>`. */
  kit: string;
  arrow: CtaArrow;
  case: "upper" | "title";
}

/** Альтернативный набор шрифтов стиля (seed выбирает среди основного и альтернатив). */
export interface StyleFontSet {
  pair: string;
  fonts: StyleFonts;
  roleFonts?: StyleRoleFonts;
}

export interface StyleGrid {
  gutter: number;
  radius: number;
}

export interface StyleSpec {
  /** Ревизия формата спецификации. */
  rev: number;
  name: string;
  tags: string[];
  /** Допустимые количества фото: подмножество 1/2/3/4/6. */
  counts: StyleCount[];
  /** id раскладки из LAYOUT_KITS (`lay-*`). */
  layout: string;
  /** id пары шрифтов (CANVAS_FONT_PAIRS). */
  pair: string;
  /** Семейства пары — фиксируются в спецификации, чтобы не зависеть от каталога. */
  fonts: StyleFonts;
  /** Шрифты по ролям; если нет — выводятся из пары (кикер/CTA/подтекст = sans, цифра = display). */
  roleFonts?: StyleRoleFonts;
  /** Подобранные альтернативные наборы шрифтов (не все подряд, а подходящие стилю). */
  fontSets?: StyleFontSet[];
  /** 1–4 палитры; seed выбирает одну. */
  palettes: CanvasPalette[];
  /** Источник цвета: фиксированная палитра или палитра + оттенок из фото. */
  color: "palette" | "photo-tint";
  title: StyleTitle;
  plate?: StylePlate;
  number?: StyleNumber;
  cta?: StyleCta;
  /** id из DOMAIN_KITS (`dom-*`). */
  domain: string;
  /** id из FRAME_KITS (`frm-*`), без рамки — не задавать. */
  frame?: string;
  /** id из HIGHLIGHT_KITS (`hl-*`), без выделения — не задавать. */
  highlight?: string;
  /** Скрим под текстом на фото (только для overlay-раскладок), 0.30–0.55. */
  overlay?: number;
  grain?: boolean;
  /** Кикер рукописным шрифтом пары. */
  kickerScript?: boolean;
  /** Рисованные акценты вокруг текста — «громкий» элемент. */
  doodles?: boolean;
  /** id из SUBTEXT_KITS (`sub-*`); по умолчанию sub-script при kickerScript, иначе sub-plain. */
  subtext?: string;
  grid?: StyleGrid;
  useAccent2?: boolean;
  shadow?: "none" | "soft";
  /** Легаси-шаблоны, из которых стиль получен (для миграции наборов). */
  sourceIds?: string[];
}

/* ---------- каталоги (копии из canvasKit, только то, что нужно для сборки) ---------- */

interface LayoutInfo { family: CanvasFamily; zone: TextZone; overlay: boolean; counts: number[] }

const LAYOUTS: Record<string, LayoutInfo> = {
  "lay-bottom-editorial": { family: "editorial-focus", zone: "bottom", overlay: false, counts: [1, 2, 3, 4, 6, 9] },
  "lay-top-editorial": { family: "framed-editorial", zone: "top", overlay: false, counts: [2, 3, 4, 6, 9, 12] },
  "lay-swiss-giant": { family: "swiss-giant", zone: "top", overlay: false, counts: [2, 3, 4, 6, 9] },
  "lay-arch": { family: "arch-editorial", zone: "top", overlay: false, counts: [1, 2, 3, 4, 6] },
  "lay-grid-caption": { family: "grid-caption", zone: "top", overlay: false, counts: [4, 6, 8, 9, 12] },
  "lay-hero-story": { family: "photo-story", zone: "bottom", overlay: false, counts: [3, 4] },
  "lay-dense": { family: "dense-inspiration", zone: "bottom", overlay: false, counts: [6, 8, 9, 12, 14] },
  "lay-balanced": { family: "balanced-collage", zone: "bottom", overlay: false, counts: [4, 6, 8, 9] },
  "lay-side": { family: "clean-product", zone: "side", overlay: false, counts: [1] },
  "lay-soft": { family: "soft-lifestyle", zone: "top", overlay: false, counts: [2, 3, 4, 6] },
  "lay-tile": { family: "text-tile", zone: "bottom", overlay: false, counts: [2, 3, 4, 6, 9] },
  "lay-split": { family: "split-contrast", zone: "bottom", overlay: false, counts: [2, 3, 4, 6, 9] },
  "lay-overlay-center": { family: "modern-poster", zone: "overlay", overlay: true, counts: [1, 2, 3, 4, 6, 9] },
  "lay-overlay-band": { family: "band-poster", zone: "overlay", overlay: true, counts: [1, 2, 3] },
  "lay-overlay-plate": { family: "full-bleed-plate", zone: "overlay", overlay: true, counts: [4, 6, 9] },
  "lay-overlay-badge": { family: "full-bleed-badge", zone: "overlay", overlay: true, counts: [6, 9, 12, 14] },
  "lay-brush": { family: "brush-headline", zone: "overlay", overlay: true, counts: [1, 2, 3, 4, 6, 9] },
  "lay-neon": { family: "neon-night", zone: "overlay", overlay: true, counts: [1, 2, 3, 4, 6] },
  "lay-sticker": { family: "sticker-card", zone: "overlay", overlay: true, counts: [4, 6, 9] },
  "lay-tape": { family: "tape-zine", zone: "overlay", overlay: true, counts: [2, 3, 4, 6] },
  "lay-hero-number": { family: "hero-number", zone: "bottom", overlay: false, counts: [1, 2, 3, 4, 6] },
  "lay-hero-number-top": { family: "hero-number", zone: "top", overlay: false, counts: [2, 3, 4, 6, 9] },
  "lay-neo-deco": { family: "neo-deco", zone: "top", overlay: false, counts: [1, 2, 3, 4, 6] },
  "lay-neo-deco-bottom": { family: "neo-deco", zone: "bottom", overlay: false, counts: [2, 3, 4, 6] },
  "lay-contrast": { family: "contrast-overlay", zone: "overlay", overlay: true, counts: [1, 2, 3, 4, 6, 9] },
  "lay-blob": { family: "blob-sticker", zone: "overlay", overlay: true, counts: [4, 6, 9] },
  "lay-torn": { family: "torn-paper", zone: "overlay", overlay: true, counts: [2, 3, 4, 6, 9] },
  "lay-torn-bottom": { family: "torn-paper", zone: "bottom", overlay: false, counts: [3, 4, 6, 9] },
  "lay-ticket": { family: "ticket-pop", zone: "overlay", overlay: true, counts: [2, 3, 4, 6] },
  "lay-doodle": { family: "doodle-pop", zone: "top", overlay: false, counts: [2, 3, 4, 6, 9] },
  "lay-domain-bar": { family: "domain-bar", zone: "bottom", overlay: false, counts: [2, 3, 4, 6, 9, 12] },
  "lay-chrome": { family: "chrome-gloss", zone: "overlay", overlay: true, counts: [1, 2, 3, 4] },
  "lay-mid-editorial": { family: "editorial-focus", zone: "middle", overlay: false, counts: [2, 4, 6] },
  "lay-mid-swiss": { family: "swiss-giant", zone: "middle", overlay: false, counts: [2, 4, 6, 8] },
  "lay-side-story": { family: "photo-story", zone: "side", overlay: false, counts: [1, 2] },
  "lay-side-clean": { family: "clean-product", zone: "side", overlay: false, counts: [1, 2, 3] },
  "lay-dense-overlay": { family: "dense-inspiration", zone: "overlay", overlay: true, counts: [8, 9, 12, 14] },
  "lay-grid-overlay": { family: "grid-caption", zone: "overlay", overlay: true, counts: [6, 8, 9, 12] },
  "lay-split-top": { family: "split-contrast", zone: "top", overlay: false, counts: [2, 3, 4, 6] },
  "lay-band-bottom": { family: "band-poster", zone: "bottom", overlay: false, counts: [1, 2, 3, 4] },
  "lay-arch-bottom": { family: "arch-editorial", zone: "bottom", overlay: false, counts: [2, 3, 4, 6] },
  "lay-sticker-bottom": { family: "sticker-card", zone: "bottom", overlay: false, counts: [3, 4, 6, 9] },
  "lay-brush-bottom": { family: "brush-headline", zone: "bottom", overlay: false, counts: [2, 3, 4, 6] },
  "lay-tile-top": { family: "text-tile", zone: "top", overlay: false, counts: [2, 3, 4, 6, 9] },
};

export const STYLE_LAYOUT_IDS: readonly string[] = Object.keys(LAYOUTS);

/** Раскладки, построенные вокруг цифры / где цифра мешает (как layoutNumberNeed в canvasKit). */
const NUMBER_REQUIRED = new Set([
  "lay-hero-number", "lay-hero-number-top", "lay-overlay-badge", "lay-dense-overlay",
  "lay-blob", "lay-sticker", "lay-sticker-bottom", "lay-ticket", "lay-neo-deco", "lay-neo-deco-bottom",
]);
const NUMBER_NONE = new Set([
  "lay-side", "lay-side-story", "lay-side-clean", "lay-arch", "lay-arch-bottom",
  "lay-swiss-giant", "lay-soft", "lay-mid-editorial", "lay-mid-swiss",
  "lay-band-bottom", "lay-overlay-band", "lay-chrome", "lay-domain-bar", "lay-grid-caption",
]);
function layoutNumberNeed(layoutId: string): "required" | "optional" | "none" {
  if (NUMBER_REQUIRED.has(layoutId)) return "required";
  if (NUMBER_NONE.has(layoutId)) return "none";
  return "optional";
}

/** Спокойные подачи цифры (CALM_NUMBER_PLACEMENTS в canvasKit). */
const CALM_PLACEMENTS = new Set(["np-inline", "np-above", "np-baseline", "np-side"]);
const PLACEMENTS = new Set([
  "np-inline", "np-above", "np-corner-tl", "np-corner-tr", "np-corner-bl", "np-corner-br", "np-ghost", "np-side", "np-baseline",
]);

/** Формы подложек → базовый вид для решателя (PLATE_SHAPES.base). */
const PLATE_BASE: Record<string, PlateKind> = {
  rect: "card", pill: "band", arch: "arch", "arch-down": "arch", slab: "band", diagonal: "band",
  notch: "band", chevron: "ribbon", tape: "tape", brush: "brush", torn: "torn", blob: "blob",
  ticket: "ticket", hexagon: "card", wave: "band", step: "card", ribbon: "ribbon", glass: "glass", tag: "band",
};

/** Сетки фото: зазор × радиус (GRID_KITS). */
const GRID_GUTTERS: Array<[string, number]> = [
  ["flush", 0], ["hair", 4], ["tight", 8], ["snug", 12], ["soft", 16], ["card", 22], ["airy", 28], ["loose", 34],
];
const GRID_RADII: Array<[string, number]> = [
  ["sharp", 0], ["micro", 6], ["small", 12], ["mid", 26], ["large", 42], ["arch", 64],
];
function nearestGrid(gutter: number, radius: number): { id: string; gutter: number; radius: number } {
  let best = { id: "grid-flush-sharp", gutter: 0, radius: 0 };
  let bestD = Infinity;
  for (const [gi, g] of GRID_GUTTERS) for (const [ri, r] of GRID_RADII) {
    if (g === 0 && r > 26) continue;
    const d = Math.abs(g - gutter) * 2 + Math.abs(r - radius);
    if (d < bestD) { bestD = d; best = { id: `grid-${gi}-${ri}`, gutter: g, radius: r }; }
  }
  return best;
}

/** Первая раскладка легаси-каталога CANVAS_LAYOUTS на каждое число фото (layoutIdForCount). */
const LEGACY_LAYOUT_FOR_COUNT: Record<number, string> = { 1: "editorial", 2: "duo-v", 3: "hero3", 4: "grid4", 6: "grid6" };

/* ---------- контраст (порт из canvasPalette.ts, приватно) ---------- */

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function lin(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Палитра с заполненными замерами контраста и флагом accentAsText. */
function measurePalette(p: CanvasPalette): CanvasPalette {
  const fgOnBg = round2(contrast(p.fg, p.bg));
  const accentOnBg = round2(contrast(p.accent, p.bg));
  const onAccentOnAccent = round2(contrast(p.onAccent, p.accent));
  return { ...p, accentAsText: accentOnBg >= CONTRAST_TEXT, contrast: { accentOnBg, fgOnBg, onAccentOnAccent } };
}

/* ---------- разбор id элементов ---------- */

function plateParts(kit: string | undefined): { shape: string; deco: string } | null {
  if (!kit || kit === "kit-none") return null;
  const m = /^plate-([a-z-]+?)-(flat|offset|stack|inner|outline|dotted|split|grad)$/.exec(kit);
  return m ? { shape: m[1], deco: m[2] } : null;
}
function numberParts(kit: string): { shape: string; treat: string } {
  if (kit === "num-plain") return { shape: "none", treat: "solid" };
  const plain = /^num-plain-([a-z]+)$/.exec(kit);
  if (plain) return { shape: "none", treat: plain[1] };
  const m = /^num-([a-z]+)-([a-z]+)$/.exec(kit);
  return m ? { shape: m[1], treat: m[2] } : { shape: "none", treat: "solid" };
}
/** Порт ctaMetricFor из canvasKit. */
function ctaMetricFor(id: string): CtaStyle {
  const m = /^cta-([a-z]+)-([a-z]+)$/.exec(id);
  if (!m) return "pill";
  const [, shape, fill] = m;
  if (shape === "text") return fill === "solid" ? "line" : "frame";
  if (shape === "bar") return "bar";
  if (fill === "outline" || fill === "dotted" || fill === "corners") return "outline";
  if (shape === "pill") return "pill";
  return "block";
}

/** Громкие элементы по правилу «один громкий элемент на пин». */
const LOUD_NUMBER_TREATS = new Set(["offset", "double", "dashed", "rays"]);
const LOUD_NUMBER_SHAPES = new Set(["burst", "ribbon"]);

export interface LoudElements { number: boolean; plate: boolean; highlight: boolean; doodles: boolean }

export function loudElements(spec: Pick<StyleSpec, "number" | "plate" | "highlight" | "doodles">): LoudElements {
  const num = spec.number ? numberParts(spec.number.kit) : null;
  const plate = plateParts(spec.plate?.kit);
  return {
    number: !!num && (LOUD_NUMBER_TREATS.has(num.treat) || LOUD_NUMBER_SHAPES.has(num.shape) || spec.number?.place === "np-ghost"),
    plate: !!plate && plate.deco !== "flat",
    highlight: !!spec.highlight && spec.highlight.startsWith("hl-fill-"),
    doodles: !!spec.doodles,
  };
}
const loudCount = (l: LoudElements) => Number(l.number) + Number(l.plate) + Number(l.highlight) + Number(l.doodles);

/* ---------- toRecipe ---------- */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isStyleCount = (n: number): n is StyleCount => (STYLE_COUNTS as readonly number[]).includes(n);

/** Ближайшее допустимое число фото: не больше запрошенного, иначе минимальное. */
export function pickCount(spec: StyleSpec, photoCount: number): StyleCount {
  const counts = [...spec.counts].sort((a, b) => a - b);
  if (!counts.length) return 1;
  const fit = counts.filter((c) => c <= photoCount);
  return fit.length ? fit[fit.length - 1] : counts[0];
}

/** Индекс палитры по seed (только это и выбирает seed). */
export function paletteIndex(spec: StyleSpec, seed: number): number {
  const n = spec.palettes.length;
  if (n <= 1) return 0;
  // Лёгкое перемешивание, чтобы соседние seed не шли по кругу подряд.
  let h = (seed >>> 0) || 1;
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
  return (h >>> 0) % n;
}

/** Все наборы шрифтов стиля: основной + альтернативы. */
export function allFontSets(spec: StyleSpec): StyleFontSet[] {
  return [{ pair: spec.pair, fonts: spec.fonts, ...(spec.roleFonts ? { roleFonts: spec.roleFonts } : {}) }, ...(spec.fontSets ?? [])];
}

/** Индекс набора шрифтов по seed (другая соль, чем у палитры, чтобы не коррелировали). */
export function fontSetIndex(spec: StyleSpec, seed: number): number {
  const n = 1 + (spec.fontSets?.length ?? 0);
  if (n <= 1) return 0;
  let h = ((seed >>> 0) ^ 0x9e3779b9) || 1;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) % n;
}

export function toRecipe(spec: StyleSpec, seed: number, photoCount: number): CanvasRecipe {
  const layout = LAYOUTS[spec.layout] ?? LAYOUTS["lay-bottom-editorial"];
  const fs = allFontSets(spec)[fontSetIndex(spec, seed)];
  const count = pickCount(spec, photoCount);
  const palette = measurePalette(spec.palettes[paletteIndex(spec, seed)] ?? spec.palettes[0]);
  const grid = nearestGrid(spec.grid?.gutter ?? 16, spec.grid?.radius ?? 12);

  const need = layoutNumberNeed(spec.layout);
  const numberMode: NumberMode = !spec.number || need === "none" ? "none"
    : need === "required" || spec.number.mode === "required" ? "required" : "optional";
  const numPlace = numberMode === "none" ? "np-inline"
    : spec.number && PLACEMENTS.has(spec.number.place) && !(spec.number.place === "np-ghost" && layout.overlay) ? spec.number.place : "np-inline";

  const plateKit = spec.plate?.kit ?? "kit-none";
  const plateShape = plateParts(plateKit)?.shape;
  const plateBase: PlateKind = plateShape ? (PLATE_BASE[plateShape] ?? "card") : "none";
  const ctaKit = spec.cta?.kit ?? "cta-text-solid";
  const subtext = spec.subtext ?? (spec.kickerScript ? "sub-script" : "sub-plain");
  const scriptKicker = !!spec.kickerScript || subtext === "sub-script";

  const roleFonts = {
    kicker: fs.roleFonts?.kicker ?? fs.fonts.sans,
    number: fs.roleFonts?.number ?? fs.fonts.display,
    cta: fs.roleFonts?.cta ?? fs.fonts.sans,
    subtext: fs.roleFonts?.subtext ?? fs.fonts.sans,
  };

  const kit: KitSpec = {
    plate: plateKit,
    number: spec.number?.kit ?? "num-plain",
    highlight: spec.highlight ?? "hl-none",
    cta: ctaKit,
    subtext,
    grid: grid.id,
    layout: spec.layout in LAYOUTS ? spec.layout : "lay-bottom-editorial",
    shadow: spec.shadow ?? "none",
    skew: 0,
    frame: spec.frame ?? "frm-none-0-accent",
    numPlace,
    useAccent2: !!spec.useAccent2 && !!palette.accent2,
    domain: spec.domain || "dom-plain",
  };

  return {
    v: 7,
    kit,
    roleFonts,
    family: layout.family,
    layout: LEGACY_LAYOUT_FOR_COUNT[count] ?? `v5-grid-${count}`,
    photoCount: count,
    palette,
    fonts: { display: fs.fonts.display, sans: fs.fonts.sans, body: fs.fonts.body, ...(fs.fonts.script ? { script: fs.fonts.script } : {}) },
    fontPair: fs.pair,
    titleFont: spec.title.font,
    titleCase: spec.title.case,
    titleWeight: spec.title.weight,
    titleAlign: spec.title.align,
    textZone: layout.zone,
    padding: STYLE_PADDING,
    radius: grid.radius,
    gutter: count === 1 ? 0 : grid.gutter,
    highlight: "none",
    decor: spec.grain ? "grain" : "none",
    numberMode,
    numberStyle: numberMode === "none" ? "none" : "hero",
    plate: plateBase,
    yearStyle: "none",
    ctaStyle: ctaMetricFor(ctaKit),
    ctaArrow: spec.cta?.arrow ?? "none",
    ctaCase: spec.cta?.case ?? (spec.title.case === "title" ? "title" : "upper"),
    texture: spec.grain ? 0.05 : 0,
    overlay: layout.overlay ? clamp(spec.overlay ?? OVERLAY_DEFAULT, OVERLAY_MIN, OVERLAY_MAX) : 0,
    colorSource: spec.color === "photo-tint" ? "photo" : "palette",
    doodles: !!spec.doodles,
    titleAccentWord: !!spec.title.accentWord && !!palette.accentAsText,
    domainBar: false,
    scriptKicker,
    ...(spec.title.tracking !== undefined ? { titleTracking: spec.title.tracking } : {}),
  };
}

/* ---------- validateStyle ---------- */

/** Семейства, которые реально попадут на пин: заголовок + роли. */
function usedFamilies(spec: StyleSpec, fs: StyleFontSet = { pair: spec.pair, fonts: spec.fonts, roleFonts: spec.roleFonts }): string[] {
  const title = spec.title.font === "sans" ? fs.fonts.sans : fs.fonts.display;
  const roles = [
    fs.roleFonts?.kicker ?? fs.fonts.sans,
    fs.roleFonts?.number ?? fs.fonts.display,
    fs.roleFonts?.cta ?? fs.fonts.sans,
    fs.roleFonts?.subtext ?? fs.fonts.sans,
  ];
  const out = new Set<string>([title]);
  if (spec.number) out.add(roles[1]);
  out.add(roles[0]); out.add(roles[2]); out.add(roles[3]);
  if (spec.kickerScript && fs.fonts.script) out.add(fs.fonts.script);
  return [...out].filter(Boolean);
}

export function validateStyle(spec: StyleSpec): string[] {
  const out: string[] = [];
  if (!spec.name?.trim()) out.push("Нет названия стиля");
  if (!Number.isInteger(spec.rev) || spec.rev < 1) out.push("rev должен быть целым ≥ 1");

  const layout = LAYOUTS[spec.layout];
  if (!layout) out.push(`Неизвестная раскладка ${spec.layout}`);

  if (!spec.counts.length) out.push("Не задано число фото");
  for (const c of spec.counts) {
    if (!isStyleCount(c)) out.push(`Число фото ${c} вне допустимых 1/2/3/4/6`);
    else if (layout && !layout.counts.includes(c)) out.push(`Раскладка ${spec.layout} не умеет ${c} фото`);
  }
  if (new Set(spec.counts).size !== spec.counts.length) out.push("Число фото повторяется");

  if (!spec.pair) out.push("Не задана пара шрифтов");
  if (!spec.fonts?.display || !spec.fonts?.sans || !spec.fonts?.body) out.push("Пара шрифтов неполная (display/sans/body)");
  for (const fs of allFontSets(spec)) {
    if (!fs.pair || !fs.fonts?.display || !fs.fonts?.sans || !fs.fonts?.body) { out.push(`Набор шрифтов ${fs.pair || "?"} неполный`); continue; }
    const fams = usedFamilies(spec, fs);
    if (fams.length > 2) out.push(`Слишком много шрифтов на пине (${fs.pair}): ${fams.join(", ")} (допустимо 2)`);
    if (spec.kickerScript && !fs.fonts.script && !spec.subtext) out.push(`Рукописный кикер без script-шрифта в наборе ${fs.pair}`);
  }
  if ((spec.fontSets?.length ?? 0) > 4) out.push(`Наборов шрифтов ${spec.fontSets!.length}, допустимо до 4 альтернатив`);

  if (!Number.isInteger(spec.title.maxLines) || spec.title.maxLines < 1 || spec.title.maxLines > TITLE_MAX_LINES) {
    out.push(`Заголовок: maxLines ${spec.title.maxLines}, допустимо 1–${TITLE_MAX_LINES}`);
  }
  if (spec.title.weight < 100 || spec.title.weight > 900 || spec.title.weight % 100 !== 0) out.push(`Начертание заголовка ${spec.title.weight} вне 100–900`);
  if (spec.title.tracking !== undefined && Math.abs(spec.title.tracking) > 8) out.push(`Разрядка заголовка ${spec.title.tracking} слишком большая`);

  if (!spec.palettes.length || spec.palettes.length > 4) out.push(`Палитр ${spec.palettes.length}, нужно 1–4`);
  spec.palettes.forEach((p, i) => {
    const label = p.id || `#${i + 1}`;
    const colors: Array<[string, string | undefined]> = [["bg", p.bg], ["fg", p.fg], ["accent", p.accent], ["soft", p.soft], ["onAccent", p.onAccent], ["accent2", p.accent2]];
    const bad = colors.filter(([k, v]) => (k !== "accent2" || v !== undefined) && !(typeof v === "string" && HEX_RE.test(v)));
    if (bad.length) { out.push(`Палитра ${label}: не hex-цвета ${bad.map(([k]) => k).join(", ")}`); return; }
    const fgOnBg = contrast(p.fg, p.bg);
    if (fgOnBg < CONTRAST_TEXT) out.push(`Палитра ${label}: текст на фоне ${round2(fgOnBg)} < ${CONTRAST_TEXT}`);
    const onAcc = contrast(p.onAccent, p.accent);
    if (onAcc < CONTRAST_ACCENT) out.push(`Палитра ${label}: текст на акценте ${round2(onAcc)} < ${CONTRAST_ACCENT}`);
    if (spec.title.accentWord && contrast(p.accent, p.bg) < CONTRAST_TEXT) {
      out.push(`Палитра ${label}: акцентное слово не читается на фоне (${round2(contrast(p.accent, p.bg))})`);
    }
  });
  if (new Set(spec.palettes.map((p) => p.id)).size !== spec.palettes.length) out.push("Повторяющиеся id палитр");

  if (spec.plate && !plateParts(spec.plate.kit)) out.push(`Подложка ${spec.plate.kit}: ожидается plate-<shape>-<deco>`);
  if (spec.plate && layout && !layout.overlay) out.push("Подложка задана для раскладки без текста поверх фото");
  if (spec.number) {
    if (!/^num-[a-z-]+$/.test(spec.number.kit)) out.push(`Цифра ${spec.number.kit}: ожидается num-<shape>-<treat>`);
    if (!PLACEMENTS.has(spec.number.place)) out.push(`Неизвестное размещение цифры ${spec.number.place}`);
    else if (!CALM_PLACEMENTS.has(spec.number.place) && spec.number.place !== "np-ghost") out.push(`Размещение цифры ${spec.number.place} не из спокойных (${[...CALM_PLACEMENTS].join(", ")})`);
    if (layout && layoutNumberNeed(spec.layout) === "none") out.push(`Раскладка ${spec.layout} без места под цифру`);
  } else if (layout && layoutNumberNeed(spec.layout) === "required") {
    out.push(`Раскладка ${spec.layout} построена вокруг цифры — задайте number`);
  }
  if (spec.cta && !/^cta-[a-z]+-[a-z]+$/.test(spec.cta.kit)) out.push(`Кнопка ${spec.cta.kit}: ожидается cta-<shape>-<fill>`);
  if (!/^dom-[a-z-]+$/.test(spec.domain || "")) out.push(`Подача домена ${spec.domain}: ожидается dom-*`);
  if (spec.frame && !/^frm-[a-z]+-\d+-[a-z0-9]+$/.test(spec.frame)) out.push(`Рамка ${spec.frame}: ожидается frm-<kind>-<width>-<color>`);
  if (spec.frame?.startsWith("frm-none")) out.push("Рамка frm-none: уберите поле frame");
  if (spec.highlight && !/^hl-(fill|line|frame|side)-[a-z-]+$/.test(spec.highlight)) out.push(`Выделение ${spec.highlight}: ожидается hl-<kind>-<variant>`);
  if (spec.highlight === "hl-none") out.push("Выделение hl-none: уберите поле highlight");
  if (spec.subtext && !/^sub-[a-z-]+$/.test(spec.subtext)) out.push(`Доп. текст ${spec.subtext}: ожидается sub-*`);
  if (spec.useAccent2 && spec.palettes.some((p) => !p.accent2)) out.push("useAccent2, но не у всех палитр есть accent2");

  const loud = loudElements(spec);
  const n = loudCount(loud);
  if (n > 1) {
    const names = [loud.number && "цифра", loud.plate && "декор подложки", loud.highlight && "заливка выделения", loud.doodles && "дудлы"].filter(Boolean);
    out.push(`Громких элементов ${n}, допустим один: ${names.join(", ")}`);
  }

  if (layout?.overlay) {
    if (spec.overlay === undefined) out.push("Для раскладки с текстом поверх фото задайте overlay");
    else if (spec.overlay < OVERLAY_MIN || spec.overlay > OVERLAY_MAX) out.push(`Скрим ${spec.overlay} вне ${OVERLAY_MIN}–${OVERLAY_MAX}`);
  } else if (spec.overlay !== undefined) {
    out.push("overlay задан для раскладки без текста поверх фото");
  }
  if (spec.shadow && spec.shadow !== "none" && spec.shadow !== "soft") out.push(`Тень ${String(spec.shadow)}: допустимо none|soft`);
  if (spec.grid) {
    if (spec.grid.gutter < 0 || spec.grid.gutter > 34) out.push(`Зазор сетки ${spec.grid.gutter} вне 0–34`);
    if (spec.grid.radius < 0 || spec.grid.radius > 64) out.push(`Радиус сетки ${spec.grid.radius} вне 0–64`);
  }
  return out;
}

/* ---------- specFromRecipe ---------- */

/** Раскладка легаси-рецепта: из kit.layout, иначе по семейству и зоне текста. */
function layoutOfRecipe(r: CanvasRecipe): string {
  if (r.kit?.layout && r.kit.layout in LAYOUTS) return r.kit.layout;
  const ids = Object.keys(LAYOUTS);
  return ids.find((id) => LAYOUTS[id].family === r.family && LAYOUTS[id].zone === r.textZone)
    ?? ids.find((id) => LAYOUTS[id].family === r.family)
    ?? "lay-bottom-editorial";
}

/** Ближайшее допустимое число фото к легаси-шаблону (вниз, затем минимум). */
function nearestCount(n: number): StyleCount {
  if (isStyleCount(n)) return n;
  const below = STYLE_COUNTS.filter((c) => c < n);
  return below.length ? below[below.length - 1] : 1;
}

/** Легаси ctaStyle → id кнопки, когда kit отсутствует (v5/v6-рецепты). */
function ctaKitFromStyle(style: CtaStyle): string {
  switch (style) {
    case "pill": return "cta-pill-solid";
    case "block": return "cta-block-solid";
    case "outline": return "cta-pill-outline";
    case "bar": return "cta-bar-solid";
    case "frame": return "cta-text-outline";
    case "line": return "cta-text-solid";
    case "tag": return "cta-notch-solid";
    default: return "cta-text-solid";
  }
}

function strip(p: CanvasPalette): CanvasPalette {
  return {
    id: p.id, name: p.name, bg: p.bg, fg: p.fg, accent: p.accent, soft: p.soft, onAccent: p.onAccent,
    ...(p.accent2 ? { accent2: p.accent2 } : {}),
  };
}

export function specFromRecipe(id: string, name: string, recipe: CanvasRecipe): StyleSpec {
  const layoutId = layoutOfRecipe(recipe);
  const layout = LAYOUTS[layoutId];
  const kit = recipe.kit;
  const need = layoutNumberNeed(layoutId);

  const hasNumber = (recipe.numberMode ?? (recipe.numberStyle === "none" ? "none" : "optional")) !== "none" && need !== "none";
  const rawPlace = kit?.numPlace ?? "np-inline";
  const number: StyleNumber | undefined = hasNumber || need === "required" ? {
    kit: kit?.number ?? "num-plain",
    place: CALM_PLACEMENTS.has(rawPlace) ? rawPlace : rawPlace === "np-ghost" ? "np-above" : "np-inline",
    mode: need === "required" || recipe.numberMode === "required" ? "required" : "optional",
  } : undefined;

  const plateKit = kit?.plate && kit.plate !== "kit-none" ? kit.plate : undefined;
  const plate: StylePlate | undefined = plateKit && layout.overlay && plateParts(plateKit) ? { kit: plateKit } : undefined;

  const highlightRaw = kit?.highlight && kit.highlight !== "hl-none" ? kit.highlight : undefined;
  const ctaKit = kit?.cta ?? ctaKitFromStyle(recipe.ctaStyle);
  const cta: StyleCta | undefined = recipe.ctaStyle === "none" && !kit?.cta ? undefined : {
    kit: ctaKit,
    arrow: recipe.ctaArrow ?? "none",
    case: recipe.ctaCase ?? (recipe.titleCase === "title" ? "title" : "upper"),
  };

  const spec: StyleSpec = {
    rev: 1,
    name: name.split(" · ")[0].replace(/\s*#\d+$/, "").trim() || name,
    tags: ["legacy"],
    counts: [nearestCount(recipe.photoCount)],
    layout: layoutId,
    pair: recipe.fontPair,
    fonts: { display: recipe.fonts.display, sans: recipe.fonts.sans, body: recipe.fonts.body, ...(recipe.fonts.script ? { script: recipe.fonts.script } : {}) },
    ...(recipe.roleFonts ? { roleFonts: { ...recipe.roleFonts } } : {}),
    palettes: [strip(recipe.palette)],
    color: recipe.colorSource === "photo" ? "photo-tint" : "palette",
    title: {
      font: recipe.titleFont,
      case: recipe.titleCase,
      weight: recipe.titleWeight,
      align: recipe.titleAlign,
      maxLines: TITLE_MAX_LINES,
      ...(recipe.titleTracking !== undefined ? { tracking: recipe.titleTracking } : {}),
      ...(recipe.titleAccentWord ? { accentWord: true } : {}),
    },
    ...(plate ? { plate } : {}),
    ...(number ? { number } : {}),
    ...(cta ? { cta } : {}),
    domain: kit?.domain ?? "dom-plain",
    ...(kit?.frame && !kit.frame.startsWith("frm-none") ? { frame: kit.frame } : {}),
    ...(highlightRaw ? { highlight: highlightRaw } : {}),
    ...(layout.overlay ? { overlay: clamp(recipe.overlay || OVERLAY_DEFAULT, OVERLAY_MIN, OVERLAY_MAX) } : {}),
    ...(recipe.decor === "grain" || recipe.texture > 0 ? { grain: true } : {}),
    ...(recipe.scriptKicker || kit?.subtext === "sub-script" ? { kickerScript: true } : {}),
    ...(recipe.doodles ? { doodles: true } : {}),
    ...(kit?.subtext ? { subtext: kit.subtext } : {}),
    grid: { gutter: recipe.photoCount === 1 ? 16 : recipe.gutter, radius: recipe.radius },
    ...(kit?.useAccent2 ? { useAccent2: true } : {}),
    shadow: kit?.shadow === "hard" ? "soft" : kit?.shadow ?? "none",
    sourceIds: [id],
  };

  // Успокоение: оставляем не больше одного громкого элемента.
  // Порядок уступок: дудлы → заливка выделения → декор подложки → обработка цифры.
  let loud = loudElements(spec);
  if (loudCount(loud) > 1 && loud.doodles) { delete spec.doodles; loud = loudElements(spec); }
  if (loudCount(loud) > 1 && loud.highlight) { delete spec.highlight; loud = loudElements(spec); }
  if (loudCount(loud) > 1 && loud.plate && spec.plate) {
    const shape = plateParts(spec.plate.kit)?.shape;
    if (shape) spec.plate = { kit: `plate-${shape}-flat` };
    loud = loudElements(spec);
  }
  if (loudCount(loud) > 1 && loud.number && spec.number) {
    const { shape } = numberParts(spec.number.kit);
    spec.number = { ...spec.number, kit: shape === "none" || LOUD_NUMBER_SHAPES.has(shape) ? "num-plain" : `num-${shape}-solid` };
  }
  // Роли шрифтов могут тянуть третье семейство (body, mono): сводим к паре.
  if (usedFamilies(spec).length > 2) delete spec.roleFonts;
  return spec;
}
