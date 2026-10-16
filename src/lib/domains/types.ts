/**
 * Общие типы и константы инструмента «Подбор доменов» (раздел Gambling).
 * Тяжёлую проверку свободности выполняет воркер; Next.js ставит подбор в очередь и читает результаты.
 */

import { countryByCode, dfsLocationCode } from "./countries";

export const PROJECT_SLUG = "domains";
export const SLOT_AI = "text_main";
export const SLOT_SERP_DFS = "serp_dfs";
export const SLOT_SERP_API = "serp_api";

export const LIMITS = {
  brands: 500,
  tlds: 100,
  suffixesPerTier: 500,
  perBrandMax: 100,
  extraMax: 100,
  aiCandidates: 200,
  serpQueries: 25,
} as const;

export type AvailabilityStatus = "available" | "taken" | "unknown";

export type CandidatePattern = "brand" | "brand+suffix" | "brand-suffix" | "brand-split" | "brand-split+suffix";

export type MinedSuffix = { suffix: string; count: number; examples: string[] };

/** Домены Google TOP-10 (только с брендом в метке), по каждому запросу. */
export type SerpSnapshot = {
  provider: "dataforseo" | "serpapi";
  countryCode: string;
  keyword: string | null;
  /** Запрос → домены выдачи (hostname без www) */
  byQuery: Record<string, string[]>;
  /** Все уникальные домены с брендом в метке */
  domains: string[];
  fetchedAt: string;
};

/** Настройки подбора: сохраняются в DomainRun.settings, «Повторить» подставляет их в форму. */
export type DomainRunSettings = {
  brands: string[];
  tlds: string[];
  /** Три уровня приставок: сначала весь уровень 1, затем 2, затем 3 */
  suffixTiers: [string[], string[], string[]];
  perBrand: number;
  extraPerBrand: number;
  allowHyphen: boolean;
  countryCode: string;
  serpKeyword: string;
  /** Приставки из анализа выдачи (для справки в карточке подбора) */
  minedSuffixes: MinedSuffix[];
  /** Снимок выдачи, если анализ делали перед запуском */
  serp: SerpSnapshot | null;
};

export type DomainRunProgress = {
  brand: string;
  brandIndex: number;
  brandsTotal: number;
  checked: number;
  available: number;
  updatedAt: string;
};

export const DEFAULT_SETTINGS: DomainRunSettings = {
  brands: [],
  tlds: ["com", "nl", "net"],
  suffixTiers: [["nl", "nederland", "eu"], ["casino", "casinos", "play"], ["app", "online", "365"]],
  perBrand: 10,
  extraPerBrand: 10,
  allowHyphen: true,
  countryCode: "nl",
  serpKeyword: "",
  minedSuffixes: [],
  serp: null,
};

export type DfsCountry = { code: string; name: string; locationCode: number; languageCode: string };

/** Страна для анализа выдачи: все страны мира из countries.ts (DataForSEO location_code = 2000 + ISO numeric). */
export function getCountry(code: string): DfsCountry | null {
  const c = countryByCode(code);
  return c ? { code: c.code, name: c.name, locationCode: dfsLocationCode(c), languageCode: c.lang } : null;
}

/** Гео-слова общего списка: такие приставки из анализа выдачи попадают в уровень 1 по умолчанию. */
export const GEO_WORDS = new Set([
  "nederland", "netherlands", "netherland", "holland", "deutschland", "espana", "italia", "france", "polska", "belgie", "belgique", "belgium",
  "osterreich", "suisse", "schweiz", "eu", "uk", "usa", "canada", "australia", "romania", "bulgaria", "greece", "magyar", "cesko", "slovensko",
  "slovenija", "portugal", "brasil", "turkiye", "sverige", "norge", "danmark", "suomi", "ireland", "japan", "africa", "asia", "europe", "latam",
]);

/** Коды стран, которые встречаются как гео-приставки (короткие коды вроде it, in, me, to слишком похожи на обычные слова). */
export const GEO_CODES = new Set(["nl", "de", "be", "at", "ch", "fr", "es", "pl", "pt", "br", "uk", "us", "ca", "au", "nz", "ie", "za", "ng", "ke", "zm", "jp", "kr", "mx", "ar", "cl", "pe", "se", "dk", "fi", "cz", "sk", "hu", "ro", "bg", "gr", "tr", "ua", "eu"]);

/** Приставка считается гео, если это код выбранной страны, её название (en/местное) или слово из общего гео-списка. */
export function isGeoSuffix(s: string, countryCode?: string): boolean {
  const v = s.toLowerCase();
  if (GEO_WORDS.has(v)) return true;
  if (countryCode) {
    const c = countryByCode(countryCode);
    if (c) {
      if (v === c.code) return true;
      const names = [c.en.toLowerCase().replace(/[^a-z]/g, ""), ...(c.words ?? [])];
      if (names.includes(v)) return true;
    }
  }
  return GEO_CODES.has(v);
}

export const RUN_STATUS_LABELS: Record<string, string> = {
  QUEUED: "В очереди",
  RUNNING: "Проверяется",
  DONE: "Готово",
  FAILED: "Ошибка",
  STOPPED: "Остановлен",
};

export const PATTERN_LABELS: Record<CandidatePattern, string> = {
  brand: "бренд",
  "brand+suffix": "бренд+приставка",
  "brand-suffix": "бренд-приставка",
  "brand-split": "бренд через дефис",
  "brand-split+suffix": "бренд-через-дефис-приставка",
};
