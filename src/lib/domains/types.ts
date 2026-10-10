/**
 * Общие типы и константы инструмента «Подбор доменов» (раздел Gambling).
 * Тяжёлую проверку свободности выполняет воркер; Next.js ставит подбор в очередь и читает результаты.
 */

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

/** Страны для анализа выдачи: код → location_code DataForSEO (ISO-3166 numeric) и язык. Для SerpAPI — gl/hl. */
export const DFS_COUNTRIES: DfsCountry[] = [
  { code: "nl", name: "Нидерланды", locationCode: 2528, languageCode: "nl" },
  { code: "be", name: "Бельгия", locationCode: 2056, languageCode: "nl" },
  { code: "de", name: "Германия", locationCode: 2276, languageCode: "de" },
  { code: "at", name: "Австрия", locationCode: 2040, languageCode: "de" },
  { code: "ch", name: "Швейцария", locationCode: 2756, languageCode: "de" },
  { code: "gb", name: "Великобритания", locationCode: 2826, languageCode: "en" },
  { code: "us", name: "США", locationCode: 2840, languageCode: "en" },
  { code: "ca", name: "Канада", locationCode: 2124, languageCode: "en" },
  { code: "au", name: "Австралия", locationCode: 2036, languageCode: "en" },
  { code: "fr", name: "Франция", locationCode: 2250, languageCode: "fr" },
  { code: "es", name: "Испания", locationCode: 2724, languageCode: "es" },
  { code: "it", name: "Италия", locationCode: 2380, languageCode: "it" },
  { code: "pl", name: "Польша", locationCode: 2616, languageCode: "pl" },
  { code: "ro", name: "Румыния", locationCode: 2642, languageCode: "ro" },
  { code: "bg", name: "Болгария", locationCode: 2100, languageCode: "bg" },
  { code: "gr", name: "Греция", locationCode: 2300, languageCode: "el" },
  { code: "hu", name: "Венгрия", locationCode: 2348, languageCode: "hu" },
  { code: "cz", name: "Чехия", locationCode: 2203, languageCode: "cs" },
  { code: "sk", name: "Словакия", locationCode: 2703, languageCode: "sk" },
  { code: "si", name: "Словения", locationCode: 2705, languageCode: "sl" },
  { code: "pt", name: "Португалия", locationCode: 2620, languageCode: "pt" },
  { code: "br", name: "Бразилия", locationCode: 2076, languageCode: "pt" },
  { code: "tr", name: "Турция", locationCode: 2792, languageCode: "tr" },
  { code: "se", name: "Швеция", locationCode: 2752, languageCode: "sv" },
  { code: "no", name: "Норвегия", locationCode: 2578, languageCode: "no" },
  { code: "dk", name: "Дания", locationCode: 2208, languageCode: "da" },
  { code: "fi", name: "Финляндия", locationCode: 2246, languageCode: "fi" },
  { code: "ie", name: "Ирландия", locationCode: 2372, languageCode: "en" },
  { code: "nz", name: "Новая Зеландия", locationCode: 2554, languageCode: "en" },
  { code: "jp", name: "Япония", locationCode: 2392, languageCode: "ja" },
];

const BY_CODE = new Map(DFS_COUNTRIES.map((c) => [c.code, c]));

export function getCountry(code: string): DfsCountry | null {
  return BY_CODE.get(code.trim().toLowerCase()) ?? null;
}

/** Гео-слова: такие приставки из анализа выдачи попадают в уровень 1 по умолчанию. */
export const GEO_WORDS = new Set([
  ...DFS_COUNTRIES.map((c) => c.code),
  "nederland", "netherlands", "netherland", "holland", "deutschland", "espana", "italia", "france", "polska", "belgie", "belgique", "belgium",
  "osterreich", "suisse", "schweiz", "eu", "uk", "usa", "canada", "australia", "romania", "bulgaria", "greece", "magyar", "cesko", "slovensko",
  "slovenija", "portugal", "brasil", "turkiye", "sverige", "norge", "danmark", "suomi", "ireland", "japan",
]);

export function isGeoSuffix(s: string): boolean {
  return GEO_WORDS.has(s.toLowerCase());
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
