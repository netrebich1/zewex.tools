/**
 * Общие типы и константы сервиса Pinterest Pins.
 * Этапы прогона выполняет только воркер; Next.js ставит задачи и читает агрегаты.
 */

export const PIN_STAGES = [
  "pages",
  "meta",
  "photos",
  "plan",
  "prompts",
  "images",
  "canvas",
  "moderation",
  "texts",
  "upload",
  "schedule",
  "ready",
] as const;
export type PinStage = (typeof PIN_STAGES)[number];

/** Этапы, которые можно поставить в очередь как задачу воркера. */
export const JOB_STAGES = ["noop", "meta", "photos", "plan", "prompts", "images", "canvas", "texts", "upload", "schedule", "previews"] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export const PROJECT_SLUG = "pins";
export const SLOT_TEXT_MAIN = "text_main";
export const SLOT_TEXT_FAST = "text_fast";
export const SLOT_IMAGE_MAIN = "image_main";

/** Лимиты Pinterest на тексты пина. */
export const LIMITS = { title: 100, alt: 490, description: 500, descriptionWithTags: 350 } as const;
export const MAX_PINS_PER_DAY = 100;
export const SCHEDULE = { windowDays: 30, perPagePerDay: 2, firstPinWindowDays: 3, stepMinDays: 2, stepMaxDays: 5, hourFrom: 8, hourTo: 21 } as const;

export type ModerationMode = "required" | "auto" | "sample";

export type ElementPercents = { season: number; year: number; number: number; cta: number; siteName: number; hashtags: number };
export const ELEMENT_KEYS: ReadonlyArray<keyof ElementPercents> = ["season", "year", "number", "cta", "siteName", "hashtags"];

export type PagesPeriod = "all" | "range" | "days";

/**
 * Откуда брать статьи для прогона: вставлять ссылки вручную или подтягивать
 * из WordPress по REST API (тип записей, категории, период публикации, лимит).
 */
export type PagesSource = {
  source: "manual" | "wp";
  postType: "posts" | "pages";
  /** Id категорий WordPress; excludeCategories — брать все, кроме этих. */
  categories: number[];
  excludeCategories: boolean;
  /** all — любые даты; range — с after по before; days — за последние N дней от запуска. */
  period: PagesPeriod;
  /** yyyy-mm-dd */
  after: string;
  before: string;
  days: number;
  limit: number;
  /** Не брать статьи, которые уже были в прогонах сайта. */
  skipUsed: boolean;
};

/** Рецепт сайта: единственный объект настроек, снимок которого хранится в прогоне. */
export type Recipe = {
  pages: PagesSource;
  mix: { ai: number; photos: number; canvas: number; pinora: number };
  photosMode: "all" | "featured_only";
  /** canvasStyleIds — утверждённые Canvas-стили каталога, выбранные напрямую; canvasSetIds — старые наборы (совместимость). */
  sets: { aiSetIds: string[]; canvasSetIds: string[]; canvasStyleIds: string[]; pinoraTypes: string[] };
  text: {
    language: string;
    /** Устаревшие поля (до percents): hashtags/variety/elements. Сохраняются для совместимости. */
    hashtags: boolean;
    variety: number;
    elements: { season: boolean; year: boolean; number: boolean; cta: boolean; siteName: boolean };
    /** Доля пинов (0–100), получающих элемент: сезон, год, число идей, призыв, имя сайта, хэштеги. */
    percents: ElementPercents;
    /** Откуда берётся «число идей»: по разделам статьи (первое фото в H2), по всем фото, или не считать. */
    numberSource: "sections" | "images" | "none";
    audience: "women" | "men" | "mix";
    brandColor?: string;
  };
  publishing: { wpConnectionId: string | null; linkDomain: string; photoLinkPercent: number };
  schedule: { pinsPerDay: number; startFrom: "next_free_day" | string; moderationMode: ModerationMode; samplePercent: number };
  boards: { multiBoard: boolean };
};

export const DEFAULT_RECIPE: Recipe = {
  pages: { source: "manual", postType: "posts", categories: [], excludeCategories: false, period: "all", after: "", before: "", days: 30, limit: 100, skipUsed: true },
  mix: { ai: 3, photos: 4, canvas: 2, pinora: 0 },
  photosMode: "all",
  sets: { aiSetIds: [], canvasSetIds: [], canvasStyleIds: [], pinoraTypes: [] },
  text: {
    language: "en",
    hashtags: true,
    variety: 60,
    elements: { season: true, year: true, number: true, cta: true, siteName: false },
    percents: { season: 60, year: 60, number: 60, cta: 60, siteName: 0, hashtags: 60 },
    numberSource: "sections",
    audience: "women",
  },
  publishing: { wpConnectionId: null, linkDomain: "", photoLinkPercent: 40 },
  schedule: { pinsPerDay: 90, startFrom: "next_free_day", moderationMode: "required", samplePercent: 20 },
  boards: { multiBoard: false },
};

/** Снимок настроек прогона = рецепт + параметры запуска. */
export type RunSettings = Recipe & {
  siteName: string;
  siteSlug: string;
  seed: number;
  launchedAt: string;
};

const pct = (v: unknown, def: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : def; };

/** Старые рецепты (переключатели + variety) переводятся в проценты по элементам. */
function mergeText(t: Partial<Recipe["text"]> | undefined): Recipe["text"] {
  const d = DEFAULT_RECIPE.text;
  const elements = { ...d.elements, ...(t?.elements ?? {}) };
  const variety = pct(t?.variety, d.variety);
  const hashtags = t?.hashtags ?? d.hashtags;
  const legacy: ElementPercents = {
    season: elements.season ? variety : 0, year: elements.year ? variety : 0, number: elements.number ? variety : 0,
    cta: elements.cta ? variety : 0, siteName: elements.siteName ? variety : 0, hashtags: hashtags ? variety : 0,
  };
  const pp = (t?.percents ?? {}) as Partial<ElementPercents>;
  const percents: ElementPercents = t?.percents
    ? { season: pct(pp.season, 0), year: pct(pp.year, 0), number: pct(pp.number, 0), cta: pct(pp.cta, 0), siteName: pct(pp.siteName, 0), hashtags: pct(pp.hashtags, 0) }
    : legacy;
  return {
    ...d, ...(t ?? {}), elements, variety, hashtags, percents,
    numberSource: t?.numberSource === "images" || t?.numberSource === "none" ? t.numberSource : "sections",
  };
}

/** Число идей страницы по настройке рецепта. */
export function ideaCountFor(page: { sectionImageCount?: number | null; imageCount?: number | null }, text: Pick<Recipe["text"], "numberSource">): number {
  if (text.numberSource === "none") return 0;
  const sections = page.sectionImageCount ?? 0, images = page.imageCount ?? 0;
  return text.numberSource === "images" ? images || sections : sections || images;
}

const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");

function mergePages(p: Partial<PagesSource> | undefined): PagesSource {
  const d = DEFAULT_RECIPE.pages;
  const days = Number(p?.days), limit = Number(p?.limit);
  return {
    source: p?.source === "wp" ? "wp" : "manual",
    postType: p?.postType === "pages" ? "pages" : "posts",
    categories: Array.isArray(p?.categories) ? p!.categories.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [],
    excludeCategories: p?.excludeCategories === true,
    period: p?.period === "range" || p?.period === "days" ? p.period : "all",
    after: isoDay(p?.after), before: isoDay(p?.before),
    days: Number.isFinite(days) ? Math.min(3650, Math.max(1, Math.round(days))) : d.days,
    limit: Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.round(limit))) : d.limit,
    skipUsed: p?.skipUsed !== false,
  };
}

/** Окно дат публикации по настройке источника: для «за последние N дней» считается от момента запуска. */
export function pagesDateWindow(p: PagesSource, now = new Date()): { after?: string; before?: string } {
  if (p.period === "range") return { after: p.after || undefined, before: p.before || undefined };
  if (p.period === "days") {
    const from = new Date(now.getTime() - p.days * 86_400_000);
    return { after: from.toISOString().slice(0, 10) };
  }
  return {};
}

/** Короткое описание источника статей для подсказок в интерфейсе. */
export function describePagesSource(p: PagesSource): string {
  if (p.source !== "wp") return "ссылки вручную";
  const parts = [p.postType === "pages" ? "страницы WordPress" : "записи WordPress"];
  if (p.categories.length) parts.push(`${p.excludeCategories ? "кроме" : "из"} ${p.categories.length} категорий`);
  if (p.period === "days") parts.push(`за последние ${p.days} дн.`);
  if (p.period === "range") parts.push(`${p.after ? "с " + p.after : ""}${p.before ? " по " + p.before : ""}`.trim());
  parts.push(`до ${p.limit}`);
  if (p.skipUsed) parts.push("без уже использованных");
  return parts.join(", ");
}

export function mergeRecipe(partial: unknown): Recipe {
  const p = (partial && typeof partial === "object" ? partial : {}) as Partial<Recipe>;
  const d = DEFAULT_RECIPE;
  return {
    pages: mergePages(p.pages),
    mix: { ...d.mix, ...(p.mix ?? {}) },
    photosMode: p.photosMode ?? d.photosMode,
    sets: { ...d.sets, ...(p.sets ?? {}) },
    text: mergeText(p.text),
    publishing: { ...d.publishing, ...(p.publishing ?? {}) },
    schedule: { ...d.schedule, ...(p.schedule ?? {}) },
    boards: { ...d.boards, ...(p.boards ?? {}) },
  };
}
