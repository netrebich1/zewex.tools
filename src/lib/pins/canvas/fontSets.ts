/**
 * Наборы шрифтов для Canvas-стилей: современные, «пинтерестные», все с кириллицей.
 *
 * Набор = заголовочный шрифт + текстовый (кикер, кнопка, подпись). Стиль хранит
 * не все наборы, а только те, что ему к лицу (класс рисунка: элегантная антиква,
 * жирный гротеск, узкий, геометрический, мягкий). Seed выбирает один из них.
 */
import { fontClass } from "./fonts";
import type { StyleFontSet, StyleSpec } from "./styleSpec";

export type FontSetClass = "serif" | "bold" | "condensed" | "geo" | "soft";

export interface CuratedFontSet extends StyleFontSet {
  id: string;
  cls: FontSetClass;
  /** Рекомендуемое начертание заголовка (есть у семейства). */
  titleWeight: number;
}

const S = (id: string, cls: FontSetClass, display: string, sans: string, titleWeight: number, body = sans): CuratedFontSet =>
  ({ id, cls, pair: id, fonts: { display, sans, body }, titleWeight });

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
  S("zx-dela-golos", "bold", "Dela Gothic One", "Golos Text", 400),
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
];

export const FONT_SET_MAP = new Map(FONT_SETS.map((f) => [f.id, f]));

export function fontSet(id: string): CuratedFontSet {
  const f = FONT_SET_MAP.get(id);
  if (!f) throw new Error(`Нет набора шрифтов ${id}`);
  return f;
}

/** Наборы по классам → StyleFontSet[] (для curated-стилей). */
export function fontSetsOf(...ids: string[]): StyleFontSet[] {
  return ids.map((id) => { const { pair, fonts } = fontSet(id); return { pair, fonts }; });
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
    picked.push({ pair: f.pair, fonts: f.fonts });
  }
  return { ...spec, rev: FONT_REV, fontSets: picked };
}
