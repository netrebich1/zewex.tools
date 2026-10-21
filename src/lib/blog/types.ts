/**
 * Общие типы и константы сервиса «Pin Blog Article» (инфо-статьи под Pinterest).
 * Отдельный сервис рядом со «Статьями»: свои модели (Blog*), свой цикл воркера (worker/blog), свой проект портала `blog`.
 * Этапы выполняет только воркер; Next.js ставит посты в очередь и читает агрегаты.
 * Три уровня настроек: система (/sites) → сайт сервиса (BlogSite.settings) → запуск (BlogRun.settings → снимок в BlogPost.recipe).
 */
import type { BlogStatus } from "@prisma/client";

export const PROJECT_SLUG = "blog";
export const BLOG = "/pinterest/blog";

/** Слоты проекта в портале: какие ключи использует сервис. */
export const SLOTS = {
  textMain: "text_main",
  textFast: "text_fast",
  vision: "vision",
  photoDfs: "photo_dfs",
  photoSerp: "photo_serp",
  /** SerpApi Google organic: People Also Ask и заголовки топа для исследования (необязательно) */
  serpOrganic: "serp_organic",
} as const;
export type SlotKey = (typeof SLOTS)[keyof typeof SLOTS];

export const SLOT_LABELS: Record<SlotKey, string> = {
  text_main: "Тексты статьи",
  text_fast: "Быстрые шаги (исследование, мета)",
  vision: "Оценка фото (vision)",
  photo_dfs: "Поиск фото (DataForSEO)",
  photo_serp: "Поиск фото (SerpAPI)",
  serp_organic: "Поисковая выдача (SerpAPI, для исследования)",
};

export type PublishMode = "moderate_first" | "publish_then_edit";
export const PUBLISH_MODES: Array<{ value: PublishMode; label: string; help: string }> = [
  { value: "publish_then_edit", label: "Публиковать сразу", help: "Статья публикуется на сайте, правки — потом." },
  { value: "moderate_first", label: "Черновик до одобрения", help: "На сайте создаётся черновик; публикуется после одобрения в проверке." },
];

export type ReviewMode = "none" | "before_publish";
export const REVIEW_MODES: Array<{ value: ReviewMode; label: string; help: string }> = [
  { value: "before_publish", label: "Проверка перед публикацией", help: "Собранная статья ждёт человека: предпросмотр, замена фото, правка текста, затем публикация." },
  { value: "none", label: "Без проверки", help: "Статья публикуется сразу после сборки (режим публикации решает, черновик это или запись)." },
];

export type Voice = "blogger_first_person" | "expert_neutral" | "warm_guide";
export const VOICES: Array<{ value: Voice; label: string; help: string }> = [
  { value: "blogger_first_person", label: "Блогер от первого лица", help: "Как в примерах владельца: «I've tried them all», подсказки «My tip:», разговорно и уверенно." },
  { value: "warm_guide", label: "Тёплый гид на «вы»", help: "Обращение к читателю, без «я», дружелюбно и конкретно." },
  { value: "expert_neutral", label: "Нейтральный эксперт", help: "Спокойный справочный тон без личности; для health-тем." },
];

export type Tri = "auto" | "always" | "never";
export const TRI_OPTIONS: Array<{ value: Tri; label: string }> = [
  { value: "auto", label: "Решает план (по теме)" },
  { value: "always", label: "Всегда" },
  { value: "never", label: "Никогда" },
];

/** Параметры рецепта инфо-статьи (BlogRecipe.params). Границы — для плана; внутри них структуру выбирает ИИ по теме. */
export type BlogRecipeParams = {
  length: { min: number; max: number };
  images: { min: number; max: number; heroOrientation: "tall" | "square" | "any" };
  voice: Voice;
  /** Имя и роль автора для голоса от первого лица («Victoriya, a nail artist and mom of two») */
  persona: string;
  blocks: { takeaways: Tri; faq: Tri; disclaimer: Tri; closingImage: Tri };
  faqCount: { min: number; max: number };
  /** Внешние ссылки на источники: none — никаких; allowlist — только домены из списка (nofollow) */
  links: { mode: "none" | "allowlist"; allow: string[] };
  research: { serp: boolean };
  review: { aiEditor: boolean };
  /** Плашка с текстом на фото (как Canvas-пин): article — в статье картинка с плашкой; pin_only — только в пине при сохранении; off */
  overlay: { mode: "article" | "pin_only" | "off"; photos: "all" | "hero" };
  language: string;
  country: string;
};

export const DEFAULT_PARAMS: BlogRecipeParams = {
  length: { min: 900, max: 1800 },
  images: { min: 3, max: 6, heroOrientation: "tall" },
  voice: "blogger_first_person",
  persona: "a lifestyle blogger who tests everything at home before writing about it",
  blocks: { takeaways: "auto", faq: "auto", disclaimer: "auto", closingImage: "auto" },
  faqCount: { min: 4, max: 6 },
  links: { mode: "none", allow: [] },
  research: { serp: false },
  review: { aiEditor: false },
  overlay: { mode: "article", photos: "all" },
  language: "en",
  country: "US",
};

/** Настройки поиска фото рецепта (подмножество PhotoSearchConfig статей; нормализация — src/lib/blog/photo/search.ts). */
export type BlogPhotoSearch = {
  source: "dataforseo" | "serpapi";
  country: string;
  language: string;
  freshness: string;
  imageType: "photo" | "any";
  orientation: Array<"tall" | "square" | "wide">;
  minSide: number;
  /** Порог vision-оценки 1–10 для слота */
  minScore: number;
  /** Сколько кандидатов запрашивать на слот */
  perSlot: number;
  excludeDomains: string[];
  uniqueMode: "soft" | "strict" | "off";
  captionMode: "domain_link" | "domain" | "none";
  captionTemplate: string;
};

export const DEFAULT_PHOTO_SEARCH: BlogPhotoSearch = {
  source: "dataforseo",
  country: "us",
  language: "en",
  freshness: "any",
  imageType: "photo",
  orientation: ["tall", "square"],
  minSide: 600,
  minScore: 7,
  perSlot: 40,
  excludeDomains: [],
  uniqueMode: "soft",
  captionMode: "domain_link",
  captionTemplate: "{credit} {domain}",
};

export type BlogPublish = { mode: PublishMode; seoYearUrlPercent: number; schema: "inline" | "off" };
export const DEFAULT_PUBLISH: BlogPublish = { mode: "publish_then_edit", seoYearUrlPercent: 0, schema: "inline" };

/** Промт этапа в рецепте (BlogRecipe.prompts[stageKey]). */
export type BlogPrompt = { system: string; text: string };

/** Рецепт как хранится в BlogRecipe (JSON-поля типизированы). */
export type BlogRecipeShape = {
  id: string;
  name: string;
  models: Record<string, string>;
  prompts: Record<string, BlogPrompt>;
  params: BlogRecipeParams;
  photoSearch: BlogPhotoSearch;
  publish: BlogPublish;
};

/** Настройки сайта в сервисе (BlogSite.settings). */
export type BlogSiteSettings = {
  /** Одновременных постов сайта в работе (все фазы вместе) */
  concurrency: number;
  review: ReviewMode;
  publishMode: PublishMode;
  categories: { defaultId: number | null; rules: Array<{ pattern: string; categoryId: number }>; useAi: boolean };
  search: { country: string; language: string };
  yearInUrlPercent: number | null;
};

export const DEFAULT_SITE_SETTINGS: BlogSiteSettings = {
  concurrency: 3,
  review: "before_publish",
  publishMode: "publish_then_edit",
  categories: { defaultId: null, rules: [], useAi: true },
  search: { country: "", language: "" },
  yearInUrlPercent: null,
};

export const SITE_LIMITS = { concurrency: [1, 30] } as const satisfies Record<string, readonly [number, number]>;

const clampTo = (v: unknown, [min, max]: readonly [number, number], def: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def;
};

export function mergeSiteSettings(raw: unknown): BlogSiteSettings {
  const r = (raw ?? {}) as Partial<BlogSiteSettings>;
  const d = DEFAULT_SITE_SETTINGS;
  return {
    concurrency: clampTo(r.concurrency, SITE_LIMITS.concurrency, d.concurrency),
    review: r.review === "none" ? "none" : "before_publish",
    publishMode: r.publishMode === "moderate_first" ? "moderate_first" : "publish_then_edit",
    categories: { ...d.categories, ...(r.categories ?? {}), rules: r.categories?.rules ?? [] },
    search: { ...d.search, ...(r.search ?? {}) },
    yearInUrlPercent: r.yearInUrlPercent ?? d.yearInUrlPercent,
  };
}

/** Настройки запуска (BlogRun.settings). */
export type BlogRunSettings = {
  recipeId: string;
  review: ReviewMode;
  publishMode: PublishMode;
  search: { country: string; language: string };
  yearInUrlPercent: number | null;
  /** Переопределения объёма и картинок на этот запуск (пусто — из рецепта) */
  length?: { min: number; max: number } | null;
  images?: { min: number; max: number } | null;
  testLabel: string;
};

export type KeywordInput = { keyword: string; focusKeyword?: string };

/** Снимок рецепта и настроек запуска, который сохраняется в BlogPost.recipe и исполняется воркером. */
export type BlogRecipeSnapshot = BlogRecipeShape & {
  run: { review: ReviewMode; publishMode: PublishMode; yearInUrlPercent: number; testLabel: string };
};

/* ───────── Данные этапов ───────── */

export type Intent = "how_to" | "why" | "which" | "comparison" | "list" | "problem_fix" | "what_is" | "other";
export const INTENTS: Intent[] = ["how_to", "why", "which", "comparison", "list", "problem_fix", "what_is", "other"];

/** Исследование темы (BlogPost.brief). */
export type BlogBrief = {
  intent: Intent;
  topicDomain: string;
  audience: string;
  /** Тема про здоровье, деньги, безопасность — осторожные формулировки, дисклеймер, «когда к специалисту» */
  ymyl: boolean;
  summary: string;
  facts: Array<{ text: string; confidence: "high" | "medium" | "low" }>;
  dos: string[];
  donts: string[];
  mistakes: string[];
  safety: string[];
  materials: string[];
  timeline: string;
  questions: string[];
  /** Из SerpApi (если включено): People Also Ask и заголовки топа */
  serp?: { questions: string[]; titles: string[]; headings: string[] } | null;
  model?: string | null;
};

/** Слот картинки в плане. */
export type OutlineImage = { query: string; altQuery?: string; mustShow?: string; avoid?: string; orientation?: "tall" | "square" | "any" };

export type OutlineSection = {
  position: number;
  kind: string;
  heading: string;
  keyPoints: string[];
  targetWords: number;
  /** Подсказка автору: что обязательно, чего избегать */
  notes?: string;
  image?: OutlineImage | null;
};

/** План статьи (BlogPost.outline). */
export type BlogOutline = {
  h1: string;
  title: string;
  metaDescription: string;
  slug: string;
  targetWords: number;
  hero: OutlineImage;
  closingImage?: OutlineImage | null;
  takeaways: boolean;
  faq: { enabled: boolean; count: number; questions: string[] };
  disclaimer: boolean;
  sections: OutlineSection[];
  model?: string | null;
  plannedAt?: string;
};

/** Служебные данные этапов между вызовами (BlogPost.cursor). */
export type BlogCursor = {
  /** Самопочинка после проверки качества: секции уже переписывали */
  qualityRewritten?: number[];
  /** Пересборка после одобрения в проверке */
  reviewApproved?: boolean;
  [k: string]: unknown;
};

export const ACTIVE_STATUSES: BlogStatus[] = ["PENDING", "RUNNING", "REVIEW_PENDING", "NEEDS_REWORK", "PUBLISHING"];
export const HUMAN_STATUSES: BlogStatus[] = ["REVIEW_PENDING", "NEEDS_REWORK"];
