/**
 * Точка входа Canvas-движка для воркера.
 *
 * Перед первым рендером нужно поставить хост:
 *   import { installNodeCanvasHost } from "@/lib/pins/canvas/host.node";
 *   installNodeCanvasHost(join(storageRoot(), "pins/fonts"));
 */
import { PIN_H, PIN_W } from "./crop";
import { renderCanvasPinDetailed } from "./engine";
import { getHost } from "./host";
import { paletteFromPhoto, readableOn } from "./palette";
import type { CanvasPalette, CanvasRecipe } from "./recipe";
import type { HostImage } from "./host";

export type { CanvasHost, HostCanvas, HostImage, Ctx2D } from "./host";
export { setCanvasHost, getHost } from "./host";
export type { CanvasPalette, CanvasRecipe, ColorSource, NumberStyle } from "./recipe";
export { CANVAS_PALETTES, CANVAS_PALETTE_MAP, enrichPalette } from "./recipe";
export { PIN_W, PIN_H, guessAccent, toAccent } from "./crop";
export type { AccentType } from "./crop";
export { renderCanvasPin, renderCanvasPinDetailed } from "./engine";
export type { RenderCanvasArgs, PinText } from "./engine";
export { cleanCanvasHook, sourceDigits } from "./text";
export { hashSeed, mulberry } from "./composer";
export { recipePhotos, CANVAS_LAYOUTS } from "./layouts";
export {
  CANVAS_FONT_LIBRARY, CANVAS_FONT_PAIRS, FONT_PAIRS, FONT_PAIR_MAP,
  fontSupports, familyWeights, pairFontFor, pairsForScript, scriptForLanguage, loadFontFamilies, missingFontFamilies,
} from "./fonts";
export type { FontPair } from "./fonts";
export { KIT_COUNTS } from "./kit";

export interface RenderPinTexts {
  title: string;
  kicker?: string;
  /** Число «идей»; нецифровое значение игнорируется. */
  number?: string;
  cta?: string;
  domain?: string;
}

export interface RenderPinOptions {
  /** Фирменный акцент (hex) — применяется при colorSource "brand" в рецепте. */
  brandAccent?: string;
  /** Переопределяет источник цвета рецепта. */
  colorSource?: "palette" | "photo";
}

export interface RenderPinArgs {
  recipe: CanvasRecipe;
  /** Декодируемые буферы фото (JPEG/PNG/WebP), порядок = порядок использования. */
  photos: Buffer[];
  texts: RenderPinTexts;
  seed: number;
  options?: RenderPinOptions;
}

export interface RenderPinResult {
  jpeg: Buffer;
  width: number;
  height: number;
  issues: string[];
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Источник цвета: в legacy он только сохранялся в рецепте, движок его не читал.
 * Здесь "photo" строит палитру из первого фото, "brand" подменяет акцент.
 */
function applyColorOptions(recipe: CanvasRecipe, first: HostImage, seed: number, options?: RenderPinOptions): CanvasRecipe {
  const source = options?.colorSource ?? recipe.colorSource ?? "palette";
  const brand = options?.brandAccent ?? recipe.brandAccent;
  let palette: CanvasPalette = recipe.palette;
  if (source === "photo") {
    const p = paletteFromPhoto(first, seed);
    palette = { ...palette, bg: p.bg, fg: p.fg, accent: p.accent, onAccent: p.onAccent, soft: p.soft, accent2: undefined };
  } else if (source === "brand" && brand && HEX.test(brand)) {
    palette = { ...palette, accent: brand, onAccent: readableOn(brand, "#ffffff"), accent2: undefined };
  }
  return { ...recipe, palette, colorSource: source, brandAccent: brand };
}

function parseIdeaCount(value?: string): number | undefined {
  const n = Number(String(value ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Рендер одного пина: декодирует фото через хост и зовёт движок. */
export async function renderPin(args: RenderPinArgs): Promise<RenderPinResult> {
  if (!args.photos.length) throw new Error("Нет фото для рендера");
  const host = getHost();
  const images = await Promise.all(args.photos.map((b) => host.loadImage(b)));
  const recipe = applyColorOptions(args.recipe, images[0], args.seed, args.options);
  const { jpeg, issues } = await renderCanvasPinDetailed({
    recipe,
    photos: images,
    text: { title: args.texts.title, kicker: args.texts.kicker, cta: args.texts.cta },
    domain: args.texts.domain,
    seed: args.seed,
    ideaCount: parseIdeaCount(args.texts.number),
  });
  return { jpeg, width: PIN_W, height: PIN_H, issues };
}
