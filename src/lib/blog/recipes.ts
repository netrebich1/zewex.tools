/**
 * Рецепты инфо-статей: типизация строки базы, снимок для поста, готовность (промты всех этапов + ключи слотов).
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { BlogRecipe } from "@prisma/client";
import { slotAvailable } from "./ai";
import { hasPrompt } from "./prompts";
import { BLOG_STAGES, OPTIONAL_PROMPT_KEYS, STAGE_INFO } from "./stages";
import { DEFAULT_PARAMS, DEFAULT_PHOTO_SEARCH, DEFAULT_PUBLISH, SLOTS, SLOT_LABELS, type BlogPhotoSearch, type BlogPrompt, type BlogPublish, type BlogRecipeParams, type BlogRecipeShape, type BlogRecipeSnapshot, type BlogRunSettings, type SlotKey } from "./types";

export const POPULAR_MODELS = ["openrouter:google/gemini-2.5-flash-lite", "openrouter:google/gemini-2.5-flash", "openrouter:deepseek/deepseek-v4-flash", "openrouter:deepseek/deepseek-v4-pro-0813", "openrouter:anthropic/claude-sonnet-4.5"];

const num = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
};
const tri = (v: unknown, d: BlogRecipeParams["blocks"]["faq"]) => (v === "always" || v === "never" || v === "auto" ? v : d);

export function mergeParams(raw: unknown): BlogRecipeParams {
  const r = (raw ?? {}) as Partial<BlogRecipeParams>;
  const d = DEFAULT_PARAMS;
  const lmin = num(r.length?.min, d.length.min, 300, 5000);
  const lmax = Math.max(lmin, num(r.length?.max, d.length.max, 300, 6000));
  const imin = num(r.images?.min, d.images.min, 1, 12);
  const imax = Math.max(imin, num(r.images?.max, d.images.max, 1, 12));
  const fmin = num(r.faqCount?.min, d.faqCount.min, 2, 10);
  const fmax = Math.max(fmin, num(r.faqCount?.max, d.faqCount.max, 2, 10));
  return {
    length: { min: lmin, max: lmax },
    images: { min: imin, max: imax, heroOrientation: r.images?.heroOrientation === "square" || r.images?.heroOrientation === "any" ? r.images.heroOrientation : "tall" },
    voice: r.voice === "expert_neutral" || r.voice === "warm_guide" ? r.voice : "blogger_first_person",
    persona: String(r.persona ?? d.persona).slice(0, 300) || d.persona,
    blocks: { takeaways: tri(r.blocks?.takeaways, "auto"), faq: tri(r.blocks?.faq, "auto"), disclaimer: tri(r.blocks?.disclaimer, "auto"), closingImage: tri(r.blocks?.closingImage, "auto") },
    faqCount: { min: fmin, max: fmax },
    links: { mode: r.links?.mode === "allowlist" ? "allowlist" : "none", allow: Array.isArray(r.links?.allow) ? r.links!.allow.map(String).filter(Boolean) : [] },
    research: { serp: r.research?.serp === true },
    review: { aiEditor: r.review?.aiEditor === true },
    language: String(r.language ?? d.language).toLowerCase().slice(0, 5) || "en",
    country: String(r.country ?? d.country).toUpperCase().slice(0, 2) || "US",
  };
}

export function mergePhotoSearch(raw: unknown): BlogPhotoSearch {
  const r = (raw ?? {}) as Partial<BlogPhotoSearch>;
  const d = DEFAULT_PHOTO_SEARCH;
  const orientation = Array.isArray(r.orientation) ? r.orientation.filter((o): o is "tall" | "square" | "wide" => o === "tall" || o === "square" || o === "wide") : [];
  return {
    source: r.source === "serpapi" ? "serpapi" : "dataforseo",
    country: String(r.country ?? d.country).toLowerCase().slice(0, 2) || d.country,
    language: String(r.language ?? d.language).toLowerCase().slice(0, 5) || d.language,
    freshness: String(r.freshness ?? d.freshness) || "any",
    imageType: r.imageType === "any" ? "any" : "photo",
    orientation: orientation.length ? orientation.slice(0, 2) : d.orientation,
    minSide: num(r.minSide, d.minSide, 300, 4000),
    minScore: num(r.minScore, d.minScore, 1, 10),
    perSlot: num(r.perSlot, d.perSlot, 20, 200),
    excludeDomains: Array.isArray(r.excludeDomains) ? r.excludeDomains.map(String).filter(Boolean) : [],
    uniqueMode: r.uniqueMode === "strict" || r.uniqueMode === "off" ? r.uniqueMode : "soft",
    captionMode: r.captionMode === "domain" || r.captionMode === "none" ? r.captionMode : "domain_link",
    captionTemplate: String(r.captionTemplate ?? d.captionTemplate) || d.captionTemplate,
  };
}

export function mergePublish(raw: unknown): BlogPublish {
  const r = (raw ?? {}) as Partial<BlogPublish>;
  return { mode: r.mode === "moderate_first" ? "moderate_first" : "publish_then_edit", seoYearUrlPercent: num(r.seoYearUrlPercent, 0, 0, 100), schema: r.schema === "off" ? "off" : "inline" };
}

export function mergePrompts(raw: unknown): Record<string, BlogPrompt> {
  const out: Record<string, BlogPrompt> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const o = v as Record<string, unknown>;
      out[k] = { system: String(o.system ?? ""), text: String(o.text ?? "") };
    }
  }
  return out;
}

/** Строка BlogRecipe → типизированный рецепт. */
export function recipeShape(r: BlogRecipe): BlogRecipeShape {
  return {
    id: r.id,
    name: r.name,
    models: ((r.models ?? {}) as Record<string, string>) || {},
    prompts: mergePrompts(r.prompts),
    params: mergeParams(r.params),
    photoSearch: mergePhotoSearch(r.photoSearch),
    publish: mergePublish(r.publish),
  };
}

/** Снимок рецепта для поста с учётом настроек запуска. */
export function buildSnapshot(recipe: BlogRecipeShape, s: BlogRunSettings): BlogRecipeSnapshot {
  const yearPct = s.yearInUrlPercent ?? recipe.publish.seoYearUrlPercent ?? 0;
  return {
    ...recipe,
    params: {
      ...recipe.params,
      ...(s.length ? { length: { min: Math.min(s.length.min, s.length.max), max: Math.max(s.length.min, s.length.max) } } : {}),
      ...(s.images ? { images: { ...recipe.params.images, min: Math.min(s.images.min, s.images.max), max: Math.max(s.images.min, s.images.max) } } : {}),
    },
    photoSearch: {
      ...recipe.photoSearch,
      ...(s.search.country ? { country: s.search.country } : {}),
      ...(s.search.language ? { language: s.search.language } : {}),
    },
    publish: { ...recipe.publish, mode: s.publishMode, seoYearUrlPercent: yearPct },
    run: { review: s.review, publishMode: s.publishMode, yearInUrlPercent: yearPct, testLabel: s.testLabel ?? "" },
  };
}

/* ───────── Готовность ───────── */

export type RecipeReadiness = { missingPrompts: string[]; missingSlots: string[]; ok: boolean };

/** Правила слотов пользователя для проекта: один раз на страницу. */
export async function userSlots(me: CurrentUser): Promise<Record<SlotKey, boolean>> {
  const keys = Object.values(SLOTS) as SlotKey[];
  const flags = await Promise.all(keys.map((k) => slotAvailable(me.id, k).catch(() => false)));
  return Object.fromEntries(keys.map((k, i) => [k, flags[i]])) as Record<SlotKey, boolean>;
}

/** Слоты, нужные конвейеру: фото-поиск — достаточно одного из DataForSEO/SerpAPI; serp_organic — только при research.serp. */
export function missingSlotsFor(recipe: BlogRecipeShape, have: Record<SlotKey, boolean>): string[] {
  const need = new Set<string>();
  for (const st of BLOG_STAGES) for (const s of STAGE_INFO[st].slots) need.add(s);
  const out: string[] = [];
  need.delete(SLOTS.photoDfs); need.delete(SLOTS.photoSerp);
  if (!have.photo_dfs && !have.photo_serp) out.push("Поиск фото (DataForSEO или SerpAPI)");
  if (!recipe.params.research.serp) need.delete(SLOTS.serpOrganic);
  for (const s of need) if (!have[s as SlotKey]) out.push(SLOT_LABELS[s as SlotKey] ?? s);
  return out;
}

export function recipeReadiness(recipe: BlogRecipeShape, have: Record<SlotKey, boolean>): RecipeReadiness {
  const missing: string[] = [];
  for (const st of BLOG_STAGES) for (const k of STAGE_INFO[st].promptKeys) if (!OPTIONAL_PROMPT_KEYS.has(k) && !hasPrompt(recipe.prompts[k])) missing.push(k);
  const missingSlots = missingSlotsFor(recipe, have);
  return { missingPrompts: missing, missingSlots, ok: !missing.length && !missingSlots.length };
}

/** Дубликаты ключей по сайту (кроме FAILED/STOPPED). В нижнем регистре. */
export async function findDuplicateKeywords(siteId: string, keywords: string[]): Promise<string[]> {
  const list = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
  if (!list.length) return [];
  const rows = await prisma.blogPost.findMany({ where: { siteId, status: { notIn: ["FAILED", "STOPPED"] }, keyword: { in: list } }, select: { keyword: true } });
  const have = new Set(rows.map((r) => r.keyword.toLowerCase()));
  return list.filter((k) => have.has(k.toLowerCase())).map((k) => k.toLowerCase());
}
