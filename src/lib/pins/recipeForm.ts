/**
 * Разбор полей формы рецепта (общий для настроек сайта, нового прогона и правки прогона).
 * Без обращений к базе: проверку принадлежности наборов/доступа делает вызывающий код.
 */
import { mergeRecipe, type Recipe } from "./types";
import { PINORA_NICHES, PINORA_TYPES, typesForNiche } from "./prompts/pinoraTypes";

/** Типы Pinora, допустимые для ниши: «авто» — только универсальные (без привязки к нише), как в старом сервисе. */
export function allowedPinoraTypes(niche: string): string[] {
  return niche === "auto" || !niche ? PINORA_TYPES.filter((t) => !t.only).map((t) => t.id) : typesForNiche(niche);
}

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
  return f.has("mixAi") || f.has("pinsPerDay") || f.has("pagesSource") || f.has("setsPresent") || f.has("language");
}

export function recipeFromForm(f: FormData, base: unknown, opts: RecipeFormOptions = {}): Recipe {
  const r = mergeRecipe(base);
  if (!formHasRecipe(f)) return r;
  const only = (ids: string[]) => (opts.allowedSetIds ? ids.filter((x) => opts.allowedSetIds!.has(x)) : ids);
  const has = (k: string) => f.has(k);
  const period = (["all", "range", "days"] as const).find((v) => v === str(f, "pagesPeriod")) ?? r.pages.period;
  const day = (k: string, def: string) => (has(k) ? (/^\d{4}-\d{2}-\d{2}$/.test(str(f, k)) ? str(f, k) : "") : def);
  // Каждая группа меняется только если её поля пришли: форма сайта присылает «сайтовые» поля,
  // форма прогона — «прогонные», и ни одна не затирает другую значениями по умолчанию.
  const percents = has("pctSeason") ? {
    season: num(f, "pctSeason", r.text.percents.season, 0, 100), year: num(f, "pctYear", r.text.percents.year, 0, 100),
    number: num(f, "pctNumber", r.text.percents.number, 0, 100), cta: num(f, "pctCta", r.text.percents.cta, 0, 100),
    siteName: num(f, "pctSiteName", r.text.percents.siteName, 0, 100), hashtags: num(f, "pctHashtags", r.text.percents.hashtags, 0, 100),
  } : r.text.percents;
  return {
    ...r,
    pages: has("pagesSource") ? {
      source: str(f, "pagesSource") === "wp" ? "wp" : "manual",
      postType: str(f, "pagesPostType") === "pages" ? "pages" : "posts",
      categories: f.getAll("pagesCategories").map(Number).filter((n) => Number.isInteger(n) && n > 0),
      excludeCategories: f.get("pagesExclude") === "on",
      period,
      after: day("pagesAfter", r.pages.after), before: day("pagesBefore", r.pages.before),
      days: num(f, "pagesDays", r.pages.days, 1, 3650),
      limit: num(f, "pagesLimit", r.pages.limit, 1, 500),
      skipUsed: has("pagesSkipUsedPresent") ? f.get("pagesSkipUsed") === "on" : r.pages.skipUsed,
    } : r.pages,
    mix: has("mixAi") ? { ai: num(f, "mixAi", r.mix.ai, 0, 20), photos: num(f, "mixPhotos", r.mix.photos, 0, 20), canvas: num(f, "mixCanvas", r.mix.canvas, 0, 20), pinora: num(f, "mixPinora", r.mix.pinora, 0, 20) } : r.mix,
    photosMode: has("photosMode") ? (str(f, "photosMode") === "featured_only" ? "featured_only" : "all") : r.photosMode,
    sets: {
      ...r.sets,
      aiSetIds: has("setsPresent") ? only(f.getAll("aiSetIds").map(String)) : r.sets.aiSetIds,
      canvasSetIds: has("setsPresent") ? only(f.getAll("canvasSetIds").map(String)) : r.sets.canvasSetIds,
      canvasStyleIds: has("setsPresent") ? f.getAll("canvasStyleIds").map(String) : r.sets.canvasStyleIds,
      pinoraTypes: has("setsPresent") ? f.getAll("pinoraTypes").map(String).filter((t) => allowedPinoraTypes(has("pinoraNiche") ? str(f, "pinoraNiche") : r.sets.pinoraNiche).includes(t)) : r.sets.pinoraTypes,
      pinoraNiche: has("pinoraNiche") ? (PINORA_NICHES.some((n) => n.id === str(f, "pinoraNiche")) ? str(f, "pinoraNiche") : "auto") : r.sets.pinoraNiche,
    },
    text: {
      ...r.text,
      language: has("language") ? str(f, "language") || r.text.language : r.text.language,
      percents,
      numberSource: (["sections", "images", "none"] as const).find((v) => v === str(f, "numberSource")) ?? r.text.numberSource,
      // устаревшие поля держим согласованными
      hashtags: percents.hashtags > 0,
      variety: 100,
      elements: { season: percents.season > 0, year: percents.year > 0, number: percents.number > 0, cta: percents.cta > 0, siteName: percents.siteName > 0 },
      audience: (["women", "men", "mix"] as const).find((a) => a === str(f, "audience")) ?? r.text.audience,
      brandColor: has("brandColor") ? str(f, "brandColor") || undefined : r.text.brandColor,
      year: has("textYear") ? (/^\d{4}$/.test(str(f, "textYear")) ? str(f, "textYear") : "") : r.text.year,
      siteName: has("textSiteName") ? str(f, "textSiteName").slice(0, 80) : r.text.siteName,
    },
    publishing: {
      wpConnectionId: opts.wpConnectionId === undefined ? r.publishing.wpConnectionId : opts.wpConnectionId,
      linkDomain: has("linkDomain") ? str(f, "linkDomain") : r.publishing.linkDomain,
      photoLinkPercent: num(f, "photoLinkPercent", r.publishing.photoLinkPercent, 0, 100),
    },
    schedule: {
      pinsPerDay: num(f, "pinsPerDay", r.schedule.pinsPerDay, 1, 100),
      startFrom: has("startFrom") ? (/^\d{4}-\d{2}-\d{2}$/.test(str(f, "startFrom")) ? str(f, "startFrom") : "next_free_day") : r.schedule.startFrom,
      moderationMode: has("moderationMode") ? (str(f, "moderationMode") === "auto" ? "auto" : "required") : r.schedule.moderationMode,
      samplePercent: r.schedule.samplePercent,
    },
    boards: { multiBoard: has("multiBoardPresent") ? f.get("multiBoard") === "on" : r.boards.multiBoard },
  };
}
