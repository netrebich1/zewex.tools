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
  return f.has("mixAi") || f.has("pinsPerDay");
}

export function recipeFromForm(f: FormData, base: unknown, opts: RecipeFormOptions = {}): Recipe {
  const r = mergeRecipe(base);
  if (!formHasRecipe(f)) return r;
  const only = (ids: string[]) => (opts.allowedSetIds ? ids.filter((x) => opts.allowedSetIds!.has(x)) : ids);
  return {
    ...r,
    mix: { ai: num(f, "mixAi", r.mix.ai, 0, 20), photos: num(f, "mixPhotos", r.mix.photos, 0, 20), canvas: num(f, "mixCanvas", r.mix.canvas, 0, 20), pinora: num(f, "mixPinora", r.mix.pinora, 0, 20) },
    photosMode: str(f, "photosMode") === "featured_only" ? "featured_only" : "all",
    sets: { ...r.sets, aiSetIds: only(f.getAll("aiSetIds").map(String)), canvasSetIds: only(f.getAll("canvasSetIds").map(String)), canvasStyleIds: f.getAll("canvasStyleIds").map(String), pinoraTypes: f.getAll("pinoraTypes").map(String) },
    text: {
      ...r.text,
      language: str(f, "language") || r.text.language,
      hashtags: f.get("hashtags") === "on",
      variety: num(f, "variety", r.text.variety, 0, 100),
      elements: { season: f.get("elSeason") === "on", year: f.get("elYear") === "on", number: f.get("elNumber") === "on", cta: f.get("elCta") === "on", siteName: f.get("elSiteName") === "on" },
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
