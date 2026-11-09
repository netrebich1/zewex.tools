/**
 * Шрифты canvas-пинов (порт canvasFonts.ts). Данные — в fontsLibrary.ts.
 * Загрузки с Google Fonts нет: шрифты регистрируются на хосте из файлов
 * (host.node.ts), а `loadFontFamilies` только проверяет их наличие.
 */
import { FONT_LIBRARY_RAW, FONT_PAIRS_RAW, type CanvasFontDef, type FontPairDef, type FontRole } from "./fontsLibrary";
import { FONTS_NOT_FOUND } from "./fontsMeta";
import { getHost } from "./host";

export type { CanvasFontDef, FontPairDef, FontRole };

export const CANVAS_FONT_LIBRARY: CanvasFontDef[] = FONT_LIBRARY_RAW;

/** Семейства, которых нет в Google Fonts — в сборку их не берём. */
export const FONT_MISSING = new Set(FONTS_NOT_FOUND);

const LIBRARY_MAP = new Map(CANVAS_FONT_LIBRARY.map((f) => [f.family, f]));

/** Поддерживает ли семейство нужную письменность (латиница/кириллица). */
export function fontSupports(family: string, script: string): boolean {
  if (FONT_MISSING.has(family)) return false;
  const def = LIBRARY_MAP.get(family);
  if (!def) return false;
  return (def.scripts.length ? def.scripts : ["latin"]).includes(script);
}

/** Какая письменность нужна тексту на этом языке. */
export function scriptForLanguage(lang?: string): "latin" | "cyrillic" {
  const l = (lang || "").toLowerCase();
  return /ru|uk|be|bg|sr|kk|ру|укр/.test(l) ? "cyrillic" : "latin";
}

/** Класс рисунка шрифта — по нему собираются «строгие» пары. */
export type FontClass = "grotesk" | "condensed" | "serif" | "display" | "mono" | "soft" | "script";

const CONDENSED = /Condensed|Narrow|Oswald|Bebas|Fjalla|Big Shoulders|Alumni|Yanone|Cuprum|Archivo Narrow|Tektur/;
const HEAVY_DISPLAY = /Anton|Archivo Black|Alfa Slab|Bowlby|Rubik Mono|Rubik One|Russo|Stalinist|Unbounded|Syne|Bricolage|Kelly Slab|Playfair Display SC|Yeseva/;

export function fontClass(family: string): FontClass {
  const def = LIBRARY_MAP.get(family);
  if (!def) return "grotesk";
  if (def.role === "script") return "script";
  if (def.role === "mono") return "mono";
  if (def.role === "soft") return "soft";
  if (CONDENSED.test(family)) return "condensed";
  if (HEAVY_DISPLAY.test(family)) return "display";
  if (def.role === "serif") return "serif";
  if (def.role === "display") return "display";
  return "grotesk";
}

/** Доступные начертания семейства (для микса толщин). */
export function familyWeights(family: string): number[] {
  return LIBRARY_MAP.get(family)?.weights ?? [400, 700];
}

export const CANVAS_FONT_FAMILIES = CANVAS_FONT_LIBRARY.map((f) => f.family);

export function fontsByRole(role: FontRole): CanvasFontDef[] {
  return CANVAS_FONT_LIBRARY.filter((f) => f.role === role);
}

/** Пара шрифтов: заголовок + подпись/акцент; `scripts` — что пара закрывает целиком. */
export interface FontPair extends FontPairDef {
  scripts: string[];
}

/**
 * Пары = базовые + пары пака v9. Пара «кириллическая», только если все
 * её семейства с кириллицей; пустой список = пару использовать нельзя.
 */
export const CANVAS_FONT_PAIRS: FontPair[] = FONT_PAIRS_RAW.map((p) => {
  const families = [p.display, p.sans, p.body, p.script].filter((f): f is string => Boolean(f));
  const scripts = ["latin", "cyrillic"].filter((s) => families.every((f) => fontSupports(f, s)));
  return { ...p, scripts };
});

/** Синоним для читаемости в вызывающем коде. */
export const FONT_PAIRS = CANVAS_FONT_PAIRS;

export const FONT_PAIR_MAP = new Map(CANVAS_FONT_PAIRS.map((p) => [p.id, p]));

/** Пары, пригодные для языка пина (кириллица отсекает латинские семейства). */
export function pairsForScript(script: "latin" | "cyrillic", ids?: string[]): FontPair[] {
  const pool = ids?.length
    ? ids.map((id) => FONT_PAIR_MAP.get(id)).filter((p): p is FontPair => Boolean(p))
    : CANVAS_FONT_PAIRS;
  const ok = pool.filter((p) => p.scripts.includes(script));
  if (ok.length) return ok;
  const any = CANVAS_FONT_PAIRS.filter((p) => p.scripts.includes(script));
  return any.length ? any : pool;
}

/** Роль элемента пина → семейство из выбранной пары (строго внутри пары). */
export type ElementRole = "title" | "kicker" | "number" | "cta" | "subtext";

export function pairFontFor(pair: FontPairDef, role: ElementRole, variant = 0): string {
  const sans = pair.sans, display = pair.display, body = pair.body || pair.sans;
  const mono = [pair.sans, pair.body].find((f) => fontClass(f) === "mono");
  switch (role) {
    case "title": return variant % 2 === 0 ? display : sans;
    case "kicker": return mono || (variant % 2 === 0 ? sans : body);
    // Цифра «идей» — всегда самый контрастный по рисунку шрифт пары.
    case "number": return fontClass(display) === "script" ? sans : display;
    case "cta": return mono || sans;
    case "subtext": return body;
  }
}

/* ---------- проверка наличия на хосте ---------- */

const warned = new Set<string>();

/** Семейства из списка, которые не зарегистрированы на хосте. */
export function missingFontFamilies(families: Array<string | undefined>): string[] {
  const host = getHost();
  return Array.from(new Set(families.filter((f): f is string => Boolean(f)))).filter((f) => !host.hasFont(f));
}

/**
 * Замена браузерной ленивой загрузки: проверяет, что семейства зарегистрированы,
 * и один раз пишет в лог отсутствующие (Skia подставит системный fallback).
 * Возвращает список отсутствующих.
 */
export function loadFontFamilies(families: Array<string | undefined>): string[] {
  const missing = missingFontFamilies(families);
  const fresh = missing.filter((f) => !warned.has(f));
  if (fresh.length) {
    fresh.forEach((f) => warned.add(f));
    console.warn(`[pins/canvas] шрифты не зарегистрированы, будет системный fallback: ${fresh.join(", ")}`);
  }
  return missing;
}
