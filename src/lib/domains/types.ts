/**
 * Общие типы и константы инструмента «Подбор доменов» (раздел Gambling).
 * Тяжёлую проверку свободности выполняет воркер; Next.js ставит подбор в очередь и читает результаты.
 */

import { countryByCode, dfsLocationCode } from "./countries";
import { geoWordsOf } from "./geo";

export const PROJECT_SLUG = "domains";
export const SLOT_AI = "text_main";
export const SLOT_SERP_DFS = "serp_dfs";
export const SLOT_SERP_API = "serp_api";

export const LIMITS = {
  brands: 500,
  /** Брендов за один запрос исследования ключей (клиент шлёт пачками) */
  researchChunk: 5,
  modifiersPerBrand: 40,
  tlds: 100,
  suffixesPerTier: 500,
  perBrandMax: 100,
  extraMax: 100,
  aiCandidates: 200,
  serpQueries: 50,
  /** Режим «все варианты»: больше доменов на бренд не проверяем */
  checkAllMax: 2500,
} as const;

export type AvailabilityStatus = "available" | "taken" | "unknown";

export type CandidatePattern =
  | "brand"
  | "brand+suffix"
  | "brand-suffix"
  | "brand-split"
  | "brand-split+suffix"
  /** casino → casinos в бренде со словом казино */
  | "brand-plural"
  /** бренд с одной добавленной буквой (winzorria) */
  | "brand-letter";

/** Где в очереди стоят варианты «бренд + буква». */
export type LetterMode = "off" | "after1" | "last";

/** Модификатор из ключевых слов бренда (DataForSEO, подсказки Google), одобренный для домена. */
export type BrandModifier = {
  suffix: string;
  /** Уровень 1–3 у этого бренда */
  tier: 1 | 2 | 3;
  /** Суммарная частота запросов с этим словом */
  volume: number;
  /** Пример запроса */
  query?: string;
  /** Где нашлось слово: запросы с частотой, подсказки Google, похожие запросы, домены конкурентов */
  sources?: ResearchSourceKind[];
  /** Почему ИИ оставил слово */
  reason?: string;
};

export type ResearchSourceKind = "keywords" | "autocomplete" | "related" | "competitors";

export const RESEARCH_SOURCE_LABELS: Record<ResearchSourceKind, string> = {
  keywords: "запросы с частотой (DataForSEO)",
  autocomplete: "подсказки Google",
  related: "похожие запросы в выдаче",
  competitors: "домены конкурентов в TOP-10",
};

/** Итог сбора ключей и выдачи по бренду: что нашли, что взяли, что отбросили. */
export type BrandResearchSummary = {
  /** auto — собрал подбор перед проверкой; form — собрали вручную в форме */
  origin: "auto" | "form";
  at: string;
  /** Сколько запросов с брендом разобрано */
  queries: number;
  /** Домены TOP-10 Google с брендом в адресе */
  competitorDomains: string[];
  competitorTlds: Array<{ value: string; count: number }>;
  /** Слова, которые ИИ (или вы) отбросили, с причиной */
  rejected: Array<{ suffix: string; word: string; volume: number; reason: string }>;
  errors: string[];
  costUsd: number;
};

/** Бренд пачки со своей страной, своими модификаторами и итогом сбора ключей. */
export type BrandItem = {
  brand: string;
  country: string;
  modifiers: BrandModifier[];
  research?: BrandResearchSummary;
  /** Свои зоны бренда из строки «бренд ; FR ; fr, bet» — к общим, без повторов */
  tlds?: string[];
};

/** Откуда приставка попала в уровни бренда. */
export type SuffixSourceKind = "geo" | "brand" | "common" | "pool";

export type SuffixSource = { kind: SuffixSourceKind; tier: number; detail: string };

export const SUFFIX_SOURCE_TAGS: Record<SuffixSourceKind, string> = { geo: "гео", brand: "ключ", common: "общая", pool: "запас" };

/** Откуда зона попала в зоны бренда. */
export type TldSourceKind = "common" | "list" | "country" | "cctld" | "serp";

export type TldSource = { kind: TldSourceKind; detail: string };

export const TLD_SOURCE_TAGS: Record<TldSourceKind, string> = { common: "общая", list: "зона бренда", country: "набор страны", cctld: "зона страны", serp: "из выдачи" };

/** Набор страны: гео-приставки по уровням и дополнительные зоны. Сохраняется в DomainCountryPreset. */
export type CountryPreset = { tiers: [string[], string[], string[]]; tlds: string[] };

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
  /** Имена брендов (для старых подборов и подписей); источник правды — items */
  brands: string[];
  /** Бренд + страна + модификаторы бренда */
  items: BrandItem[];
  /** Наборы стран, применённые в этом подборе (снимок на момент запуска) */
  countryPresets: Record<string, CountryPreset>;
  /** Варианты с добавленной буквой */
  letterMode: LetterMode;
  /** Уровни 4–6: модификаторы других брендов той же страны, если своих вариантов не хватило */
  usePool: boolean;
  /** Перед проверкой собрать ключи и выдачу Google по каждому бренду (DataForSEO + ИИ-фильтр) */
  autoResearch: boolean;
  /** Проверять все варианты бренда (до LIMITS.checkAllMax), а не останавливаться на perBrand + запас свободных */
  checkAll: boolean;
  /** Добавлять зону страны (.fr) и зоны доменов конкурентов из выдачи */
  autoZones: boolean;
  tlds: string[];
  /** Общие приставки по уровням (к ним добавляются гео-набор страны и модификаторы бренда) */
  suffixTiers: [string[], string[], string[]];
  perBrand: number;
  extraPerBrand: number;
  allowHyphen: boolean;
  /** Страна по умолчанию для брендов без страны */
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
  items: [],
  countryPresets: {},
  letterMode: "after1",
  usePool: true,
  autoResearch: true,
  checkAll: true,
  autoZones: true,
  tlds: ["com", "net"],
  suffixTiers: [[], ["casino", "casinos", "play"], ["app", "online", "365"]],
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

/** Приставка считается гео, если она есть во встроенной гео-базе выбранной страны (geo.ts) или в общем гео-списке. */
export function isGeoSuffix(s: string, countryCode?: string): boolean {
  const v = s.toLowerCase();
  if (GEO_WORDS.has(v)) return true;
  if (countryCode && geoWordsOf(countryCode).has(v)) return true;
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
  "brand-plural": "casino → casinos",
  "brand-letter": "бренд + буква",
};

/** Ключ бренда пачки: один бренд может идти в нескольких странах. */
export function itemKey(brand: string, country: string): string {
  return `${brand}|${country}`;
}

export const LETTER_MODE_LABELS: Record<LetterMode, string> = {
  off: "не добавлять",
  after1: "после уровня 1",
  last: "в самом конце",
};
