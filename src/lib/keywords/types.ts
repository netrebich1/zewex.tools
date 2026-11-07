/** Подбор ключей Pinterest: константы и общие типы. Инструмент — проект `keywords`, страницы /pinterest/keywords. */

export const KEYWORDS = "keywords";

/** Порог частотности по умолчанию (аудитория Ads Manager US/мес). */
export const MIN_VOLUME = 3000;

export const NICHES = [
  { key: "nails", label: "Ногти", scenario: "2" },
  { key: "hair", label: "Волосы", scenario: "5" },
  { key: "outfits", label: "Одежда", scenario: "7" },
  /** Декор-ключи из «Темы 2027»/Decor, загружены 07.11.2026 только с частотностью (scripts/keywords/import-decor.ts). */
  { key: "interior", label: "Интерьер", scenario: "" },
] as const;
export type Niche = (typeof NICHES)[number]["key"];
export const nicheLabel = (k: string) => NICHES.find((n) => n.key === k)?.label ?? "—";
/** Сценарий запуска статей по нише (как в Google Таблице: 2 ногти, 5 волосы, 7 одежда). */
export const nicheScenario = (k: string) => NICHES.find((n) => n.key === k)?.scenario ?? "";
export const scenarioNiche = (s: string): Niche | "" => NICHES.find((n) => n.scenario === s)?.key ?? "";

export const VERDICTS = [
  { key: "easy", label: "✅ изи", tone: "ok" },
  { key: "medium", label: "🟡 средний", tone: "warn" },
  { key: "hard", label: "🔴 тяжёлый", tone: "danger" },
  { key: "commercial", label: "❌ реклама/товары", tone: "danger" },
  { key: "low_volume", label: "❌ мало частоты", tone: "neutral" },
] as const;
export type Verdict = (typeof VERDICTS)[number]["key"];
export const verdictLabel = (k: string | null | undefined) => VERDICTS.find((v) => v.key === k)?.label ?? "";

export const FLAGS = [
  { key: "video", label: "📹 видео-выдача" },
  { key: "big_media", label: "🏢 крупные СМИ" },
  { key: "weak_opt", label: "🎯 слабая оптимизация топа" },
  { key: "small_accounts", label: "👶 малые аккаунты в топе" },
  { key: "old_articles", label: "🕰 старые статьи в топе" },
  { key: "resaved", label: "🔁 в топе пересохранения пользователей" },
  { key: "few_sites", label: "🔒 топ держат 1-3 сайта" },
  { key: "fresh_top", label: "🆕 свежий пин в топ-3" },
  { key: "old_years", label: "📅 устаревшие годы в заголовках топа" },
  { key: "our_site", label: "🏠 наш сайт в топе" },
  { key: "no_links", label: "🚫 почти нет пинов со ссылкой" },
  { key: "captured", label: "🏰 топ захвачен одним сайтом" },
  { key: "frozen", label: "🧊 замороженная выдача" },
] as const;
export type Flag = (typeof FLAGS)[number]["key"];
export const flagLabel = (k: string) => FLAGS.find((f) => f.key === k)?.label ?? k;

export const SEASONS = [
  { key: "none", label: "Вечнозелёный" },
  { key: "soft", label: "Мягкая сезонность" },
  { key: "trend", label: "Тренды (привязка к году)" },
  { key: "hard", label: "Сезонный" },
] as const;
export const seasonLabel = (k: string) => SEASONS.find((s) => s.key === k)?.label ?? k;

export const SOURCES = [
  { key: "sheet", label: "Таблица Evergreen" },
  { key: "autocomplete", label: "Подсказки Pinterest" },
  { key: "generated", label: "Генерация" },
  { key: "manual", label: "Вручную" },
] as const;
export const sourceLabel = (k: string) => SOURCES.find((s) => s.key === k)?.label ?? k;

export const STATUSES = [
  { key: "new", label: "Не разобран" },
  { key: "picked", label: "В работу" },
  { key: "rejected", label: "Отклонён" },
  { key: "sent", label: "Отправлен в статьи" },
] as const;
export const statusLabel = (k: string) => STATUSES.find((s) => s.key === k)?.label ?? k;

export type MinAvgMax = { min: number; avg: number; max: number } | null;
/** Профиль автора топа: [просмотры/мес, охват/мес, подписчики, пины, доски, бизнес, подтверждённый сайт, проверенный магазин]. */
export type PinnerTuple = [number | null, number | null, number | null, number | null, number | null, 0 | 1, 0 | 1, 0 | 1];
/** Топ-10: [ссылка, дата пина YYYY-MM-DD, сохранения]. */
export type TopTuple = [string, string, number | ""];

/**
 * Агрегаты одного снимка выдачи — формат прототипа (`__analyze` в docs/keyword-research/prototype/serp-analyze.js).
 * n — пинов на первом экране (до 20), org — без рекламы; проценты считаются от n, а tmatch/own/resaved — от org.
 */
export type SerpAgg = {
  n: number; org: number; ad: number; prod: number; info: number; nolink: number;
  fresh: number; fresh3: number; video: number; tmatch: number;
  med: number | null; fol: number | null; listn: number | null;
  udom: number; ndom: number; big: number;
  own?: number; resaved?: number; upload?: number;
  un?: number; views?: MinAvgMax; reach?: MinAvgMax; fols?: MinAvgMax; pins?: MinAvgMax; boards?: MinAvgMax;
  biz?: number; dv?: number; mer?: number;
  /** Органических пинов первого экрана с годом в заголовке и разбивка по годам (новые снимки; у стартовых нет заголовков) */
  ty?: number; tyears?: Record<string, number>;
  ul?: PinnerTuple[];
  top?: TopTuple[]; guides?: string[]; ta?: string[];
  acc?: string;
};

/** Профиль авторов топ-10 (по `ul`), как `prof()` прототипа. */
export type KwProfile = {
  n: number; biz: number; personal: number;
  views: MinAvgMax; reach: MinAvgMax; followers: MinAvgMax;
  pinsAvg: number | null; boardsAvg: number | null; dv: number; mer: number;
};

/** Всё посчитанное для показа строки — `KwKeyword.metrics`. */
export type KwMetrics = {
  agg: Omit<SerpAgg, "top" | "ta" | "guides" | "ul"> | null;
  prof: KwProfile | null;
  /** Статьи топ-10 с датой: возраст в месяцах на момент расчёта */
  art: { newest: number; oldest: number; avg: number; count: number } | null;
  top: TopTuple[];
  variants: string[];
  suggestions: string[];
  guides: string[];
  account: string | null;
  computedAt: string;
  /** Сигналы с учётом позиции (топ-10 органики): см. `positionSignals` */
  pos?: PositionSignals | null;
  /** Статьи топ-10 по позициям (тот же порядок, что `top`): заголовок, год в заголовке, слов, фото */
  topArt?: Array<TopArt | null>;
  /** Оформление пинов топ-10 по позициям: collage | text | photo | unknown | null (ещё не смотрели) */
  topStyle?: Array<string | null>;
  /** Сводка оформления топ-10 (только по определённым пинам) */
  style?: { n: number; collage: number; text: number; photo: number } | null;
  /** Ссылки топ-10: всего, на блоги, на платформы/магазины, разных блогов, блогов на местах 1–5 */
  blogs?: { links: number; blogs: number; platforms: number; domains: number; top5: number } | null;
};

export type PositionSignals = {
  /** Пинов топа с датой */
  n: number;
  /** Доля свежих (< 3 мес) с весом позиции, 0–100 */
  freshW: number;
  /** Свежих пинов на позициях 1–3 */
  freshTop3: number;
  /** Пинов со ссылкой на позициях 1–5 */
  linkTop5: number;
  /** Медиана сохранений позиций 1–3 */
  savesTop3: number | null;
};

export type TopArt = { title: string | null; year: number | null; words: number | null; images: number | null; outdated: boolean; /** ссылка на блог/сайт, а не на платформу или магазин */ blog?: boolean };
