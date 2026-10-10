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
    /** Включать выключенные цепочки при появлении новых статей */
    autoRestart: boolean;
  };
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
  autostart: { photoEnabled: true, photoLimit: 3, writingEnabled: true, writingLimit: 3, publishLimit: 2, autoRestart: true },
  aiModeration: { enabled: false, batchFrom: 20, concurrency: 5, backlogThreshold: 0, autoApply: true },
  search: { country: "", language: "", freshness: "" },
  yearInUrlPercent: null,
  sheetUrl: "",
};

export function mergeSiteSettings(raw: unknown): ArtSiteSettings {
  const r = (raw ?? {}) as Partial<ArtSiteSettings>;
  const d = DEFAULT_SITE_SETTINGS;
  return {
    photoCount: { ...d.photoCount, ...(r.photoCount ?? {}) },
    photoReview: r.photoReview ?? d.photoReview,
    publishMode: r.publishMode ?? d.publishMode,
    categories: { ...d.categories, ...(r.categories ?? {}), rules: r.categories?.rules ?? [] },
    autostart: { ...d.autostart, ...(r.autostart ?? {}) },
    aiModeration: { ...d.aiModeration, ...(r.aiModeration ?? {}) },
    search: { ...d.search, ...(r.search ?? {}) },
    yearInUrlPercent: r.yearInUrlPercent ?? d.yearInUrlPercent,
    sheetUrl: r.sheetUrl ?? d.sheetUrl,
  };
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
};

/** Строка ключа при постановке в очередь. */
export type KeywordInput = { keyword: string; seoKeyword?: string; focusKeyword?: string; photoCount?: number };

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
