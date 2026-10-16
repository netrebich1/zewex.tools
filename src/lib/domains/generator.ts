/**
 * Чистая логика генерации доменных имён из брендов, приставок и зон.
 * Правило: приставка ставится ТОЛЬКО после бренда (brand + suffix), никогда перед ним.
 * Порядок = приоритет: бренд → уровень 1 → (бренд через дефис) → уровень 2 → уровень 3; каждая метка × каждая зона.
 */
import type { CandidatePattern } from "./types";

export type DomainCandidateInput = {
  brand: string;
  label: string;
  tld: string;
  domain: string;
  suffix: string | null;
  tier: number;
  pattern: CandidatePattern;
};

export function sanitizeLabel(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTld(value: string): string {
  return value.toLowerCase().trim().replace(/^\./, "").replace(/[^a-z0-9.-]/g, "");
}

export function brandWords(brand: string): string[] {
  return sanitizeLabel(brand).split(/[\s-]+/).filter(Boolean);
}

/** Приставка: только a-z0-9, без пробелов и дефисов внутри. */
export function cleanSuffix(s: string): string {
  return sanitizeLabel(s).replace(/[\s-]+/g, "");
}

/** Убирает дубли между уровнями: приставка остаётся в первом уровне, где встретилась. */
export function dedupeTiers(tiers: string[][]): [string[], string[], string[]] {
  const used = new Set<string>();
  const out: string[][] = [];
  for (let i = 0; i < 3; i++) {
    const list: string[] = [];
    for (const raw of tiers[i] ?? []) {
      const s = cleanSuffix(raw);
      if (!s || used.has(s)) continue;
      used.add(s);
      list.push(s);
    }
    out.push(list);
  }
  return [out[0], out[1], out[2]];
}

/** Список через перенос строки / запятую / точку с запятой, без дублей и пустых. */
export function parseList(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean)));
}

/** Кандидаты одного бренда в порядке приоритета (дубли доменов и метки длиннее 63 символов отброшены). */
export function buildCandidatesForBrand(
  brand: string,
  suffixTiers: string[][],
  tlds: string[],
  options: { allowHyphen: boolean },
): DomainCandidateInput[] {
  const words = brandWords(brand);
  if (words.length === 0 || tlds.length === 0) return [];
  const tiers = dedupeTiers(suffixTiers);
  const joined = words.join("");
  const split = words.length > 1 ? words.join("-") : null;

  type Item = { label: string; suffix: string | null; tier: number; pattern: CandidatePattern };
  const labels: Item[] = [{ label: joined, suffix: null, tier: 0, pattern: "brand" }];

  const pushGroup = (list: string[], tier: number) => {
    for (const s of list) labels.push({ label: `${joined}${s}`, suffix: s, tier, pattern: "brand+suffix" });
    if (options.allowHyphen) {
      for (const s of list) labels.push({ label: `${joined}-${s}`, suffix: s, tier, pattern: "brand-suffix" });
      if (split) for (const s of list) labels.push({ label: `${split}-${s}`, suffix: s, tier, pattern: "brand-split+suffix" });
    }
  };

  tiers.forEach((tier, index) => {
    pushGroup(tier, index + 1);
    if (index === 0 && options.allowHyphen && split) labels.push({ label: split, suffix: null, tier: 0, pattern: "brand-split" });
  });

  const seen = new Set<string>();
  const out: DomainCandidateInput[] = [];
  const zones = Array.from(new Set(tlds.map(normalizeTld).filter(Boolean)));
  for (const item of labels) {
    const label = item.label.replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!label || label.length > 63) continue;
    for (const tld of zones) {
      const domain = `${label}.${tld}`;
      if (seen.has(domain)) continue;
      seen.add(domain);
      out.push({ brand: brand.trim(), label, tld, domain, suffix: item.suffix, tier: item.tier, pattern: item.pattern });
    }
  }
  return out;
}

/** Сколько кандидатов будет на бренд при таких настройках (для подсказки в форме). */
export function candidatesPerBrand(suffixTiers: string[][], tldCount: number, allowHyphen: boolean, multiWord: boolean): number {
  const tiers = dedupeTiers(suffixTiers);
  const n = tiers.reduce((a, t) => a + t.length, 0);
  const perSuffix = 1 + (allowHyphen ? 1 : 0) + (allowHyphen && multiWord ? 1 : 0);
  const labels = 1 + (allowHyphen && multiWord ? 1 : 0) + n * perSuffix;
  return labels * tldCount;
}
