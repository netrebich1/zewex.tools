/**
 * Свои Canvas-стили портала (не из старых шаблонов): чистые, контрастные,
 * с сочными палитрами и подобранными наборами шрифтов. Попадают в каталог как
 * кандидаты с тегом «zewex», владелец утверждает их так же, как остальные.
 *
 * У каждого стиля: основной набор шрифтов + 2–3 альтернативы того же характера
 * (seed выбирает), 3–4 палитры (seed выбирает). Всё с кириллицей.
 */
import { BOLD_PALETTE_MAP } from "./paletteLibrary";
import { fontSet, fontSetsOf } from "./fontSets";
import type { CanvasPalette } from "./recipe";
import type { StyleSpec } from "./styleSpec";

const pal = (...ids: string[]): CanvasPalette[] => ids.map((id) => {
  const p = BOLD_PALETTE_MAP.get(id);
  if (!p) throw new Error(`Нет палитры ${id}`);
  const { mood: _m, ...plain } = p;
  return plain;
});

/** Основной набор + альтернативы: pair/fonts/fontSets для спецификации. */
const fonts = (main: string, ...alts: string[]) => {
  const f = fontSet(main);
  return { pair: f.pair, fonts: f.fonts, fontSets: fontSetsOf(...alts) };
};

const base = { rev: 3, tags: ["zewex"], domain: "dom-plain", shadow: "none" as const };

export const CURATED_STYLES: Array<{ id: string; category: string; spec: StyleSpec }> = [
  /* ---------- первая десятка ---------- */
  {
    id: "zx:poster-bold", category: "zewex",
    spec: {
      ...base, name: "Zewex · Жирный постер", counts: [1, 2, 3, 4, 6], layout: "lay-overlay-center",
      ...fonts("zx-oswald-madefor", "zx-montserrat", "zx-dela-golos", "zx-alumni-golos"),
      palettes: pal("zx-midnight-lime", "zx-cobalt-pop", "zx-brick-punch", "zx-navy-peach"), color: "palette",
      title: { font: "display", case: "upper", weight: 700, align: "center", maxLines: 3, tracking: 1 },
      cta: { kit: "cta-pill-solid", arrow: "chevron", case: "upper" }, overlay: 0.5, grid: { gutter: 8, radius: 0 },
    },
  },
  {
    id: "zx:band-bottom", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цветная лента снизу", counts: [1, 2, 3, 4], layout: "lay-band-bottom",
      ...fonts("zx-onest", "zx-madefor", "zx-inter-tight"),
      palettes: pal("zx-cobalt-pop", "zx-emerald-bold", "zx-plum-velvet", "zx-teal-tangerine"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 3 },
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, grid: { gutter: 0, radius: 0 },
    },
  },
  {
    id: "zx:hero-number", category: "zewex",
    spec: {
      ...base, name: "Zewex · Крупная цифра", counts: [1, 2, 3, 4, 6], layout: "lay-hero-number",
      ...fonts("zx-montserrat", "zx-unbounded-manrope", "zx-onest"),
      palettes: pal("zx-mustard-ink", "zx-cherry-black", "zx-royal-blue", "zx-hotpink-cream"), color: "palette",
      title: { font: "sans", case: "title", weight: 800, align: "center", maxLines: 3 },
      number: { kit: "num-plain", place: "np-above", mode: "required" },
      cta: { kit: "cta-block-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 12 },
    },
  },
  {
    id: "zx:split-editorial", category: "zewex",
    spec: {
      ...base, name: "Zewex · Сплит, серифный заголовок", counts: [2, 3, 4, 6], layout: "lay-split",
      ...fonts("zx-playfair-montserrat", "zx-lora-inter", "zx-spectral-onest", "zx-notoserif-golos"),
      palettes: pal("zx-forest-cream", "zx-wine-blush", "zx-espresso-gold", "zx-rust-cream"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, accentWord: true },
      cta: { kit: "cta-text-solid", arrow: "stem", case: "upper" }, grid: { gutter: 12, radius: 6 },
    },
  },
  {
    id: "zx:tile-top", category: "zewex",
    spec: {
      ...base, name: "Zewex · Плитка с заголовком сверху", counts: [2, 3, 4, 6], layout: "lay-tile-top",
      ...fonts("zx-inter-tight", "zx-onest", "zx-geologica"),
      palettes: pal("zx-ocean-sun", "zx-olive-sand", "zx-lavender-ink", "zx-terracotta"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 2, tracking: 1 },
      highlight: "hl-line-thick",
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 16, radius: 18 },
    },
  },
  {
    id: "zx:arch-classic", category: "zewex",
    spec: {
      ...base, name: "Zewex · Арка, классика", counts: [1, 2, 3, 4, 6], layout: "lay-arch",
      ...fonts("zx-cormorant-jost", "zx-prata-manrope", "zx-oranienbaum-jost"),
      palettes: pal("zx-mint-ink", "zx-navy-peach", "zx-rust-cream", "zx-plum-velvet"), color: "palette",
      title: { font: "display", case: "title", weight: 600, align: "center", maxLines: 3 },
      cta: { kit: "cta-text-outline", arrow: "none", case: "upper" }, grid: { gutter: 14, radius: 42 },
    },
  },
  {
    id: "zx:plate-on-photo", category: "zewex",
    spec: {
      ...base, name: "Zewex · Плашка на коллаже", counts: [4, 6], layout: "lay-overlay-plate",
      ...fonts("zx-prata-manrope", "zx-playfair-montserrat", "zx-yeseva-raleway"),
      palettes: pal("zx-cherry-black", "zx-lemon-black", "zx-cobalt-pop", "zx-hotpink-cream"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3 },
      plate: { kit: "plate-rect-flat" }, overlay: 0.35,
      cta: { kit: "cta-pill-solid", arrow: "chevron", case: "upper" }, grid: { gutter: 6, radius: 0 },
    },
  },
  {
    id: "zx:contrast-poster", category: "zewex",
    spec: {
      ...base, name: "Zewex · Контраст, заливка под строкой", counts: [1, 2, 3, 4, 6], layout: "lay-contrast",
      ...fonts("zx-oswald-madefor", "zx-fjalla-inter", "zx-sofia-cond"),
      palettes: pal("zx-brick-punch", "zx-emerald-bold", "zx-midnight-lime", "zx-mustard-ink"), color: "palette",
      title: { font: "display", case: "upper", weight: 700, align: "center", maxLines: 3 },
      highlight: "hl-fill-block", overlay: 0.4,
      cta: { kit: "cta-text-solid", arrow: "chevron", case: "upper" }, grid: { gutter: 8, radius: 0 },
    },
  },
  {
    id: "zx:hero-number-top", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цифра и заголовок сверху", counts: [2, 3, 4, 6], layout: "lay-hero-number-top",
      ...fonts("zx-madefor", "zx-montserrat", "zx-jost"),
      palettes: pal("zx-teal-tangerine", "zx-wine-blush", "zx-forest-cream", "zx-royal-blue"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 2 },
      number: { kit: "num-plain", place: "np-side", mode: "required" },
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 14 },
    },
  },
  {
    id: "zx:photo-tint-dark", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цвет из фото", counts: [1, 2, 3, 4, 6], layout: "lay-bottom-editorial",
      ...fonts("zx-playfair-montserrat", "zx-lora-inter", "zx-prata-manrope"),
      palettes: pal("zx-espresso-gold", "zx-navy-peach"), color: "photo-tint",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3 },
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 10 },
    },
  },

  /* ---------- вторая десятка ---------- */
  {
    id: "zx:magazine-top", category: "zewex",
    spec: {
      ...base, name: "Zewex · Журнальная шапка", counts: [2, 3, 4, 6], layout: "lay-top-editorial",
      ...fonts("zx-playfair-montserrat", "zx-spectral-onest", "zx-notoserif-golos"),
      palettes: pal("zx-rust-cream", "zx-forest-cream", "zx-espresso-gold", "zx-lavender-ink"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3 },
      highlight: "hl-line-thin", domain: "dom-rule",
      cta: { kit: "cta-text-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 8 },
    },
  },
  {
    id: "zx:swiss-giant", category: "zewex",
    spec: {
      ...base, name: "Zewex · Швейцарский гигант", counts: [2, 3, 4, 6], layout: "lay-swiss-giant",
      ...fonts("zx-inter-tight", "zx-unbounded-manrope", "zx-dela-golos"),
      palettes: pal("zx-lemon-black", "zx-cobalt-pop", "zx-brick-punch", "zx-mint-ink"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 3, tracking: -1 },
      cta: { kit: "cta-bar-solid", arrow: "none", case: "upper" }, grid: { gutter: 6, radius: 0 },
    },
  },
  {
    id: "zx:soft-rounded", category: "zewex",
    spec: {
      ...base, name: "Zewex · Мягкие скругления", counts: [2, 3, 4, 6], layout: "lay-soft",
      ...fonts("zx-nunito", "zx-comfortaa-mulish", "zx-raleway"),
      palettes: pal("zx-hotpink-cream", "zx-mint-ink", "zx-lavender-ink", "zx-terracotta"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 3 },
      cta: { kit: "cta-pill-soft", arrow: "none", case: "title" }, grid: { gutter: 18, radius: 34 },
    },
  },
  {
    id: "zx:story-hero", category: "zewex",
    spec: {
      ...base, name: "Zewex · Главное фото и детали", counts: [3, 4], layout: "lay-hero-story",
      ...fonts("zx-lora-inter", "zx-cormorant-jost", "zx-playfair-montserrat"),
      palettes: pal("zx-forest-cream", "zx-wine-blush", "zx-ocean-sun", "zx-rust-cream"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3 },
      cta: { kit: "cta-text-outline", arrow: "chevron", case: "upper" }, grid: { gutter: 10, radius: 12 },
    },
  },
  {
    id: "zx:grid-caption", category: "zewex",
    spec: {
      ...base, name: "Zewex · Сетка с подписью", counts: [4, 6], layout: "lay-grid-caption",
      ...fonts("zx-jost", "zx-geologica", "zx-onest"),
      palettes: pal("zx-navy-peach", "zx-olive-sand", "zx-forest-cream", "zx-plum-velvet"), color: "palette",
      title: { font: "display", case: "upper", weight: 700, align: "center", maxLines: 2, tracking: 2 },
      domain: "dom-spaced",
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, grid: { gutter: 8, radius: 4 },
    },
  },
  {
    id: "zx:side-clean", category: "zewex",
    spec: {
      ...base, name: "Zewex · Текст слева, фото справа", counts: [2, 3], layout: "lay-side-clean",
      ...fonts("zx-prata-manrope", "zx-yeseva-raleway", "zx-oranienbaum-jost"),
      palettes: pal("zx-espresso-gold", "zx-rust-cream", "zx-mint-ink", "zx-midnight-lime"), color: "palette",
      title: { font: "display", case: "title", weight: 400, align: "left", maxLines: 3 },
      cta: { kit: "cta-text-solid", arrow: "stem", case: "upper" }, grid: { gutter: 10, radius: 16 },
    },
  },
  {
    id: "zx:band-overlay", category: "zewex",
    spec: {
      ...base, name: "Zewex · Лента поверх фото", counts: [1, 2, 3], layout: "lay-overlay-band",
      ...fonts("zx-montserrat", "zx-madefor", "zx-inter-tight"),
      palettes: pal("zx-cherry-black", "zx-royal-blue", "zx-emerald-bold", "zx-mustard-ink"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 2 },
      plate: { kit: "plate-slab-flat" }, overlay: 0.3,
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 0, radius: 0 },
    },
  },
  {
    id: "zx:mid-editorial", category: "zewex",
    spec: {
      ...base, name: "Zewex · Заголовок между фото", counts: [2, 4, 6], layout: "lay-mid-editorial",
      ...fonts("zx-spectral-onest", "zx-playfair-montserrat", "zx-lora-inter"),
      palettes: pal("zx-lavender-ink", "zx-hotpink-cream", "zx-navy-peach", "zx-olive-sand"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 2 },
      cta: { kit: "cta-text-solid", arrow: "none", case: "upper" }, grid: { gutter: 8, radius: 6 },
    },
  },
  {
    id: "zx:domain-bar", category: "zewex",
    spec: {
      ...base, name: "Zewex · Лента домена внизу", counts: [2, 3, 4, 6], layout: "lay-domain-bar",
      ...fonts("zx-alumni-golos", "zx-oswald-madefor", "zx-sofia-cond"),
      palettes: pal("zx-teal-tangerine", "zx-brick-punch", "zx-cobalt-pop", "zx-lemon-black"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 2, tracking: 1 },
      domain: "dom-bar",
      cta: { kit: "cta-block-solid", arrow: "none", case: "upper" }, grid: { gutter: 6, radius: 0 },
    },
  },
  {
    id: "zx:number-sticker", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цифра-стикер снизу", counts: [3, 4, 6], layout: "lay-sticker-bottom",
      ...fonts("zx-unbounded-manrope", "zx-montserrat", "zx-dela-golos"),
      palettes: pal("zx-plum-velvet", "zx-ocean-sun", "zx-terracotta", "zx-mint-ink"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 2 },
      number: { kit: "num-circle-solid", place: "np-side", mode: "required" },
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 16 },
    },
  },
];
