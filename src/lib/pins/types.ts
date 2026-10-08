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

/** Рецепт сайта: единственный объект настроек, снимок которого хранится в прогоне. */
export type Recipe = {
  mix: { ai: number; photos: number; canvas: number; pinora: number };
  photosMode: "all" | "featured_only";
  sets: { aiSetIds: string[]; canvasSetIds: string[]; pinoraTypes: string[] };
  text: {
    language: string;
    hashtags: boolean;
    variety: number;
    elements: { season: boolean; year: boolean; number: boolean; cta: boolean; siteName: boolean };
    audience: "women" | "men" | "mix";
    brandColor?: string;
  };
  publishing: { wpConnectionId: string | null; linkDomain: string; photoLinkPercent: number };
  schedule: { pinsPerDay: number; startFrom: "next_free_day" | string; moderationMode: ModerationMode; samplePercent: number };
  boards: { multiBoard: boolean };
};

export const DEFAULT_RECIPE: Recipe = {
  mix: { ai: 3, photos: 4, canvas: 2, pinora: 0 },
  photosMode: "all",
  sets: { aiSetIds: [], canvasSetIds: [], pinoraTypes: [] },
  text: {
    language: "en",
    hashtags: true,
    variety: 60,
    elements: { season: true, year: true, number: true, cta: true, siteName: false },
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

export function mergeRecipe(partial: unknown): Recipe {
  const p = (partial && typeof partial === "object" ? partial : {}) as Partial<Recipe>;
  const d = DEFAULT_RECIPE;
  return {
    mix: { ...d.mix, ...(p.mix ?? {}) },
    photosMode: p.photosMode ?? d.photosMode,
    sets: { ...d.sets, ...(p.sets ?? {}) },
    text: { ...d.text, ...(p.text ?? {}), elements: { ...d.text.elements, ...(p.text?.elements ?? {}) } },
    publishing: { ...d.publishing, ...(p.publishing ?? {}) },
    schedule: { ...d.schedule, ...(p.schedule ?? {}) },
    boards: { ...d.boards, ...(p.boards ?? {}) },
  };
}
