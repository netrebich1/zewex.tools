/**
 * Свои Canvas-стили портала (не из старых шаблонов): чистые, контрастные,
 * с сочными палитрами. Попадают в каталог как кандидаты с тегом «zewex»,
 * владелец утверждает их так же, как остальные.
 */
import { BOLD_PALETTE_MAP } from "./paletteLibrary";
import type { CanvasPalette } from "./recipe";
import type { StyleSpec } from "./styleSpec";

const pal = (...ids: string[]): CanvasPalette[] => ids.map((id) => {
  const p = BOLD_PALETTE_MAP.get(id);
  if (!p) throw new Error(`Нет палитры ${id}`);
  const { mood: _m, ...plain } = p;
  return plain;
});

const FONTS = {
  poster: { pair: "oswald-madefor", fonts: { display: "Oswald", sans: "Wix Madefor Text", body: "Manrope" } },
  editorial: { pair: "editorial", fonts: { display: "Playfair Display", sans: "Montserrat", body: "Manrope" } },
  clean: { pair: "clean", fonts: { display: "Golos Text", sans: "Commissioner", body: "Manrope" } },
  classic: { pair: "classic", fonts: { display: "EB Garamond", sans: "Raleway", body: "Literata" } },
  prata: { pair: "manrope-prata", fonts: { display: "Prata", sans: "Manrope", body: "Manrope" } },
} as const;

const base = { rev: 2, tags: ["zewex"], domain: "dom-plain", shadow: "none" as const };

export const CURATED_STYLES: Array<{ id: string; category: string; spec: StyleSpec }> = [
  {
    id: "zx:poster-bold", category: "zewex",
    spec: {
      ...base, name: "Zewex · Жирный постер", counts: [1, 2, 3, 4, 6], layout: "lay-overlay-center", ...FONTS.poster,
      palettes: pal("zx-midnight-lime", "zx-cobalt-pop", "zx-brick-punch", "zx-navy-peach"), color: "palette",
      title: { font: "display", case: "upper", weight: 700, align: "center", maxLines: 3, tracking: 1 },
      cta: { kit: "cta-pill-solid", arrow: "chevron", case: "upper" }, overlay: 0.5, grid: { gutter: 8, radius: 0 },
    },
  },
  {
    id: "zx:band-bottom", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цветная лента снизу", counts: [1, 2, 3, 4], layout: "lay-band-bottom", ...FONTS.clean,
      palettes: pal("zx-cobalt-pop", "zx-emerald-bold", "zx-plum-velvet", "zx-teal-tangerine"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 3 },
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, grid: { gutter: 0, radius: 0 },
    },
  },
  {
    id: "zx:hero-number", category: "zewex",
    spec: {
      ...base, name: "Zewex · Крупная цифра", counts: [1, 2, 3, 4, 6], layout: "lay-hero-number", ...FONTS.poster,
      palettes: pal("zx-mustard-ink", "zx-cherry-black", "zx-royal-blue", "zx-hotpink-cream"), color: "palette",
      title: { font: "sans", case: "title", weight: 800, align: "center", maxLines: 3 },
      number: { kit: "num-plain", place: "np-above", mode: "required" },
      cta: { kit: "cta-block-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 12 },
    },
  },
  {
    id: "zx:split-editorial", category: "zewex",
    spec: {
      ...base, name: "Zewex · Сплит, серифный заголовок", counts: [2, 3, 4, 6], layout: "lay-split", ...FONTS.editorial,
      palettes: pal("zx-forest-cream", "zx-wine-blush", "zx-espresso-gold", "zx-rust-cream"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, accentWord: true },
      cta: { kit: "cta-text-solid", arrow: "stem", case: "upper" }, grid: { gutter: 12, radius: 6 },
    },
  },
  {
    id: "zx:tile-top", category: "zewex",
    spec: {
      ...base, name: "Zewex · Плитка с заголовком сверху", counts: [2, 3, 4, 6], layout: "lay-tile-top", ...FONTS.clean,
      palettes: pal("zx-ocean-sun", "zx-olive-sand", "zx-lavender-ink", "zx-terracotta"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 2, tracking: 1 },
      highlight: "hl-line-thick",
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 16, radius: 18 },
    },
  },
  {
    id: "zx:arch-classic", category: "zewex",
    spec: {
      ...base, name: "Zewex · Арка, классика", counts: [1, 2, 3, 4, 6], layout: "lay-arch", ...FONTS.classic,
      palettes: pal("zx-mint-ink", "zx-navy-peach", "zx-rust-cream", "zx-plum-velvet"), color: "palette",
      title: { font: "display", case: "title", weight: 600, align: "center", maxLines: 3 },
      cta: { kit: "cta-text-outline", arrow: "none", case: "upper" }, grid: { gutter: 14, radius: 42 },
    },
  },
  {
    id: "zx:plate-on-photo", category: "zewex",
    spec: {
      ...base, name: "Zewex · Плашка на коллаже", counts: [4, 6], layout: "lay-overlay-plate", ...FONTS.prata,
      palettes: pal("zx-cherry-black", "zx-lemon-black", "zx-cobalt-pop", "zx-hotpink-cream"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3 },
      plate: { kit: "plate-rect-flat" }, overlay: 0.35,
      cta: { kit: "cta-pill-solid", arrow: "chevron", case: "upper" }, grid: { gutter: 6, radius: 0 },
    },
  },
  {
    id: "zx:contrast-poster", category: "zewex",
    spec: {
      ...base, name: "Zewex · Контраст, заливка под строкой", counts: [1, 2, 3, 4, 6], layout: "lay-contrast", ...FONTS.poster,
      palettes: pal("zx-brick-punch", "zx-emerald-bold", "zx-midnight-lime", "zx-mustard-ink"), color: "palette",
      title: { font: "display", case: "upper", weight: 700, align: "center", maxLines: 3 },
      highlight: "hl-fill-block", overlay: 0.4,
      cta: { kit: "cta-text-solid", arrow: "chevron", case: "upper" }, grid: { gutter: 8, radius: 0 },
    },
  },
  {
    id: "zx:hero-number-top", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цифра и заголовок сверху", counts: [2, 3, 4, 6], layout: "lay-hero-number-top", ...FONTS.clean,
      palettes: pal("zx-teal-tangerine", "zx-wine-blush", "zx-forest-cream", "zx-royal-blue"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 2 },
      number: { kit: "num-plain", place: "np-side", mode: "required" },
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 14 },
    },
  },
  {
    id: "zx:photo-tint-dark", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цвет из фото", counts: [1, 2, 3, 4, 6], layout: "lay-bottom-editorial", ...FONTS.editorial,
      palettes: pal("zx-espresso-gold", "zx-navy-peach"), color: "photo-tint",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3 },
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 10 },
    },
  },
];
