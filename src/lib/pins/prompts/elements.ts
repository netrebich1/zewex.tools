/**
 * Решение «какие элементы класть на этот пин»: сезон, год, число, имя сайта, CTA.
 * Вместо шести процентов старого сервиса — переключатели элементов и один процент
 * «разнообразие» (variety). Решение детерминировано: хэш(itemId + имя элемента) < variety.
 */

import type { Recipe } from "@/lib/pins/types";

export type ElementTags = { season: boolean; year: boolean; number: boolean; siteName: boolean; cta: boolean };

export const ELEMENT_NAMES: ReadonlyArray<keyof ElementTags> = ["season", "year", "number", "siteName", "cta"];

/** FNV-1a, 32 бита; стабилен между запусками и платформами. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // финальное перемешивание, чтобы близкие строки не давали близкие проценты
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Детерминированный процент 0..99.99 для пары (itemId, element). */
export function hashPercent(itemId: string, element: string): number {
  return (hash32(`${itemId}|${element}`) % 10000) / 100;
}

function clampPercent(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Элемент выпадает по своему проценту из рецепта (percents). При 100 — всегда, при 0 — никогда. */
export function decideElements(itemId: string, recipeText: Recipe["text"]): ElementTags {
  const roll = (name: keyof ElementTags): boolean => {
    const share = clampPercent(recipeText.percents?.[name]);
    if (share <= 0) return false;
    if (share >= 100) return true;
    return hashPercent(itemId, name) < share;
  };
  return {
    season: roll("season"),
    year: roll("year"),
    number: roll("number"),
    siteName: roll("siteName"),
    cta: roll("cta"),
  };
}

/** Год для пина: с октября пишем уже следующий год (тренды «2027» начинают искать осенью). */
export function currentYear(now: Date = new Date()): string {
  const y = now.getFullYear();
  return String(now.getMonth() >= 9 ? y + 1 : y);
}

/** Год для пинов: заданный в настройках прогона, иначе текущий (с октября — следующий). */
export function pinYear(text: { year?: string }, now: Date = new Date()): string {
  return /^\d{4}$/.test(text.year ?? "") ? (text.year as string) : currentYear(now);
}

const hostOf = (s: string) => s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

/** Имя сайта для пинов: заданное в настройках прогона, иначе домен (домен для ссылок, иначе хост сайта). */
export function pinSiteName(text: { siteName?: string }, site: { linkDomain?: string | null; siteName: string }): string {
  const custom = (text.siteName ?? "").trim();
  if (custom) return custom;
  return hostOf(site.linkDomain || "") || hostOf(site.siteName);
}

export type Season = "winter" | "spring" | "summer" | "fall";

/** Метеорологические сезоны северного полушария: дек–фев, мар–май, июн–авг, сен–ноя. */
export function seasonForDate(now: Date = new Date()): Season {
  const m = now.getMonth();
  if (m === 11 || m <= 1) return "winter";
  if (m <= 4) return "spring";
  if (m <= 7) return "summer";
  return "fall";
}

/** Слово сезона на языке заголовков (en по умолчанию; для прочих языков — английское). */
export const SEASON_WORDS: Record<string, Record<Season, string>> = {
  en: { winter: "winter", spring: "spring", summer: "summer", fall: "fall" },
  ru: { winter: "зима", spring: "весна", summer: "лето", fall: "осень" },
  uk: { winter: "зима", spring: "весна", summer: "літо", fall: "осінь" },
  de: { winter: "Winter", spring: "Frühling", summer: "Sommer", fall: "Herbst" },
  es: { winter: "invierno", spring: "primavera", summer: "verano", fall: "otoño" },
  fr: { winter: "hiver", spring: "printemps", summer: "été", fall: "automne" },
  it: { winter: "inverno", spring: "primavera", summer: "estate", fall: "autunno" },
  pl: { winter: "zima", spring: "wiosna", summer: "lato", fall: "jesień" },
  pt: { winter: "inverno", spring: "primavera", summer: "verão", fall: "outono" },
};

export function seasonWord(season: Season, language = "en"): string {
  const lang = (language || "en").toLowerCase().slice(0, 2);
  return (SEASON_WORDS[lang] ?? SEASON_WORDS.en)[season];
}
