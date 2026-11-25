/**
 * «Анализ конкурентов» (раздел Discovery): новые площадки каталога Collaborator.pro и их семантика.
 * Общие константы, настройки и подписи. Без обращений к базе — файл подключают и страницы, и воркер.
 */

export const PROJECT_SLUG = "competitors";
export const BASE_PATH = "/discovery/competitors";
export const SLOT_DFS = "seo_dfs";
export const SLOT_TEXT = "text_main";
/** Модель кластеризации, если в правиле слота стоит другой провайдер — берётся модель правила. */
export const CLUSTER_MODEL = "openrouter:google/gemini-2.5-flash";

/** Каталог хранит площадки, добавленные не раньше этого срока (фильтр Collaborator add_system=4 — 3 месяца). */
export const KEEP_DAYS = 92;
/** Аренда площадки воркером на время разбора. */
export const LEASE_SECONDS = 600;
export const MAX_ATTEMPTS = 3;

export type CompSettings = {
  /** Сбор и авторазбор включены */
  enabled: boolean;
  /** Страны, по которым разбор идёт сам (названия как в Collaborator, язык ru) */
  countries: string[];
  /** Авторазбор: площадка добавлена не раньше, чем N дней назад */
  periodDays: number;
  minDeals: number;
  minClicks: number;
  /** Сколько самых трафиковых запросов брать с сайта */
  kwLimit: number;
  /** Сколько площадок в сутки разбирать автоматически (защита расхода) */
  dailyLimit: number;
};

export const DEFAULT_SETTINGS: CompSettings = { enabled: true, countries: ["Украина"], periodDays: 61, minDeals: 1, minClicks: 1, kwLimit: 300, dailyLimit: 40 };

const int = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function parseSettings(raw: unknown): CompSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const countries = Array.isArray(r.countries) ? r.countries.map((c) => String(c).trim()).filter(Boolean).slice(0, 30) : DEFAULT_SETTINGS.countries;
  return {
    enabled: r.enabled === undefined ? DEFAULT_SETTINGS.enabled : r.enabled === true || r.enabled === "on",
    countries,
    periodDays: int(r.periodDays, DEFAULT_SETTINGS.periodDays, 7, KEEP_DAYS),
    minDeals: int(r.minDeals, DEFAULT_SETTINGS.minDeals, 0, 50),
    minClicks: int(r.minClicks, DEFAULT_SETTINGS.minClicks, 1, 1_000_000),
    kwLimit: int(r.kwLimit, DEFAULT_SETTINGS.kwLimit, 50, 1000),
    dailyLimit: int(r.dailyLimit, DEFAULT_SETTINGS.dailyLimit, 0, 500),
  };
}

/**
 * Страна площадки → база Google в DataForSEO Labs (location_code). Стран вне списка Labs не знает —
 * такие площадки разбираются по первой известной стране или получают понятную ошибку.
 */
export const DFS_LOCATIONS: Record<string, number> = {
  "Украина": 2804, "США": 2840, "Великобритания": 2826, "Польша": 2616, "Германия": 2276, "Канада": 2124, "Индия": 2356,
  "Испания": 2724, "Франция": 2250, "Италия": 2380, "Казахстан": 2398, "ОАЭ": 2784, "Австралия": 2036, "Нидерланды": 2528,
  "Чехия": 2203, "Румыния": 2642, "Турция": 2792, "Бразилия": 2076, "Мексика": 2484, "Португалия": 2620, "Швеция": 2752,
  "Бельгия": 2056, "Австрия": 2040, "Швейцария": 2756, "Болгария": 2100, "Венгрия": 2348, "Греция": 2300, "Словакия": 2703,
  "Литва": 2440, "Латвия": 2428, "Эстония": 2233, "Молдова": 2498, "Израиль": 2376, "Колумбия": 2170, "Аргентина": 2032,
};

export const splitList = (packed: string): string[] => packed.split("|").map((s) => s.trim()).filter(Boolean);
export const packList = (items: string[]): string => (items.length ? `|${items.join("|")}|` : "");

/** Страна базы для разбора: первая страна площадки, которую знает DataForSEO; предпочтение — странам из настроек. */
export function kwCountryOf(countries: string[], preferred: string[] = []): string | null {
  return countries.find((c) => preferred.includes(c) && DFS_LOCATIONS[c]) ?? countries.find((c) => DFS_LOCATIONS[c]) ?? null;
}

export const STATUS_LABELS: Record<string, string> = { none: "Не разобрана", queued: "В очереди", processing: "Разбирается", done: "Разобрана", empty: "Мало данных", error: "Ошибка" };
export const STATUS_TONE: Record<string, "neutral" | "ok" | "warn" | "danger" | "brand"> = { none: "neutral", queued: "brand", processing: "brand", done: "ok", empty: "warn", error: "danger" };

export type ClusterTop = { kw: string; vol: number | null; pos: number | null };
export type SiteData = {
  gsc?: { clicks?: Array<{ month: string; value: number }>; impressions?: Array<{ month: string; value: number }> };
  description?: string;
  tags?: string[];
};
export type SyncStats = { total?: number; kept?: number; fresh?: number; queued?: number; removed?: number; error?: string; seconds?: number };
