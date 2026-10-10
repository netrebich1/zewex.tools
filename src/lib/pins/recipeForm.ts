/**
 * Разбор полей формы рецепта (общий для настроек сайта, нового прогона и правки прогона).
 * Без обращений к базе: проверку принадлежности наборов/доступа делает вызывающий код.
 */
import { mergeRecipe, type Recipe } from "./types";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string, def: number, min = 0, max = 1000) => {
  const n = Number(String(f.get(k) ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

export type RecipeFormOptions = {
  /** Разрешённые id наборов (чужие отбрасываются); undefined — не фильтровать. */
  allowedSetIds?: Set<string>;
  /** Проверенный id доступа WordPress; undefined — оставить как в базовом рецепте. */
  wpConnectionId?: string | null;
};

/** Поля формы есть? (если форма не содержит рецепта, вернём базовый без изменений) */
export function formHasRecipe(f: FormData): boolean {
  return f.has("mixAi") || f.has("pinsPerDay") || f.has("pagesSource");
}

export function recipeFromForm(f: FormData, base: unknown, opts: RecipeFormOptions = {}): Recipe {
  const r = mergeRecipe(base);
  if (!formHasRecipe(f)) return r;
  const only = (ids: string[]) => (opts.allowedSetIds ? ids.filter((x) => opts.allowedSetIds!.has(x)) : ids);
  const period = (["all", "range", "days"] as const).find((v) => v === str(f, "pagesPeriod")) ?? r.pages.period;
  const day = (k: string, def: string) => (f.has(k) ? (/^\d{4}-\d{2}-\d{2}$/.test(str(f, k)) ? str(f, k) : "") : def);
  return {
    ...r,
    pages: f.has("pagesSource") ? {
      source: str(f, "pagesSource") === "wp" ? "wp" : "manual",
      postType: str(f, "pagesPostType") === "pages" ? "pages" : "posts",
      categories: f.getAll("pagesCategories").map(Number).filter((n) => Number.isInteger(n) && n > 0),
      excludeCategories: f.get("pagesExclude") === "on",
      period,
      after: day("pagesAfter", r.pages.after), before: day("pagesBefore", r.pages.before),
      days: num(f, "pagesDays", r.pages.days, 1, 3650),
      limit: num(f, "pagesLimit", r.pages.limit, 1, 500),
      skipUsed: f.has("pagesSkipUsedPresent") ? f.get("pagesSkipUsed") === "on" : r.pages.skipUsed,
    } : r.pages,
    mix: { ai: num(f, "mixAi", r.mix.ai, 0, 20), photos: num(f, "mixPhotos", r.mix.photos, 0, 20), canvas: num(f, "mixCanvas", r.mix.canvas, 0, 20), pinora: num(f, "mixPinora", r.mix.pinora, 0, 20) },
    photosMode: str(f, "photosMode") === "featured_only" ? "featured_only" : "all",
    sets: { ...r.sets, aiSetIds: only(f.getAll("aiSetIds").map(String)), canvasSetIds: only(f.getAll("canvasSetIds").map(String)), canvasStyleIds: f.getAll("canvasStyleIds").map(String), pinoraTypes: f.getAll("pinoraTypes").map(String) },
    text: {
      ...r.text,
      language: str(f, "language") || r.text.language,
      percents: {
        season: num(f, "pctSeason", r.text.percents.season, 0, 100), year: num(f, "pctYear", r.text.percents.year, 0, 100),
        number: num(f, "pctNumber", r.text.percents.number, 0, 100), cta: num(f, "pctCta", r.text.percents.cta, 0, 100),
        siteName: num(f, "pctSiteName", r.text.percents.siteName, 0, 100), hashtags: num(f, "pctHashtags", r.text.percents.hashtags, 0, 100),
      },
      numberSource: (["sections", "images", "none"] as const).find((v) => v === str(f, "numberSource")) ?? r.text.numberSource,
      // устаревшие поля держим согласованными
      hashtags: num(f, "pctHashtags", r.text.percents.hashtags, 0, 100) > 0,
      variety: 100,
      elements: { season: num(f, "pctSeason", r.text.percents.season, 0, 100) > 0, year: num(f, "pctYear", r.text.percents.year, 0, 100) > 0, number: num(f, "pctNumber", r.text.percents.number, 0, 100) > 0, cta: num(f, "pctCta", r.text.percents.cta, 0, 100) > 0, siteName: num(f, "pctSiteName", r.text.percents.siteName, 0, 100) > 0 },
      audience: (["women", "men", "mix"] as const).find((a) => a === str(f, "audience")) ?? r.text.audience,
      brandColor: str(f, "brandColor") || undefined,
    },
    publishing: {
      wpConnectionId: opts.wpConnectionId === undefined ? r.publishing.wpConnectionId : opts.wpConnectionId,
      linkDomain: f.has("linkDomain") ? str(f, "linkDomain") : r.publishing.linkDomain,
      photoLinkPercent: num(f, "photoLinkPercent", r.publishing.photoLinkPercent, 0, 100),
    },
    schedule: {
      pinsPerDay: num(f, "pinsPerDay", r.schedule.pinsPerDay, 1, 100),
      startFrom: /^\d{4}-\d{2}-\d{2}$/.test(str(f, "startFrom")) ? str(f, "startFrom") : "next_free_day",
      moderationMode: str(f, "moderationMode") === "auto" ? "auto" : "required",
      samplePercent: r.schedule.samplePercent,
    },
    boards: { multiBoard: f.get("multiBoard") === "on" },
  };
}
