/**
 * Итог сбора ключей бренда для настроек подбора: взятые модификаторы (с источниками и причиной ИИ)
 * и отброшенные слова с причиной. Чистые функции — их используют и воркер, и форма.
 */
import type { BrandResearch, ResearchModifier } from "./research";
import { LIMITS, type BrandModifier, type BrandResearchSummary } from "./types";

/** Модификатор исследования → модификатор бренда в подборе. */
export function toBrandModifier(m: ResearchModifier, tier: 1 | 2 | 3 = m.tier): BrandModifier {
  return { suffix: m.suffix, tier, volume: m.volume, ...(m.query ? { query: m.query } : {}), sources: m.sources, ...(m.reason ? { reason: m.reason.slice(0, 120) } : {}) };
}

/** Что ИИ оставил (по умолчанию) — модификаторы бренда. */
export function keptModifiers(r: BrandResearch): BrandModifier[] {
  return r.modifiers.filter((m) => m.keep).slice(0, LIMITS.modifiersPerBrand).map((m) => toBrandModifier(m));
}

/** Сводка исследования; kept — суффиксы, которые пошли в домены (остальные — отброшены). */
export function researchSummary(r: BrandResearch, kept: Set<string>, origin: BrandResearchSummary["origin"]): BrandResearchSummary {
  return {
    origin,
    at: new Date().toISOString(),
    queries: r.queries,
    competitorDomains: r.competitorDomains.slice(0, 20),
    competitorTlds: r.tlds.slice(0, 10),
    rejected: r.modifiers.filter((m) => !kept.has(m.suffix)).slice(0, 40).map((m) => ({ suffix: m.suffix, word: m.word, volume: m.volume, reason: (m.reason || "не взято").slice(0, 120) })),
    errors: r.errors.slice(0, 5),
    costUsd: Math.round(r.costUsd * 10000) / 10000,
  };
}
