/**
 * Свои Canvas-стили портала (не из старых шаблонов): чистые, контрастные,
 * с сочными палитрами и подобранными наборами шрифтов. Попадают в каталог как
 * кандидаты с тегом «zewex», владелец утверждает их так же, как остальные.
 *
 * У каждого стиля: основной набор шрифтов + 2–4 альтернативы того же характера
 * (seed выбирает), 3–4 палитры (seed выбирает). Латинские наборы (Anton, Bebas,
 * Instrument Serif…) движок на кириллический пин не возьмёт — `toRecipe` фильтрует
 * по письменности, поэтому у стиля всегда остаётся хотя бы один кириллический набор.
 *
 * Два поколения:
 *  - `zx:*` (категория zewex) — базовая двадцатка, переработана под v8
 *    (кегль через minSize/maxSize, акцентная часть заголовка, подачи домена, кнопки);
 *    id не меняются — они уже в базе.
 *  - `zx27:*` (категория zewex-2027) — библиотека 2027: гигантские постеры, эмфаза,
 *    антиква + рукописное слово, полароиды, карточки, зерно, стекло, контуры,
 *    дуотон/монохром, стикеры.
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
  // Основной набор тоже несёт письменности и межстрочный: toRecipe отбирает наборы по языку пина.
  return { pair: f.pair, fonts: f.fonts, fontSets: fontSetsOf(main, ...alts) };
};

const base = { rev: 4, tags: ["zewex"], domain: "dom-plain", shadow: "none" as const };
const base27 = { rev: 4, tags: ["zewex", "2027"], domain: "dom-plain", shadow: "none" as const };
/** Блоговые стили: тег `blog` + типы статей `k:<тип>`, к которым стиль подходит (src/lib/pins/articleKind.ts). */
const baseBlog = (...kinds: string[]) => ({ rev: 4, tags: ["zewex", "blog", ...kinds.map((k) => `k:${k}`)], domain: "dom-plain", shadow: "none" as const });

export const CURATED_STYLES: Array<{ id: string; category: string; spec: StyleSpec }> = [
  /* ======================================================================
   * Базовая двадцатка (zx:*), переработка под v8
   * ==================================================================== */

  /* ---------- первая десятка ---------- */
  {
    // Узкий капс на всю ширину поверх фото, тень под текстом, тёмный скрим.
    id: "zx:poster-bold", category: "zewex",
    spec: {
      ...base, name: "Zewex · Жирный постер", counts: [1, 2, 3, 4, 6], layout: "lay-overlay-center",
      ...fonts("zx-oswald-madefor", "zx-sofia-xcond", "zx-oswald-inter", "zx-anton-manrope", "zx-dela-golos"),
      palettes: pal("zx-midnight-lime", "zx-cobalt-pop", "zx-brick-punch", "zx-black-neon-lime"), color: "palette",
      title: { font: "display", case: "upper", weight: 700, align: "center", maxLines: 3, tracking: 1, minSize: 96, maxSize: 150, leading: 0.92, shadow: true },
      cta: { kit: "cta-pill-solid", arrow: "chevron", case: "upper" }, overlay: 0.5, domain: "dom-spaced", grid: { gutter: 8, radius: 0 },
    },
  },
  {
    // Цветная лента снизу: гротеск в строчном написании, домен с точками, контурная пилюля.
    id: "zx:band-bottom", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цветная лента снизу", counts: [1, 2, 3, 4], layout: "lay-band-bottom",
      ...fonts("zx-onest", "zx-madefor", "zx-inter-tight", "zx-ysabeau"),
      palettes: pal("zx-cobalt-pop", "zx-emerald-bold", "zx-plum-velvet", "zx-summer-azure"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 3, maxSize: 100, leading: 1.02 },
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, domain: "dom-dots", grid: { gutter: 0, radius: 0 },
    },
  },
  {
    // Цифра над заголовком, тяжёлый гротеск, блочная кнопка.
    id: "zx:hero-number", category: "zewex",
    spec: {
      ...base, name: "Zewex · Крупная цифра", counts: [1, 2, 3, 4, 6], layout: "lay-hero-number",
      ...fonts("zx-montserrat", "zx-unbounded-onest", "zx-onest", "zx-geologica"),
      palettes: pal("zx-mustard-ink", "zx-cherry-black", "zx-royal-blue", "zx-hotpink-cream"), color: "palette",
      title: { font: "sans", case: "title", weight: 800, align: "center", maxLines: 3, maxSize: 100 },
      number: { kit: "num-plain", place: "np-above", mode: "required" },
      cta: { kit: "cta-block-solid", arrow: "none", case: "upper" }, domain: "dom-tick", grid: { gutter: 10, radius: 12 },
    },
  },
  {
    // Сплит: антиква, последнее слово акцентом, линейка над заголовком, домен в линиях.
    id: "zx:split-editorial", category: "zewex",
    spec: {
      ...base, name: "Zewex · Сплит, серифный заголовок", counts: [2, 3, 4, 6], layout: "lay-split",
      ...fonts("zx-playfair-montserrat", "zx-lora-inter", "zx-spectral-onest", "zx-notoserif-golos"),
      palettes: pal("zx-forest-cream", "zx-wine-blush", "zx-espresso-gold", "zx-rust-cream"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, accentWord: true, maxSize: 92 },
      rule: true, domain: "dom-rule",
      cta: { kit: "cta-text-solid", arrow: "stem", case: "upper" }, grid: { gutter: 12, radius: 6 },
    },
  },
  {
    // Заголовок сверху крупным капсом, плитка фото слегка наезжает на него.
    id: "zx:tile-top", category: "zewex",
    spec: {
      ...base, name: "Zewex · Плитка с заголовком сверху", counts: [2, 3, 4, 6], layout: "lay-tile-top",
      ...fonts("zx-inter-tight", "zx-onest", "zx-geologica", "zx-barlow-manrope"),
      palettes: pal("zx-ocean-sun", "zx-olive-sand", "zx-lavender-ink", "zx-terracotta"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 2, tracking: 1, minSize: 70, maxSize: 120, leading: 0.92 },
      highlight: "hl-line-thick", photo: { overlap: 60 },
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 16, radius: 18 },
    },
  },
  {
    // Арка-окно из фото, лёгкая антиква, контурная текстовая кнопка.
    id: "zx:arch-classic", category: "zewex",
    spec: {
      ...base, name: "Zewex · Арка, классика", counts: [1, 2, 3, 4, 6], layout: "lay-arch",
      ...fonts("zx-cormorant-jost", "zx-prata-manrope", "zx-oranienbaum-jost", "zx-forum-tenor"),
      palettes: pal("zx-mint-ink", "zx-navy-peach", "zx-olive-pistachio", "zx-cherry-rose"), color: "palette",
      title: { font: "display", case: "title", weight: 600, align: "center", maxLines: 3, maxSize: 96 },
      photo: { shape: "arch" }, domain: "dom-dots",
      cta: { kit: "cta-text-outline", arrow: "none", case: "upper" }, grid: { gutter: 14, radius: 42 },
    },
  },
  {
    // Плашка на коллаже: антиква, последнее слово чуть крупнее и акцентом.
    id: "zx:plate-on-photo", category: "zewex",
    spec: {
      ...base, name: "Zewex · Плашка на коллаже", counts: [4, 6], layout: "lay-overlay-plate",
      ...fonts("zx-prata-manrope", "zx-playfair-montserrat", "zx-yeseva-raleway", "zx-bona-vibes"),
      palettes: pal("zx-cherry-black", "zx-lemon-black", "zx-cobalt-pop", "zx-hotpink-cream"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, maxSize: 92, emphasis: { part: "last-word", scale: 1.2, color: "accent" } },
      plate: { kit: "plate-rect-flat" }, overlay: 0.35,
      cta: { kit: "cta-pill-solid", arrow: "chevron", case: "upper" }, grid: { gutter: 6, radius: 0 },
    },
  },
  {
    // Контраст: узкий капс, строки на чипах (вместо глухого блока), текст поверх фото.
    id: "zx:contrast-poster", category: "zewex",
    spec: {
      ...base, name: "Zewex · Контраст, строки на чипах", counts: [1, 2, 3, 4, 6], layout: "lay-contrast",
      ...fonts("zx-oswald-madefor", "zx-fjalla-inter", "zx-sofia-cond", "zx-oswald-inter"),
      palettes: pal("zx-brick-punch", "zx-emerald-bold", "zx-midnight-lime", "zx-mustard-ink"), color: "palette",
      title: { font: "display", case: "upper", weight: 700, align: "center", maxLines: 3, minSize: 72, maxSize: 120, leading: 0.95 },
      highlight: "hl-fill-chip", overlay: 0.4, domain: "dom-spaced",
      cta: { kit: "cta-text-solid", arrow: "chevron", case: "upper" }, grid: { gutter: 8, radius: 0 },
    },
  },
  {
    // Цифра сбоку от заголовка, без кнопки, домен мелко в углу.
    id: "zx:hero-number-top", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цифра и заголовок сверху", counts: [2, 3, 4, 6], layout: "lay-hero-number-top",
      ...fonts("zx-madefor", "zx-montserrat", "zx-jost", "zx-ysabeau"),
      palettes: pal("zx-teal-tangerine", "zx-wine-blush", "zx-forest-cream", "zx-royal-blue"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 2, maxSize: 100 },
      number: { kit: "num-plain", place: "np-side", mode: "required" },
      domain: "dom-corner", grid: { gutter: 10, radius: 14 },
    },
  },
  {
    // Тёмная палитра из фото: антиква, пилюля; палитры — только запасные.
    id: "zx:photo-tint-dark", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цвет из фото", counts: [1, 2, 3, 4, 6], layout: "lay-bottom-editorial",
      ...fonts("zx-playfair-montserrat", "zx-lora-inter", "zx-prata-manrope", "zx-forum-tenor"),
      palettes: pal("zx-espresso-gold", "zx-navy-peach", "zx-midnight-lime"), color: "photo-tint-dark",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, maxSize: 96 },
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 10 },
    },
  },

  /* ---------- вторая десятка ---------- */
  {
    // Журнальная шапка: заголовок слева, линейка, домен в линиях, тонкое подчёркивание.
    id: "zx:magazine-top", category: "zewex",
    spec: {
      ...base, name: "Zewex · Журнальная шапка", counts: [2, 3, 4, 6], layout: "lay-top-editorial",
      ...fonts("zx-playfair-montserrat", "zx-spectral-onest", "zx-notoserif-golos", "zx-instrument-inter"),
      palettes: pal("zx-rust-cream", "zx-forest-cream", "zx-espresso-gold", "zx-paper-ink"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "left", maxLines: 3, minSize: 64, maxSize: 96, leading: 1.0 },
      highlight: "hl-line-thin", rule: true, domain: "dom-rule",
      cta: { kit: "cta-text-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 8 },
    },
  },
  {
    // Швейцарский гигант: кегль до 170, плотный межстрочный, полоса-кнопка во всю ширину.
    id: "zx:swiss-giant", category: "zewex",
    spec: {
      ...base, name: "Zewex · Швейцарский гигант", counts: [2, 3, 4, 6], layout: "lay-swiss-giant",
      ...fonts("zx-inter-tight", "zx-unbounded-onest", "zx-dela-golos", "zx-anton-manrope", "zx-bebas-manrope"),
      palettes: pal("zx-lemon-black", "zx-cobalt-pop", "zx-brick-punch", "zx-graphite-butter"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 3, tracking: -1, minSize: 100, maxSize: 170, leading: 0.9 },
      domain: "dom-spaced-lg",
      cta: { kit: "cta-bar-solid", arrow: "none", case: "upper" }, grid: { gutter: 6, radius: 0 },
    },
  },
  {
    // Мягкие скругления, тёплое фото, мягкая пилюля.
    id: "zx:soft-rounded", category: "zewex",
    spec: {
      ...base, name: "Zewex · Мягкие скругления", counts: [2, 3, 4, 6], layout: "lay-soft",
      ...fonts("zx-nunito", "zx-comfortaa-mulish", "zx-raleway", "zx-shantell-nunito"),
      palettes: pal("zx-hotpink-cream", "zx-mint-ink", "zx-spring-lilac", "zx-cherry-rose"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 3, maxSize: 96 },
      photo: { tone: "warm" },
      cta: { kit: "cta-pill-soft", arrow: "none", case: "title" }, grid: { gutter: 18, radius: 34 },
    },
  },
  {
    // Главное фото и детали карточками с мягкой тенью, антиква.
    id: "zx:story-hero", category: "zewex",
    spec: {
      ...base, name: "Zewex · Главное фото и детали", counts: [3, 4], layout: "lay-hero-story",
      ...fonts("zx-lora-inter", "zx-cormorant-jost", "zx-playfair-montserrat", "zx-forum-tenor"),
      palettes: pal("zx-forest-cream", "zx-wine-blush", "zx-ocean-sun", "zx-rust-cream"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, maxSize: 96 },
      photo: { style: "card" }, domain: "dom-rule",
      cta: { kit: "cta-text-outline", arrow: "chevron", case: "upper" }, grid: { gutter: 16, radius: 14 },
    },
  },
  {
    // Сетка с короткой подписью капсом в разрядку, без кнопки.
    id: "zx:grid-caption", category: "zewex",
    spec: {
      ...base, name: "Zewex · Сетка с подписью", counts: [4, 6], layout: "lay-grid-caption",
      ...fonts("zx-jost", "zx-geologica", "zx-onest", "zx-ysabeau"),
      palettes: pal("zx-navy-peach", "zx-olive-sand", "zx-forest-cream", "zx-plum-velvet"), color: "palette",
      title: { font: "display", case: "upper", weight: 700, align: "center", maxLines: 2, tracking: 2, maxSize: 84 },
      domain: "dom-spaced", grid: { gutter: 8, radius: 4 },
    },
  },
  {
    // Текст слева, фото справа: лёгкая антиква крупно, линейка, домен в углу.
    id: "zx:side-clean", category: "zewex",
    spec: {
      ...base, name: "Zewex · Текст слева, фото справа", counts: [2, 3], layout: "lay-side-clean",
      ...fonts("zx-prata-manrope", "zx-yeseva-raleway", "zx-oranienbaum-jost", "zx-forum-tenor"),
      palettes: pal("zx-espresso-gold", "zx-rust-cream", "zx-choco-cream", "zx-graphite-butter"), color: "palette",
      title: { font: "display", case: "title", weight: 400, align: "left", maxLines: 3, minSize: 64, maxSize: 110, leading: 1.0 },
      rule: true, domain: "dom-corner",
      cta: { kit: "cta-text-solid", arrow: "stem", case: "upper" }, grid: { gutter: 10, radius: 16 },
    },
  },
  {
    // Лента поверх фото + круглый стикер в углу.
    id: "zx:band-overlay", category: "zewex",
    spec: {
      ...base, name: "Zewex · Лента поверх фото", counts: [1, 2, 3], layout: "lay-overlay-band",
      ...fonts("zx-montserrat", "zx-madefor", "zx-inter-tight", "zx-unbounded-onest"),
      palettes: pal("zx-cherry-black", "zx-royal-blue", "zx-emerald-bold", "zx-mustard-ink"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 2, maxSize: 100, leading: 0.95 },
      plate: { kit: "plate-slab-flat" }, overlay: 0.3, ringBadge: true,
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 0, radius: 0 },
    },
  },
  {
    // Заголовок между фото: антиква, тонкое подчёркивание, домен с точками.
    id: "zx:mid-editorial", category: "zewex",
    spec: {
      ...base, name: "Zewex · Заголовок между фото", counts: [2, 4, 6], layout: "lay-mid-editorial",
      ...fonts("zx-spectral-onest", "zx-playfair-montserrat", "zx-lora-inter", "zx-cormorant-marck"),
      palettes: pal("zx-lavender-ink", "zx-hotpink-cream", "zx-navy-peach", "zx-olive-sand"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 2, maxSize: 92 },
      highlight: "hl-line-thin", domain: "dom-dots",
      cta: { kit: "cta-text-solid", arrow: "none", case: "upper" }, grid: { gutter: 8, radius: 6 },
    },
  },
  {
    // Лента домена внизу, узкий капс крупно в две строки.
    id: "zx:domain-bar", category: "zewex",
    spec: {
      ...base, name: "Zewex · Лента домена внизу", counts: [2, 3, 4, 6], layout: "lay-domain-bar",
      ...fonts("zx-alumni-golos", "zx-oswald-madefor", "zx-sofia-cond", "zx-sofia-xcond"),
      palettes: pal("zx-teal-tangerine", "zx-brick-punch", "zx-cobalt-pop", "zx-lemon-black"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 2, tracking: 1, minSize: 80, maxSize: 130, leading: 0.92 },
      domain: "dom-bar",
      cta: { kit: "cta-block-solid", arrow: "none", case: "upper" }, grid: { gutter: 6, radius: 0 },
    },
  },
  {
    // Цифра в круге над заголовком, домен пилюлей.
    id: "zx:number-sticker", category: "zewex",
    spec: {
      ...base, name: "Zewex · Цифра-стикер снизу", counts: [3, 4, 6], layout: "lay-sticker-bottom",
      ...fonts("zx-unbounded-manrope", "zx-montserrat", "zx-dela-golos", "zx-shantell-nunito"),
      palettes: pal("zx-plum-velvet", "zx-ocean-sun", "zx-terracotta", "zx-spring-lilac"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 2, maxSize: 92 },
      number: { kit: "num-circle-solid", place: "np-above", mode: "required" },
      domain: "dom-pill",
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 16 },
    },
  },

  /* ======================================================================
   * Библиотека 2027 (zx27:*)
   * ==================================================================== */
  {
    // Гигантский узкий постер: 150–200 px, межстрочный 0.9, по центру на скриме, без кнопки.
    id: "zx27:giant-poster", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Гигантский постер", counts: [1, 2, 3, 4, 6], layout: "lay-overlay-center",
      ...fonts("zx-sofia-xcond", "zx-oswald-inter", "zx-anton-manrope", "zx-bebas-manrope", "zx-alumni-golos"),
      palettes: pal("zx-black-neon-lime", "zx-midnight-lime", "zx-cherry-black", "zx-summer-azure"), color: "palette",
      title: { font: "display", case: "upper", weight: 900, align: "center", maxLines: 3, minSize: 150, maxSize: 200, leading: 0.9, shadow: true },
      overlay: 0.5, domain: "dom-spaced", grid: { gutter: 0, radius: 0 },
    },
  },
  {
    // «Маленькое + БОЛЬШОЕ»: начало мелко, последние два слова вдвое крупнее и акцентом.
    id: "zx27:small-big", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Маленькое + БОЛЬШОЕ", counts: [2, 3, 4, 6], layout: "lay-top-editorial",
      ...fonts("zx-montserrat", "zx-unbounded-onest", "zx-inter-tight", "zx-onest"),
      palettes: pal("zx-cloud-cobalt", "zx-lemon-black", "zx-forest-cream", "zx-cherry-black"), color: "palette",
      title: {
        font: "display", case: "upper", weight: 800, align: "center", maxLines: 3, minSize: 56, maxSize: 110, leading: 0.98,
        emphasis: { part: "last-two", scale: 2, color: "accent", weight: 900 },
      },
      cta: { kit: "cta-block-solid", arrow: "none", case: "upper" }, grid: { gutter: 12, radius: 8 },
    },
  },
  {
    // Антиква + последнее слово рукописным шрифтом акцентом (третье семейство по замыслу).
    id: "zx27:serif-script", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Антиква и рукописное слово", counts: [1, 2, 3, 4, 6], layout: "lay-bottom-editorial",
      ...fonts("zx-bona-vibes", "zx-cormorant-marck", "zx-playfair-pacifico", "zx-prata-marck"),
      palettes: pal("zx-choco-cream", "zx-cherry-rose", "zx-wine-blush", "zx-rust-cream"), color: "palette",
      title: {
        font: "display", case: "title", weight: 700, align: "center", maxLines: 3, maxSize: 96,
        emphasis: { part: "last-word", scale: 1.35, font: "script", color: "accent", case: "lower" },
      },
      domain: "dom-rule",
      cta: { kit: "cta-text-solid", arrow: "none", case: "upper" }, grid: { gutter: 14, radius: 18 },
    },
  },
  {
    // Редакционный слева: заголовок по левому краю, линейка, домен в линиях, текстовая кнопка.
    id: "zx27:editorial-left", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Редакционный слева", counts: [1, 2, 3, 4], layout: "lay-bottom-editorial",
      ...fonts("zx-instrument-inter", "zx-forum-tenor", "zx-spectral-onest", "zx-lora-inter"),
      palettes: pal("zx-paper-ink", "zx-sage-paper", "zx-choco-cream", "zx-winter-ice"), color: "palette",
      title: { font: "display", case: "sentence", weight: 400, align: "left", maxLines: 3, minSize: 64, maxSize: 96, leading: 1.04 },
      rule: true, domain: "dom-rule",
      cta: { kit: "cta-text-solid", arrow: "stem", case: "upper" }, grid: { gutter: 8, radius: 0 },
    },
  },
  {
    // Цветной блок 50/50: фото в половину, тяжёлый капс слева, без кнопки и цифры.
    id: "zx27:block-5050", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Цветной блок 50/50", counts: [1, 2], layout: "lay-side-clean",
      ...fonts("zx-unbounded-onest", "zx-dela-golos", "zx-montserrat", "zx-madefor"),
      palettes: pal("zx-cobalt-pop", "zx-brick-punch", "zx-summer-azure", "zx-black-neon-lime"), color: "palette",
      title: { font: "display", case: "upper", weight: 900, align: "left", maxLines: 3, minSize: 70, maxSize: 120, leading: 0.95 },
      domain: "dom-corner", grid: { gutter: 0, radius: 0 },
    },
  },
  {
    // Арка-окно: верхнее фото аркой, тонкая антиква, пилюля контуром.
    id: "zx27:arch-window", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Арка-окно", counts: [1, 2, 3, 4, 6], layout: "lay-arch",
      ...fonts("zx-cormorant-jost", "zx-forum-tenor", "zx-oranienbaum-jost", "zx-prata-manrope"),
      palettes: pal("zx-olive-pistachio", "zx-cherry-rose", "zx-sage-paper", "zx-espresso-gold"), color: "palette",
      title: { font: "display", case: "title", weight: 600, align: "center", maxLines: 3, maxSize: 96, leading: 1.04 },
      photo: { shape: "arch" }, domain: "dom-dots",
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, grid: { gutter: 16, radius: 26 },
    },
  },
  {
    // Полароиды: белые рамки с поворотом, широкий зазор, округлый рукописный гротеск.
    id: "zx27:polaroids", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Полароиды", counts: [2, 3, 4], layout: "lay-bottom-editorial",
      ...fonts("zx-shantell-nunito", "zx-nunito", "zx-comfortaa-mulish", "zx-montserrat"),
      palettes: pal("zx-cloud-coral", "zx-mint-ink", "zx-hotpink-cream", "zx-paper-ink"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 3, maxSize: 92 },
      photo: { style: "polaroid" }, domain: "dom-tick",
      cta: { kit: "cta-pill-soft", arrow: "none", case: "title" }, grid: { gutter: 28, radius: 0 },
    },
  },
  {
    // Карточки с мягкой тенью на насыщенном цветном фоне.
    id: "zx27:cards-color", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Карточки на цвете", counts: [2, 3, 4, 6], layout: "lay-tile",
      ...fonts("zx-onest", "zx-madefor", "zx-geologica", "zx-ysabeau"),
      palettes: pal("zx-cobalt-pop", "zx-emerald-bold", "zx-plum-velvet", "zx-teal-tangerine"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 3, maxSize: 100 },
      photo: { style: "card" },
      cta: { kit: "cta-pill-solid", arrow: "chevron", case: "upper" }, grid: { gutter: 22, radius: 18 },
    },
  },
  {
    // Бумага с зерном: матовые палитры, антиква, тонкое подчёркивание.
    id: "zx27:paper-grain", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Бумага с зерном", counts: [2, 3, 4, 6], layout: "lay-top-editorial",
      ...fonts("zx-spectral-onest", "zx-lora-inter", "zx-notoserif-golos", "zx-bona-vibes"),
      palettes: pal("zx-paper-ink", "zx-sage-paper", "zx-choco-cream", "zx-autumn-ochre"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, maxSize: 92 },
      grain: true, highlight: "hl-line-thin", domain: "dom-rule",
      cta: { kit: "cta-text-outline", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 4 },
    },
  },
  {
    // Матовое стекло: стеклянная плашка на коллаже, лёгкий скрим, стеклянная пилюля.
    id: "zx27:frosted-glass", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Матовое стекло", counts: [4, 6], layout: "lay-overlay-plate",
      ...fonts("zx-jost", "zx-ysabeau", "zx-geologica", "zx-raleway"),
      palettes: pal("zx-winter-ice", "zx-cloud-cobalt", "zx-navy-peach", "zx-ocean-sun"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, maxSize: 92 },
      plate: { kit: "plate-glass-flat" }, overlay: 0.35, domain: "dom-spaced",
      cta: { kit: "cta-pill-glass", arrow: "none", case: "upper" }, grid: { gutter: 6, radius: 12 },
    },
  },
  {
    // Контурное эхо: толстый гротеск с контурными повторами позади, поверх фото, без кнопки.
    id: "zx27:echo-outline", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Контурное эхо", counts: [1, 2, 3, 4, 6], layout: "lay-overlay-center",
      ...fonts("zx-unbounded-onest", "zx-dela-golos", "zx-archivo-caveat", "zx-montserrat"),
      palettes: pal("zx-black-neon-pink", "zx-midnight-lime", "zx-brick-punch", "zx-summer-azure"), color: "palette",
      title: { font: "display", case: "upper", weight: 900, align: "center", maxLines: 3, minSize: 90, maxSize: 150, leading: 0.92, outline: "echo" },
      overlay: 0.45, domain: "dom-spaced-lg", grid: { gutter: 4, radius: 0 },
    },
  },
  {
    // Hollow-контур: весь заголовок контуром, последнее слово залито акцентом.
    id: "zx27:hollow-word", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Контур и одно залитое слово", counts: [1, 2, 3, 4, 6], layout: "lay-contrast",
      ...fonts("zx-montserrat", "zx-inter-tight", "zx-syne-space", "zx-bricolage-inter"),
      palettes: pal("zx-black-neon-lime", "zx-cherry-black", "zx-cobalt-pop", "zx-mustard-ink"), color: "palette",
      title: {
        font: "display", case: "upper", weight: 900, align: "center", maxLines: 3, minSize: 80, maxSize: 140, leading: 0.95, outline: "hollow", shadow: true,
        emphasis: { part: "last-word", scale: 1, color: "accent" },
      },
      overlay: 0.4,
      cta: { kit: "cta-block-outline", arrow: "none", case: "upper" }, grid: { gutter: 8, radius: 0 },
    },
  },
  {
    // Фото наезжает на заголовок: узкий капс до 150 px сверху, плитка перекрывает низ строк.
    id: "zx27:photo-overlap", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Фото наезжает на заголовок", counts: [2, 3, 4, 6], layout: "lay-top-editorial",
      ...fonts("zx-oswald-madefor", "zx-sofia-xcond", "zx-alumni-golos", "zx-fjalla-inter", "zx-barlow-manrope"),
      palettes: pal("zx-lemon-black", "zx-cloud-coral", "zx-cherry-rose", "zx-mint-ink"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 2, minSize: 90, maxSize: 150, leading: 0.9 },
      photo: { overlap: 90 }, domain: "dom-spaced",
      cta: { kit: "cta-text-solid", arrow: "none", case: "upper" }, grid: { gutter: 8, radius: 0 },
    },
  },
  {
    // Круглый стикер с текстом по кругу + лента поверх фото.
    id: "zx27:ring-badge", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Круглый стикер", counts: [1, 2, 3], layout: "lay-overlay-band",
      ...fonts("zx-madefor", "zx-onest", "zx-inter-tight", "zx-raleway"),
      palettes: pal("zx-cloud-coral", "zx-summer-azure", "zx-hotpink-cream", "zx-cobalt-pop"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 2, maxSize: 96 },
      plate: { kit: "plate-pill-flat" }, overlay: 0.35, ringBadge: true,
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 0, radius: 0 },
    },
  },
  {
    // Дуотон: фото в два цвета палитры, тяжёлый капс поверх, лёгкий скрим.
    id: "zx27:duotone", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Дуотон", counts: [1, 2, 3, 4, 6], layout: "lay-overlay-center",
      ...fonts("zx-unbounded-onest", "zx-syne-space", "zx-montserrat", "zx-bricolage-inter"),
      palettes: pal("zx-black-neon-pink", "zx-violet-neon", "zx-plum-velvet", "zx-summer-azure"), color: "palette",
      title: { font: "display", case: "upper", weight: 900, align: "center", maxLines: 3, tracking: 1, minSize: 80, maxSize: 130, leading: 0.95 },
      photo: { tone: "duotone" }, overlay: 0.3, domain: "dom-spaced",
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, grid: { gutter: 4, radius: 0 },
    },
  },
  {
    // Монохром с неоновым акцентом: ч/б фото, чёрный + лайм, последнее слово неоном.
    id: "zx27:mono-neon", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Монохром и неон", counts: [1, 2, 3, 4, 6], layout: "lay-overlay-center",
      ...fonts("zx-inter-tight", "zx-anton-manrope", "zx-bebas-manrope", "zx-sofia-xcond"),
      palettes: pal("zx-black-neon-lime", "zx-midnight-lime", "zx-black-neon-pink", "zx-cherry-black"), color: "palette",
      title: {
        font: "display", case: "upper", weight: 900, align: "center", maxLines: 3, minSize: 100, maxSize: 160, leading: 0.9,
        emphasis: { part: "last-word", scale: 1, color: "accent" },
      },
      photo: { tone: "mono" }, highlight: "hl-line-thick", overlay: 0.45,
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 4, radius: 0 },
    },
  },
  {
    // Ретро-журнал: латинская антиква Instrument/Playfair, тёплое фото, тонкая линия, домен в линиях.
    id: "zx27:retro-magazine", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Ретро-журнал", counts: [2, 3, 4, 6], layout: "lay-top-editorial",
      ...fonts("zx-instrument-inter", "zx-playfair-pacifico", "zx-playfair-montserrat", "zx-bona-vibes"),
      palettes: pal("zx-paper-ink", "zx-autumn-ochre", "zx-choco-cream", "zx-cherry-rose"), color: "palette",
      title: { font: "display", case: "title", weight: 400, align: "center", maxLines: 3, minSize: 64, maxSize: 110, leading: 1.0 },
      photo: { tone: "warm" }, grain: true, highlight: "hl-line-thin", domain: "dom-rule",
      cta: { kit: "cta-text-double", arrow: "none", case: "upper" }, grid: { gutter: 6, radius: 0 },
    },
  },
  {
    // Стикер-пак: цифра в круге над заголовком, нежные палитры, мягкие шрифты.
    id: "zx27:sticker-pack", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Стикер-пак", counts: [3, 4, 6], layout: "lay-sticker-bottom",
      ...fonts("zx-shantell-nunito", "zx-nunito", "zx-comfortaa-mulish", "zx-montserrat"),
      palettes: pal("zx-spring-lilac", "zx-hotpink-cream", "zx-cloud-coral", "zx-mint-ink"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 2, maxSize: 92 },
      number: { kit: "num-circle-solid", place: "np-above", mode: "required" },
      domain: "dom-pill",
      cta: { kit: "cta-pill-soft", arrow: "none", case: "title" }, grid: { gutter: 14, radius: 26 },
    },
  },
  {
    // Ценник: цифра в пилюле сбоку от заголовка, кнопка-тег с вырезом.
    id: "zx27:price-tag", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Ценник с цифрой", counts: [2, 3, 4, 6], layout: "lay-hero-number-top",
      ...fonts("zx-ysabeau", "zx-geologica", "zx-jost", "zx-onest"),
      palettes: pal("zx-cloud-cobalt", "zx-cloud-coral", "zx-lemon-black", "zx-teal-tangerine"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 2, maxSize: 100 },
      number: { kit: "num-pill-solid", place: "np-side", mode: "required" },
      domain: "dom-tick",
      cta: { kit: "cta-notch-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 12 },
    },
  },
  {
    // Soft-рецептный: мягкие шрифты, пастель, тёплое фото, пилюля в строчном написании.
    id: "zx27:soft-recipe", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Мягкий рецептный", counts: [2, 3, 4, 6], layout: "lay-soft",
      ...fonts("zx-nunito", "zx-shantell-nunito", "zx-comfortaa-mulish", "zx-ysabeau"),
      palettes: pal("zx-cherry-rose", "zx-spring-lilac", "zx-olive-pistachio", "zx-hotpink-cream"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 3, maxSize: 96 },
      photo: { tone: "warm" },
      cta: { kit: "cta-pill-solid", arrow: "none", case: "title" }, grid: { gutter: 18, radius: 34 },
    },
  },
  {
    // Сезонная лента: праздничные и сезонные палитры, антиква, домен с точками.
    id: "zx27:season-band", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Сезонная лента", counts: [1, 2, 3, 4], layout: "lay-band-bottom",
      ...fonts("zx-playfair-montserrat", "zx-bona-vibes", "zx-yeseva-raleway", "zx-forum-tenor"),
      palettes: pal("zx-xmas-bordeaux", "zx-winter-ice", "zx-autumn-ochre", "zx-summer-azure"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, maxSize: 96 },
      domain: "dom-dots",
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, grid: { gutter: 0, radius: 0 },
    },
  },
  {
    // Скотч-зин: заголовок на полосе-скотче поверх фото, узкий капс, скошенная кнопка.
    id: "zx27:tape-zine", category: "zewex-2027",
    spec: {
      ...base27, name: "Zewex 2027 · Скотч-зин", counts: [2, 3, 4, 6], layout: "lay-tape",
      ...fonts("zx-sofia-xcond", "zx-oswald-madefor", "zx-bebas-manrope", "zx-barlow-manrope"),
      palettes: pal("zx-lemon-black", "zx-cloud-coral", "zx-mustard-ink", "zx-brick-punch"), color: "palette",
      title: { font: "display", case: "upper", weight: 800, align: "center", maxLines: 3, minSize: 80, maxSize: 130, leading: 0.92 },
      plate: { kit: "plate-tape-flat" }, overlay: 0.4, domain: "dom-corner",
      cta: { kit: "cta-skew-solid", arrow: "none", case: "upper" }, grid: { gutter: 8, radius: 0 },
    },
  },
  /* ======================================================================
   * Блоговые статьи (zxb:*, категория blog) — 2026-10-26
   * Для информационных статей (как сделать, советы, чек-лист, проблема и решение, почему, какой выбрать,
   * рецепт, план). Тег `blog` убирает стиль из подборок идей; теги `k:<тип>` говорят, к каким статьям он идёт
   * (src/lib/pins/articleKind.ts). Надзаголовок ставится по типу статьи («Step-by-step guide», «Checklist»…),
   * цифра — число шагов / пунктов статьи.
   * ==================================================================== */
  {
    // Крупная цифра шагов над заголовком: «7» + «Steps to Curl Hair with a Flat Iron».
    id: "zxb:steps-hero", category: "blog",
    spec: {
      ...baseBlog("how_to", "plan", "tips"), name: "Блог · Крупная цифра шагов", counts: [1, 2, 3], layout: "lay-hero-number",
      ...fonts("zx-montserrat", "zx-inter-tight", "zx-onest", "zx-madefor"),
      palettes: pal("zx-cloud-cobalt", "zx-mint-ink", "zx-lavender-ink", "zx-cloud-coral"), color: "palette",
      title: { font: "sans", case: "title", weight: 800, align: "center", maxLines: 3, maxSize: 92 },
      number: { kit: "num-plain", place: "np-above", mode: "required" },
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, domain: "dom-tick", grid: { gutter: 10, radius: 14 },
    },
  },
  {
    // Спокойный гайд: фото сверху, плотная лента с заголовком снизу, без цифры.
    id: "zxb:guide-band", category: "blog",
    spec: {
      ...baseBlog("how_to", "explain", "fix"), name: "Блог · Лента «гайд»", counts: [1, 2, 3], layout: "lay-band-bottom",
      ...fonts("zx-lora-inter", "zx-spectral-onest", "zx-playfair-montserrat", "zx-notoserif-golos"),
      palettes: pal("zx-forest-cream", "zx-paper-ink", "zx-navy-peach", "zx-sage-paper"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, maxSize: 90 },
      domain: "dom-rule",
      cta: { kit: "cta-text-solid", arrow: "none", case: "upper" }, grid: { gutter: 0, radius: 0 },
    },
  },
  {
    // Редакционный заголовок сверху, антиква, цифра мелко над заголовком (если есть).
    id: "zxb:editorial-top", category: "blog",
    spec: {
      ...baseBlog("how_to", "tips", "explain"), name: "Блог · Редакционный верх", counts: [2, 3, 4], layout: "lay-top-editorial",
      ...fonts("zx-playfair-montserrat", "zx-prata-manrope", "zx-cormorant-jost", "zx-forum-tenor"),
      palettes: pal("zx-rust-cream", "zx-cloud-cobalt", "zx-choco-cream", "zx-forest-cream"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, maxSize: 88 },
      number: { kit: "num-plain", place: "np-above", mode: "optional" },
      domain: "dom-spaced",
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, grid: { gutter: 12, radius: 10 },
    },
  },
  {
    // Список советов: крупная цифра в круге сверху, жирный гротеск, фото снизу.
    id: "zxb:tips-circle", category: "blog",
    spec: {
      ...baseBlog("tips", "checklist"), name: "Блог · Советы с цифрой в круге", counts: [2, 3, 4], layout: "lay-hero-number-top",
      ...fonts("zx-unbounded-manrope", "zx-montserrat", "zx-bricolage-inter", "zx-onest"),
      palettes: pal("zx-mustard-ink", "zx-royal-blue", "zx-hotpink-cream", "zx-emerald-bold"), color: "palette",
      title: { font: "sans", case: "upper", weight: 800, align: "center", maxLines: 3, maxSize: 84 },
      number: { kit: "num-circle-solid", place: "np-above", mode: "required" },
      cta: { kit: "cta-block-solid", arrow: "none", case: "upper" }, domain: "dom-plain", grid: { gutter: 10, radius: 12 },
    },
  },
  {
    // Чек-лист: текстовая плитка среди фото, «сохрани себе» кнопкой.
    id: "zxb:checklist-tile", category: "blog",
    spec: {
      ...baseBlog("checklist", "plan", "tips"), name: "Блог · Чек-лист плиткой", counts: [2, 3, 4], layout: "lay-tile",
      ...fonts("zx-jost", "zx-geologica", "zx-raleway", "zx-inter-tight"),
      palettes: pal("zx-mint-ink", "zx-lemon-black", "zx-cloud-lime", "zx-lavender-ink"), color: "palette",
      title: { font: "sans", case: "title", weight: 800, align: "left", maxLines: 3, maxSize: 82 },
      number: { kit: "num-plain", place: "np-inline", mode: "optional" },
      cta: { kit: "cta-pill-solid", arrow: "none", case: "title" }, domain: "dom-tick", grid: { gutter: 12, radius: 18 },
    },
  },
  {
    // Проблема и решение: тёмная плашка поверх фото, контрастный капс.
    id: "zxb:fix-contrast", category: "blog",
    spec: {
      ...baseBlog("fix", "explain"), name: "Блог · Быстрое решение (контраст)", counts: [1, 2], layout: "lay-contrast",
      ...fonts("zx-oswald-madefor", "zx-fjalla-inter", "zx-sofia-cond", "zx-alumni-golos"),
      palettes: pal("zx-cherry-black", "zx-midnight-lime", "zx-navy-peach", "zx-black-neon-lime"), color: "palette",
      title: { font: "display", case: "upper", weight: 700, align: "center", maxLines: 3, minSize: 70, maxSize: 120, leading: 0.95, shadow: true },
      overlay: 0.5, domain: "dom-spaced",
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, grid: { gutter: 0, radius: 0 },
    },
  },
  {
    // Объяснение: два фото рядом, заголовок снизу на цветном поле.
    id: "zxb:explain-split", category: "blog",
    spec: {
      ...baseBlog("explain", "fix", "compare"), name: "Блог · Объяснение (раздел)", counts: [2, 3, 4], layout: "lay-split",
      ...fonts("zx-inter-tight", "zx-onest", "zx-geologica", "zx-jost"),
      palettes: pal("zx-teal-tangerine", "zx-plum-velvet", "zx-ocean-sun", "zx-royal-blue"), color: "palette",
      title: { font: "sans", case: "sentence", weight: 800, align: "center", maxLines: 3, maxSize: 86 },
      domain: "dom-dots",
      cta: { kit: "cta-text-outline", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 12 },
    },
  },
  {
    // Почему так: одно большое фото, антиква снизу, тихая подача.
    id: "zxb:why-serif", category: "blog",
    spec: {
      ...baseBlog("explain", "how_to"), name: "Блог · «Почему» антиквой", counts: [1, 2], layout: "lay-bottom-editorial",
      ...fonts("zx-instrument-inter", "zx-cormorant-jost", "zx-prata-manrope", "zx-spectral-onest"),
      palettes: pal("zx-paper-ink", "zx-sage-paper", "zx-choco-cream", "zx-winter-ice"), color: "palette",
      title: { font: "display", case: "sentence", weight: 400, align: "center", maxLines: 3, maxSize: 96 },
      domain: "dom-rule",
      cta: { kit: "cta-text-solid", arrow: "none", case: "upper" }, grid: { gutter: 14, radius: 16 },
    },
  },
  {
    // Сравнение «X vs Y»: два фото сверху друг против друга, заголовок сверху.
    id: "zxb:compare-top", category: "blog",
    spec: {
      ...baseBlog("compare"), name: "Блог · Сравнение (два фото)", counts: [2, 4], layout: "lay-split-top",
      ...fonts("zx-montserrat", "zx-unbounded-onest", "zx-inter-tight", "zx-madefor"),
      palettes: pal("zx-cloud-coral", "zx-cloud-cobalt", "zx-graphite-butter", "zx-hotpink-cream"), color: "palette",
      title: { font: "sans", case: "upper", weight: 800, align: "center", maxLines: 3, maxSize: 86 },
      domain: "dom-pill",
      cta: { kit: "cta-block-solid", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 10 },
    },
  },
  {
    // Гид покупателя: товар на чистом фоне сбоку, заголовок рядом.
    id: "zxb:buyers-side", category: "blog",
    spec: {
      ...baseBlog("compare", "tips"), name: "Блог · Гид покупателя (сбоку)", counts: [1, 2], layout: "lay-side-clean",
      ...fonts("zx-geologica", "zx-jost", "zx-raleway", "zx-ysabeau"),
      palettes: pal("zx-forest-cream", "zx-cloud-cobalt", "zx-rust-cream", "zx-mint-ink"), color: "palette",
      title: { font: "sans", case: "title", weight: 800, align: "left", maxLines: 3, maxSize: 78 },
      domain: "dom-plain",
      cta: { kit: "cta-pill-solid", arrow: "none", case: "title" }, grid: { gutter: 12, radius: 14 },
    },
  },
  {
    // Рецепт: мягкий округлый шрифт, арка с фото, тёплые палитры.
    id: "zxb:recipe-arch", category: "blog",
    spec: {
      ...baseBlog("recipe"), name: "Блог · Рецепт (арка)", counts: [2, 3], layout: "lay-arch-bottom",
      ...fonts("zx-nunito", "zx-comfortaa-mulish", "zx-shantell-nunito", "zx-yeseva-raleway"),
      palettes: pal("zx-choco-cream", "zx-rust-cream", "zx-olive-pistachio", "zx-cherry-rose"), color: "palette",
      title: { font: "display", case: "title", weight: 800, align: "center", maxLines: 3, maxSize: 88 },
      photo: { tone: "warm" }, domain: "dom-dots",
      cta: { kit: "cta-pill-soft", arrow: "none", case: "upper" }, grid: { gutter: 14, radius: 22 },
    },
  },
  {
    // Рецепт-постер: фото на весь пин, лента с названием блюда.
    id: "zxb:recipe-band", category: "blog",
    spec: {
      ...baseBlog("recipe"), name: "Блог · Рецепт (лента на фото)", counts: [1, 2], layout: "lay-overlay-band",
      ...fonts("zx-playfair-montserrat", "zx-yeseva-raleway", "zx-lora-inter", "zx-bona-vibes"),
      palettes: pal("zx-espresso-gold", "zx-terracotta", "zx-wine-blush", "zx-olive-sand"), color: "palette",
      title: { font: "display", case: "title", weight: 700, align: "center", maxLines: 3, maxSize: 92 },
      overlay: 0.35, domain: "dom-spaced",
      cta: { kit: "cta-text-solid", arrow: "none", case: "upper" }, grid: { gutter: 0, radius: 0 },
    },
  },
  {
    // План на N дней / тренировка: цифра-стикер, бодрые палитры.
    id: "zxb:plan-sticker", category: "blog",
    spec: {
      ...baseBlog("plan", "checklist"), name: "Блог · План со стикером", counts: [3, 4], layout: "lay-sticker-bottom",
      ...fonts("zx-unbounded-onest", "zx-montserrat", "zx-syne-space", "zx-bricolage-inter"),
      palettes: pal("zx-summer-azure", "zx-emerald-bold", "zx-violet-neon", "zx-cobalt-pop"), color: "palette",
      title: { font: "sans", case: "upper", weight: 900, align: "center", maxLines: 3, maxSize: 80 },
      number: { kit: "num-circle-solid", place: "np-above", mode: "required" },
      cta: { kit: "cta-pill-solid", arrow: "none", case: "upper" }, domain: "dom-plain", grid: { gutter: 10, radius: 16 },
    },
  },
  {
    // Ошибки и советы громко: жёлто-чёрный постер по центру фото.
    id: "zxb:mistakes-poster", category: "blog",
    spec: {
      ...baseBlog("tips", "fix"), name: "Блог · Громкий постер (ошибки, советы)", counts: [1, 2, 3], layout: "lay-overlay-center",
      ...fonts("zx-sofia-xcond", "zx-anton-manrope", "zx-oswald-inter", "zx-alumni-golos"),
      palettes: pal("zx-lemon-black", "zx-mustard-ink", "zx-black-neon-lime", "zx-brick-punch"), color: "palette",
      title: { font: "display", case: "upper", weight: 900, align: "center", maxLines: 3, minSize: 110, maxSize: 170, leading: 0.92, shadow: true },
      overlay: 0.5, domain: "dom-spaced",
      cta: { kit: "cta-block-solid", arrow: "none", case: "upper" }, grid: { gutter: 0, radius: 0 },
    },
  },
  {
    // Универсальный «сохрани себе»: светлая полоса домена снизу, подходит любой блоговой статье.
    id: "zxb:save-bar", category: "blog",
    spec: {
      ...baseBlog("how_to", "tips", "checklist", "fix", "explain", "compare", "recipe", "plan"), name: "Блог · Универсальный с полосой домена", counts: [2, 3, 4], layout: "lay-domain-bar",
      ...fonts("zx-onest", "zx-inter-tight", "zx-geologica", "zx-madefor"),
      palettes: pal("zx-cloud-cobalt", "zx-cloud-coral", "zx-forest-cream", "zx-navy-peach"), color: "palette",
      title: { font: "sans", case: "title", weight: 800, align: "center", maxLines: 3, maxSize: 84 },
      domain: "dom-bar",
      cta: { kit: "cta-pill-outline", arrow: "none", case: "upper" }, grid: { gutter: 10, radius: 12 },
    },
  },
];
