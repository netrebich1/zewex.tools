// ─────────────────────────────────────────────────────────────
// Раскладка фото внутри статьи так, чтобы рядом не стояли однотипные кадры
// (порт _shared/photoDiversity.ts, 1:1). Признаки берём из aiFacts / aiDescription / title
// кандидата; признак, заданный самой темой («red nails»), не учитывается.
// ─────────────────────────────────────────────────────────────

import { defaultProfile, type NicheProfile } from "@/lib/articles/photo/profile";

type Dim = string;

/** Оси и веса берутся из профиля ниши; ногтевые — значения по умолчанию (оригинал: :16-27). */
function axesOf(profile?: NicheProfile | null): { vocab: Record<Dim, Record<string, string[]>>; weights: Record<Dim, number> } {
  const prof = profile || defaultProfile("nails");
  const vocab: Record<Dim, Record<string, string[]>> = {};
  const weights: Record<Dim, number> = {};
  for (const axis of prof.diversity_axes || []) {
    if (!axis?.key || !axis.values) continue;
    vocab[axis.key] = axis.values;
    weights[axis.key] = Number(axis.weight) || 1;
  }
  if (!Object.keys(vocab).length) return { vocab: VOCAB, weights: DIM_WEIGHT };
  return { vocab, weights };
}

/** оригинал: photoDiversity.ts:29-72 */
const VOCAB: Record<Dim, Record<string, string[]>> = {
  color: {
    red: ["red", "cherry", "scarlet"],
    burgundy: ["burgundy", "wine", "maroon", "oxblood", "merlot", "deep red"],
    pink: ["pink", "fuchsia", "magenta", "rose"],
    nude: ["nude", "beige", "milky", "sheer", "taupe"],
    silver: ["silver", "chrome", "steel", "pearlescent", "pearl"],
    blue: ["blue", "navy", "cobalt", "denim", "teal"],
    black: ["black", "onyx"],
    white: ["white", "ivory"],
    green: ["green", "emerald", "sage", "olive", "mint"],
    purple: ["purple", "lilac", "lavender", "violet", "plum"],
    gold: ["gold", "bronze", "copper", "champagne"],
    brown: ["brown", "chocolate", "mocha", "espresso", "caramel"],
    grey: ["grey", "gray", "graphite", "charcoal"],
    orange: ["orange", "peach", "coral", "terracotta"],
    yellow: ["yellow", "butter", "mustard"],
  },
  shape: {
    almond: ["almond"],
    square: ["square", "squoval"],
    coffin: ["coffin", "ballerina"],
    stiletto: ["stiletto", "sharp point", "pointed"],
    oval: ["oval", "round"],
  },
  length: {
    short: ["short"],
    medium: ["medium length", "mid-length", "medium"],
    long: ["long", "extra long", "extra-long"],
  },
  finish: {
    glossy: ["glossy", "high gloss", "shiny", "high-shine"],
    matte: ["matte", "velvet"],
    chrome: ["chrome", "metallic", "mirror", "foil"],
    glitter: ["glitter", "sparkle", "shimmer", "sequin"],
    jelly: ["jelly", "sheer", "translucent"],
  },
  design: {
    french: ["french", "tip"],
    ombre: ["ombre", "gradient", "baby boomer"],
    art: ["nail art", "snowflake", "floral", "flower", "star", "heart", "marble", "dots", "polka", "stripe", "checker", "animal", "leopard", "abstract", "swirl", "aura"],
    solid: ["solid", "single colour", "single color", "one colour", "one color", "plain"],
  },
};

/** оригинал: photoDiversity.ts:74-80 */
const DIM_WEIGHT: Record<Dim, number> = {
  color: 3,
  design: 2.2,
  shape: 1.8,
  finish: 1.2,
  length: 1,
};

export interface DiversityInput {
  ai_facts?: unknown;
  ai_description?: unknown;
  ai_reason?: unknown;
  title?: unknown;
  facts?: unknown;
  description?: unknown;
  ai_score?: number | null;
}

function textOf(p: DiversityInput): string {
  const parts = [p.ai_facts ?? p.facts, p.ai_description ?? p.description, p.ai_reason, p.title]
    .map((v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v)));
  return parts.join(" ").toLowerCase();
}

/** Признаки кадра по каждому измерению (может быть пусто) (оригинал: :99-118). */
export function photoTraits(p: DiversityInput, profile?: NicheProfile | null): Record<Dim, string | null> {
  const { vocab } = axesOf(profile);
  const text = textOf(p);
  const out = {} as Record<Dim, string | null>;
  for (const dim of Object.keys(vocab)) {
    let found: string | null = null;
    let bestPos = Number.MAX_SAFE_INTEGER;
    for (const [tag, words] of Object.entries(vocab[dim])) {
      for (const w of words) {
        const pos = text.indexOf(w);
        if (pos >= 0 && pos < bestPos) {
          bestPos = pos;
          found = tag;
        }
      }
    }
    out[dim] = found;
  }
  return out;
}

/** Измерения, зафиксированные темой статьи — их не разнообразить (оригинал: :121-133). */
function dimsFixedByTopic(topic: string, vocab: Record<Dim, Record<string, string[]>>): Set<Dim> {
  const t = (topic || "").toLowerCase();
  const fixed = new Set<Dim>();
  for (const dim of Object.keys(vocab)) {
    for (const words of Object.values(vocab[dim])) {
      if (words.some((w) => t.includes(w))) {
        fixed.add(dim);
        break;
      }
    }
  }
  return fixed;
}

/**
 * Переставляет фото так, чтобы соседние (и через одно) отличались (оригинал: :139-192).
 * Штраф w за совпадение оси с предыдущим, 0.6·w — с пред-предыдущим, −0.02·ai_score за качество.
 */
export function orderPhotosForVariety<T extends DiversityInput>(photos: T[], topic = "", profile?: NicheProfile | null): T[] {
  if (photos.length < 3) return photos.slice();

  const { vocab, weights: baseWeights } = axesOf(profile);
  const fixed = dimsFixedByTopic(topic, vocab);
  const weights = {} as Record<Dim, number>;
  for (const dim of Object.keys(baseWeights)) {
    weights[dim] = fixed.has(dim) ? 0 : baseWeights[dim];
  }
  if (Object.values(weights).every((w) => w === 0)) {
    const ordered = Object.keys(baseWeights).sort((a, b) => baseWeights[b] - baseWeights[a]);
    for (const dim of ordered.slice(1)) weights[dim] = baseWeights[dim];
  }

  const items = photos.map((p, i) => ({ p, i, traits: photoTraits(p, profile), score: Number(p.ai_score) || 0 }));
  const pool = items.slice().sort((a, b) => b.score - a.score || a.i - b.i);

  const result: typeof items = [];
  result.push(pool.shift()!);

  while (pool.length) {
    const prev1 = result[result.length - 1];
    const prev2 = result[result.length - 2];
    let bestIdx = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let k = 0; k < pool.length; k++) {
      const cand = pool[k];
      let cost = 0;
      for (const dim of Object.keys(weights) as Dim[]) {
        const w = weights[dim];
        if (!w) continue;
        const t = cand.traits[dim];
        if (!t) continue;
        if (prev1 && prev1.traits[dim] === t) cost += w;
        if (prev2 && prev2.traits[dim] === t) cost += w * 0.6;
      }
      cost -= cand.score * 0.02;
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = k;
      }
    }
    result.push(pool.splice(bestIdx, 1)[0]);
  }

  return result.map((r) => r.p);
}
