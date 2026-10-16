/**
 * Общие типы и константы сервиса «Статьи» (Pinterest Articles).
 * Этапы конвейера выполняет только воркер (worker/articles); Next.js ставит статьи в очередь и читает агрегаты.
 * Три уровня настроек: система (/sites) → сайт сервиса (ArtSite.settings) → запуск (ArtRun.settings → снимок в Article.recipe).
 */
import type { ArtFormat } from "@prisma/client";

export const PROJECT_SLUG = "articles";

/** Слоты проекта в портале: какие ключи использует сервис. */
export const SLOTS = {
  textMain: "text_main",
  textFast: "text_fast",
  vision: "vision",
  image: "image_main",
  photoDfs: "photo_dfs",
  photoSerp: "photo_serp",
} as const;
export type SlotKey = (typeof SLOTS)[keyof typeof SLOTS];

/** Минимум одобренных фото, при котором статья с реальными фото идёт дальше и публикуется (mem/constraints/min-publishable-photos). */
export const MIN_PHOTOS = 15;

/** Пределы кругов добора в фото-цепочке (оригинал: photo_filter_cycles ≤ 6, topup после оценки ≤ 7, select_cycles ≤ 7, topups < 6). */
export const PHOTO_LOOPS = { filterCycles: 6, rateTopups: 7, selectCycles: 7, maxTopups: 6 } as const;

/** Закрепление статьи за модератором, минут. */
export const CLAIM_TTL_MIN = 15;

export type PublishMode = "auto" | "moderate_first" | "publish_then_edit";
export const PUBLISH_MODES: Array<{ value: PublishMode; label: string; help: string }> = [
  { value: "publish_then_edit", label: "Публиковать сразу", help: "Статья публикуется на сайте, правки — потом." },
  { value: "moderate_first", label: "Черновик до одобрения", help: "На сайте создаётся черновик; публикуется после одобрения в модерации статей." },
  { value: "auto", label: "Авто", help: "Как «Публиковать сразу», без ручных шагов." },
];

export type WordCount = "compact3" | "compact2" | "compact" | "full";
export const WORD_COUNTS: Array<{ value: WordCount; label: string }> = [
  { value: "compact3", label: "Компактно (~900 слов)" },
  { value: "compact2", label: "Средне (~1400 слов)" },
  { value: "compact", label: "Подробно (~1900 слов)" },
  { value: "full", label: "Полно (2500+ слов)" },
];
export const PERSONALITIES = ["wry", "warm", "curious", "confident", "self-deprecating"] as const;

/** Настройки поиска реальных фото (photo_search_config оригинала). */
export type PhotoSearchConfig = {
  source: "dataforseo" | "serpapi";
  country: string;
  language: string;
  /** any | y | m | w */
  freshness: string;
  license: string;
  imageType: string;
  orientation: Array<"tall" | "square" | "wide">;
  minWidth: number;
  minHeight: number;
  /** Порог vision-оценки 1–10 (при нехватке снижается на 1) */
  minScore: number;
  candidatesTotal: number;
  ratingBatchSize: number;
  includeDomains: string[];
  excludeDomains: string[];
  uniqueMode: "soft" | "strict" | "off";
  /** description — текст пишется по описанию кадра; vision — модель видит картинку */
  writerMode: "description" | "vision";
  captionMode: "domain_link" | "domain" | "none";
  captionTemplate: string;
  querySuffix: string;
};

export type RecipeText = { batchSize: number; personality: string | null; wordCount: WordCount; schemaEnabled: boolean };
export type RecipeImages = {
  provider: string;
  model: string;
  quality: "low" | "medium" | "high";
  size: string;
  mode: "group" | "single";
  groupId: string | null;
  promptId: string | null;
  promptWriterModel: string;
};
export type RecipePublish = { mode: PublishMode; seoYearUrlPercent: number };

/** Рецепт как хранится в ArtRecipe (JSON-поля типизированы). */
export type RecipeShape = {
  id: string;
  name: string;
  nicheCode: string;
  subnicheCode: string | null;
  format: ArtFormat;
  promptSetId: string | null;
  /** {stage_key: prompt_id} */
  stagePromptIds: Record<string, string>;
  /** {stage_key: "provider:model"} */
  stageModels: Record<string, string>;
  text: RecipeText;
  images: RecipeImages;
  photoSearch: PhotoSearchConfig;
  publish: RecipePublish;
};

/** Количество фото/секций в статье: точно или случайно из диапазона при постановке в очередь. */
export type PhotoCountSetting = { mode: "exact" | "range"; min: number; max: number };

/** Настройки сайта в сервисе (ArtSite.settings). Значения по умолчанию для новых запусков + автозапуск и лимиты. */
export type ArtSiteSettings = {
  photoCount: PhotoCountSetting;
  /** Модерация фото до написания текста (режим 2 оригинала). false — текст сразу, модерация готовой статьи. */
  photoReview: boolean;
  publishMode: PublishMode;
  /** Категории WordPress: по умолчанию, правила «подстрока ключа → категория», подбор ИИ при отсутствии правила */
  categories: { defaultId: number | null; rules: Array<{ pattern: string; categoryId: number }>; useAi: boolean };
  autostart: {
    /** Цепочка «фото»: поиск → отбор. Лимит одновременных статей сайта в этой цепочке. */
    photoEnabled: boolean;
    photoLimit: number;
    /** Цепочка «написание»: план → публикация. */
    writingEnabled: boolean;
    writingLimit: number;
    publishLimit: number;
    /**
     * Устаревшие поля (до 2026-10-15: автовыключение цепочки после 15 мин простоя и автовключение). Цепочки теперь
     * включает и выключает только владелец; старые значения читаются один раз миграцией worker/articles/autostart.ts
     * и удаляются. mergeSiteSettings их не возвращает.
     */
    autoRestart?: boolean;
    photoOffReason?: "idle" | "manual";
    photoOffAt?: string;
    photoIdleSince?: string;
    writingOffReason?: "idle" | "manual";
    writingOffAt?: string;
    writingIdleSince?: string;
  };
  /**
   * ИИ-модерация фото сайта. enabled (и мастер-выключатель aiModMaster) — каждая статья сайта с реальными фото после отбора
   * ждёт проверки фото (photoReview принудительно), воркер сразу отдаёт её ИИ. batchFrom — «Запуск от (статей)»: новый запуск
   * ИИ стартует, когда ждут столько статей (1 — сразу); к уже идущему запуску новые статьи добавляются без ожидания.
   */
  aiModeration: { enabled: boolean; batchFrom: number; concurrency: number; backlogThreshold: number; autoApply: boolean };
  /** Переопределения поиска для сайта (пусто — из рецепта) */
  search: { country: string; language: string; freshness: string };
  /** Доля статей с годом в URL, 0–100 (пусто — из рецепта) */
  yearInUrlPercent: number | null;
  sheetUrl: string;
};

export const DEFAULT_SITE_SETTINGS: ArtSiteSettings = {
  photoCount: { mode: "exact", min: 20, max: 20 },
  photoReview: true,
  publishMode: "publish_then_edit",
  categories: { defaultId: null, rules: [], useAi: true },
  autostart: { photoEnabled: true, photoLimit: 3, writingEnabled: true, writingLimit: 3, publishLimit: 2 },
  aiModeration: { enabled: false, batchFrom: 1, concurrency: 5, backlogThreshold: 0, autoApply: true },
  search: { country: "", language: "", freshness: "" },
  yearInUrlPercent: null,
  sheetUrl: "",
};

/** Пределы чисел автозапуска и ИИ-модерации — одни для формы настроек сайта и экрана «Автозапуск». */
export const SITE_LIMITS = {
  photoLimit: [1, 50], writingLimit: [1, 50], publishLimit: [1, 50],
  batchFrom: [1, 200], concurrency: [1, 50], backlogThreshold: [0, 1000],
} as const satisfies Record<string, readonly [number, number]>;

const clampTo = (v: unknown, [min, max]: readonly [number, number], def: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def;
};

export function mergeSiteSettings(raw: unknown): ArtSiteSettings {
  const r = (raw ?? {}) as Partial<ArtSiteSettings>;
  const d = DEFAULT_SITE_SETTINGS;
  const a = { ...d.autostart, ...(r.autostart ?? {}) };
  const m = { ...d.aiModeration, ...(r.aiModeration ?? {}) };
  const L = SITE_LIMITS;
  return {
    photoCount: { ...d.photoCount, ...(r.photoCount ?? {}) },
    photoReview: r.photoReview ?? d.photoReview,
    publishMode: r.publishMode ?? d.publishMode,
    categories: { ...d.categories, ...(r.categories ?? {}), rules: r.categories?.rules ?? [] },
    // Только действующие поля: устаревшие пометки простоя (autoRestart, *OffReason, *IdleSince…) сюда не попадают.
    autostart: {
      photoEnabled: a.photoEnabled !== false, photoLimit: clampTo(a.photoLimit, L.photoLimit, d.autostart.photoLimit),
      writingEnabled: a.writingEnabled !== false, writingLimit: clampTo(a.writingLimit, L.writingLimit, d.autostart.writingLimit),
      publishLimit: clampTo(a.publishLimit, L.publishLimit, d.autostart.publishLimit),
    },
    aiModeration: {
      enabled: m.enabled === true,
      // 0/пусто в старых данных — «без ожидания»
      batchFrom: clampTo(m.batchFrom || 1, L.batchFrom, 1),
      concurrency: clampTo(m.concurrency, L.concurrency, d.aiModeration.concurrency),
      backlogThreshold: clampTo(m.backlogThreshold, L.backlogThreshold, 0),
      autoApply: m.autoApply !== false,
    },
    search: { ...d.search, ...(r.search ?? {}) },
    yearInUrlPercent: r.yearInUrlPercent ?? d.yearInUrlPercent,
    sheetUrl: r.sheetUrl ?? d.sheetUrl,
  };
}

/**
 * ИИ-модерация фото действует на сайте: включена в настройках сайта и (если передан) мастер-выключатель aiModMaster включён.
 * Тогда статья с реальными фото после отбора ждёт проверки фото (PHOTO_REVIEW) — её сразу берёт ИИ.
 * siteSettings — сырое ArtSite.settings или уже собранное mergeSiteSettings.
 */
export function aiModerationOn(siteSettings: unknown, global?: { aiModMaster: boolean }): boolean {
  if (global && !global.aiModMaster) return false;
  return mergeSiteSettings(siteSettings).aiModeration.enabled;
}

/** Настройки запуска (ArtRun.settings): что выбрал пользователь на странице «Новый запуск». */
export type ArtRunSettings = {
  recipeId: string;
  photoCount: PhotoCountSetting;
  photoReview: boolean;
  publishMode: PublishMode;
  search: { country: string; language: string; freshness: string };
  yearInUrlPercent: number | null;
  /** Служебная метка для тестов (не попадает в тексты) */
  testLabel: string;
  /** Запуск из Google Таблицы: откуда взяты ключи (вкладка = домен сайта). Рецепт и режим тогда у каждой статьи свои — из строки таблицы. */
  sheet?: { url: string; tab: string };
};

/**
 * Строка ключа при постановке в очередь. Поля после photoCount — переопределения одной статьи поверх параметров запуска
 * (импорт из Google Таблицы: рецепт по номеру, режим, год в URL, поиск фото, номер строки для обратной записи отчёта).
 */
export type KeywordInput = {
  keyword: string; seoKeyword?: string; focusKeyword?: string; photoCount?: number;
  recipeId?: string;
  photoReview?: boolean;
  yearInUrlPercent?: number;
  search?: { country?: string; language?: string; freshness?: string };
  sheetRow?: number;
};

/**
 * Снимок рецепта и настроек запуска, который сохраняется в Article.recipe и исполняется воркером.
 * Правка рецепта после запуска на статью не влияет.
 */
export type ArticleRecipeSnapshot = RecipeShape & {
  run: { photoReview: boolean; publishMode: PublishMode; yearInUrlPercent: number; testLabel: string };
};

/** Атрибуты ключа и контракт темы (parse-keyword + topicContract + fashion/interior contract). */
export type ArticleFacts = {
  keywordAttributes?: Record<string, unknown>;
  topicContract?: Record<string, unknown>;
  fashionContract?: Record<string, unknown>;
  interiorContract?: Record<string, unknown>;
  audience?: Record<string, unknown>;
  trendBrief?: Record<string, unknown>;
  keywordRu?: string;
};

/** План статьи (результат rp_photo_plan + мета + блюпринт). */
export type ArticlePlan = {
  h1: string;
  title: string;
  metaDescription: string;
  slug: string;
  introPlan?: string;
  outroPlan?: string;
  carePlan?: string;
  /** Порядок фото: id ArtPhoto */
  order?: string[];
  sections?: Array<{ position: number; photoId: string | null; heading: string; brief?: Record<string, unknown> }>;
  [k: string]: unknown;
};

/** Служебные данные этапов между вызовами (Article.cursor). */
export type ArticleCursor = {
  topups?: number;
  filterCycles?: number;
  rateTopups?: number;
  selectCycles?: number;
  searchQueries?: { primary: string[]; secondary: string[] };
  usedQueries?: string[];
  minScore?: number;
  [k: string]: unknown;
};

/** Случайное число фото из настройки диапазона. */
export function pickPhotoCount(p: PhotoCountSetting): number {
  const min = Math.max(1, Math.min(p.min, p.max));
  const max = Math.max(p.min, p.max);
  if (p.mode === "exact") return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}
