/**
 * Наборы шрифтов для Canvas-стилей: современные, «пинтерестные», все с кириллицей.
 *
 * Набор = заголовочный шрифт + текстовый (кикер, кнопка, подпись). Стиль хранит
 * не все наборы, а только те, что ему к лицу (класс рисунка: элегантная антиква,
 * жирный гротеск, узкий, геометрический, мягкий). Seed выбирает один из них.
 */
import { fontClass, fontSupports } from "./fonts";
import type { StyleFontSet, StyleSpec } from "./styleSpec";

/**
 * Классы рисунка. `poster` — сверхузкие/тяжёлые плакатные гарнитуры под кегль 120–200 px,
 * `script` — наборы с рукописным акцентом (антиква + script для emphasis.font = "script").
 */
export type FontSetClass = "serif" | "bold" | "condensed" | "geo" | "soft" | "poster" | "script";

export interface CuratedFontSet extends StyleFontSet {
  id: string;
  cls: FontSetClass;
  /** Рекомендуемое начертание заголовка (есть у семейства). */
  titleWeight: number;
}

/** Письменности, которые поддерживают все семейства набора. */
function scriptsOf(...families: Array<string | undefined>): string[] {
  const fams = families.filter((f): f is string => Boolean(f));
  return ["latin", "cyrillic"].filter((sc) => fams.every((f) => fontSupports(f, sc)));
}

/**
 * Набор: заголовок + текст (+ тело, + рукописный акцент). `scripts` считается по библиотеке шрифтов:
 * латинские наборы не попадают на кириллические пины (toRecipe фильтрует по языку).
 */
const S = (id: string, cls: FontSetClass, display: string, sans: string, titleWeight: number, body = sans, extra: { script?: string; leading?: number } = {}): CuratedFontSet => ({
  id, cls, pair: id,
  fonts: { display, sans, body, ...(extra.script ? { script: extra.script } : {}) },
  titleWeight,
  scripts: scriptsOf(display, sans, body, extra.script),
  ...(extra.leading !== undefined ? { leading: extra.leading } : {}),
});

export const FONT_SETS: CuratedFontSet[] = [
  // Элегантная антиква — бьюти, мода, декор
  S("zx-playfair-montserrat", "serif", "Playfair Display", "Montserrat", 700, "Manrope"),
  S("zx-prata-manrope", "serif", "Prata", "Manrope", 400),
  S("zx-cormorant-jost", "serif", "Cormorant Garamond", "Jost", 600),
  S("zx-lora-inter", "serif", "Lora", "Inter", 700),
  S("zx-spectral-onest", "serif", "Spectral", "Onest", 700),
  S("zx-notoserif-golos", "serif", "Noto Serif Display", "Golos Text", 700),
  S("zx-yeseva-raleway", "serif", "Yeseva One", "Raleway", 400),
  S("zx-oranienbaum-jost", "serif", "Oranienbaum", "Jost", 400),
  // Жирный современный гротеск — постеры, цифры, списки
  S("zx-montserrat", "bold", "Montserrat", "Montserrat", 800, "Manrope"),
  S("zx-unbounded-manrope", "bold", "Unbounded", "Manrope", 700),
  // Dela — высокие выносы, заголовку нужен межстрочный просторнее
  S("zx-dela-golos", "bold", "Dela Gothic One", "Golos Text", 400, "Golos Text", { leading: 1.16 }),
  S("zx-inter-tight", "bold", "Inter Tight", "Inter", 800),
  S("zx-onest", "bold", "Onest", "Onest", 800),
  S("zx-madefor", "bold", "Wix Madefor Display", "Wix Madefor Text", 800),
  // Узкий — ленты, крупные заголовки в одну-две строки
  S("zx-oswald-madefor", "condensed", "Oswald", "Wix Madefor Text", 600, "Manrope"),
  S("zx-fjalla-inter", "condensed", "Fjalla One", "Inter", 400),
  S("zx-alumni-golos", "condensed", "Alumni Sans", "Golos Text", 800),
  S("zx-sofia-cond", "condensed", "Sofia Sans Condensed", "Sofia Sans", 800),
  // Геометрический — чистый, «технологичный»
  S("zx-jost", "geo", "Jost", "Jost", 700, "Manrope"),
  S("zx-geologica", "geo", "Geologica", "Geologica", 700, "Manrope"),
  S("zx-raleway", "geo", "Raleway", "Raleway", 800, "Manrope"),
  // Мягкий — рецепты, дети, уют
  S("zx-nunito", "soft", "Nunito", "Nunito Sans", 800),
  S("zx-comfortaa-mulish", "soft", "Comfortaa", "Mulish", 700),

  /* ---------- 2027 ---------- */
  // Плакатные: сверхузкие и тяжёлые, под кегль 120–200 px (latin-only наборы на кириллицу не попадут)
  S("zx-sofia-xcond", "poster", "Sofia Sans Extra Condensed", "Sofia Sans", 900, "Sofia Sans", { leading: 0.9 }),
  S("zx-barlow-manrope", "poster", "Barlow Condensed", "Manrope", 800, "Manrope", { leading: 0.92 }),
  S("zx-anton-manrope", "poster", "Anton", "Manrope", 400, "Manrope", { leading: 0.94 }),
  S("zx-bebas-manrope", "poster", "Bebas Neue", "Manrope", 400, "Manrope", { leading: 0.9 }),
  S("zx-oswald-inter", "poster", "Oswald", "Inter", 700, "Inter", { leading: 0.94 }),
  // Антиква + рукописный акцент (третье семейство допустимо только для emphasis.font = "script")
  S("zx-bona-vibes", "script", "Bona Nova", "Sofia Sans", 700, "Sofia Sans", { script: "Great Vibes" }),
  S("zx-cormorant-marck", "script", "Cormorant Garamond", "Jost", 600, "Jost", { script: "Marck Script" }),
  S("zx-playfair-pacifico", "script", "Playfair Display", "Montserrat", 900, "Manrope", { script: "Pacifico" }),
  S("zx-prata-marck", "script", "Prata", "Manrope", 400, "Manrope", { script: "Marck Script" }),
  S("zx-archivo-caveat", "script", "Archivo Black", "Archivo", 400, "Archivo", { script: "Caveat" }),
  // Антиква редакционная
  S("zx-forum-tenor", "serif", "Forum", "Tenor Sans", 400),
  S("zx-instrument-inter", "serif", "Instrument Serif", "Inter", 400, "Inter", { leading: 1.0 }),
  // Жирный гротеск
  S("zx-unbounded-onest", "bold", "Unbounded", "Onest", 900, "Onest", { leading: 1.1 }),
  S("zx-bricolage-inter", "bold", "Bricolage Grotesque", "Inter", 800),
  S("zx-syne-space", "bold", "Syne", "Space Grotesk", 800),
  // Геометрический / гуманистический
  S("zx-ysabeau", "geo", "Ysabeau", "Ysabeau", 800, "Ysabeau"),
  // Мягкий, рукописно-округлый
  S("zx-shantell-nunito", "soft", "Shantell Sans", "Nunito", 800, "Nunito", { leading: 1.12 }),
];

export const FONT_SET_MAP = new Map(FONT_SETS.map((f) => [f.id, f]));

export function fontSet(id: string): CuratedFontSet {
  const f = FONT_SET_MAP.get(id);
  if (!f) throw new Error(`Нет набора шрифтов ${id}`);
  return f;
}

/** Наборы по классам → StyleFontSet[] (для curated-стилей). */
export function fontSetsOf(...ids: string[]): StyleFontSet[] {
  return ids.map((id) => { const { pair, fonts, scripts, leading } = fontSet(id); return { pair, fonts, scripts, ...(leading !== undefined ? { leading } : {}) }; });
}

/** Ревизия спецификации, с которой у стиля есть подобранные наборы шрифтов. */
export const FONT_REV = 3;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Класс набора для шрифта заголовка старого стиля. */
function classOfTitle(family: string): FontSetClass {
  const c = fontClass(family);
  if (c === "serif") return "serif";
  if (c === "condensed") return "condensed";
  if (c === "display") return "bold";
  if (c === "soft" || c === "script") return "soft";
  return "geo";
}

/**
 * Старому стилю (одна зашитая пара) добавляются два набора того же класса,
 * чтобы шрифты варьировались, но оставались в характере шаблона.
 */
export function attachFontSets(spec: StyleSpec, key: string): StyleSpec {
  if ((spec.rev ?? 1) >= FONT_REV) return spec;
  const titleFamily = spec.title.font === "sans" ? spec.fonts.sans : spec.fonts.display;
  const cls = classOfTitle(titleFamily);
  const pool = FONT_SETS.filter((f) => f.cls === cls && f.fonts.display !== spec.fonts.display);
  const h = hash(key);
  const picked: StyleFontSet[] = [];
  for (let i = 0; i < pool.length && picked.length < 2; i++) {
    const f = pool[(h + i * 7919) % pool.length];
    if (picked.some((p) => p.pair === f.pair)) continue;
    picked.push({ pair: f.pair, fonts: f.fonts, scripts: f.scripts });
  }
  return { ...spec, rev: FONT_REV, fontSets: picked };
}
