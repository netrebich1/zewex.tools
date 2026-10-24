/**
 * Наборы стран: гео-приставки по уровням и дополнительные зоны.
 * Гео-приставки всегда из встроенной базы (geo.ts), пользователь их не вводит.
 * Сохранённый набор (DomainCountryPreset) хранит только доп. зоны страны.
 */
import { geoTiers } from "./geo";
import { cleanSuffix, dedupeTiers, normalizeTld } from "./generator";
import type { CountryPreset } from "./types";

const normalizeTlds = (raw: unknown): string[] => (Array.isArray(raw) ? Array.from(new Set(raw.map((x) => normalizeTld(String(x))).filter(Boolean))).slice(0, 20) : []);

/** Набор страны: гео-приставки из базы + доп. зоны (из сохранённого набора или формы). */
export function defaultCountryPreset(code: string, tlds: unknown = []): CountryPreset {
  const t = geoTiers(code);
  return { tiers: [[...t[0]], [...t[1]], [...t[2]]], tlds: normalizeTlds(tlds) };
}

/** Набор страны с учётом сохранённых доп. зон. */
export function presetFor(code: string, saved: Record<string, CountryPreset>): CountryPreset {
  return defaultCountryPreset(code, saved[code]?.tlds ?? []);
}

/** Нормализация снимка набора (из сохранённого подбора): приставки a-z0-9 без дублей между уровнями, зоны без точки. */
export function normalizePreset(raw: unknown): CountryPreset {
  const r = (raw ?? {}) as Partial<CountryPreset>;
  const tiers = Array.isArray(r.tiers) ? r.tiers : [];
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => cleanSuffix(String(x))).filter(Boolean) : []);
  const t = dedupeTiers([list(tiers[0]), list(tiers[1]), list(tiers[2])], 3);
  return { tiers: [t[0]!.slice(0, 50), t[1]!.slice(0, 50), t[2]!.slice(0, 50)], tlds: normalizeTlds(r.tlds) };
}
