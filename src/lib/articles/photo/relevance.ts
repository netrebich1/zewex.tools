// ─────────────────────────────────────────────────────────────
// Бесплатная проверка релевантности фото теме статьи (порт _shared/photoRelevance.ts, 1:1).
// Из ключевого слова достаём значимые слова (мотив, цвет, форму, длину, помещение) и требуем
// их подтверждения; взаимоисключающие варианты (маникюр ↔ педикюр, спальня ↔ кухня,
// короткие ↔ длинные волосы) отбраковываем жёстко. Словари — из профиля ниши.
// ─────────────────────────────────────────────────────────────

import { defaultProfile, type NicheProfile } from "@/lib/articles/photo/profile";
import { audienceRule } from "@/lib/articles/photo/audience";

/** оригинал: photoRelevance.ts:10-17 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "without", "of", "in", "on", "to",
  "best", "top", "new", "trendy", "trending", "cute", "pretty", "beautiful", "chic",
  "ideas", "idea", "design", "designs", "inspo", "inspiration", "looks", "look",
  "style", "styles", "photos", "photo", "pictures", "images", "gallery", "you",
  "should", "try", "this", "that", "your", "must", "have", "see", "guide",
  "2024", "2025", "2026", "2027", "2028", "2029", "2030",
]);

/**
 * Сезон в кадре виден только через одежду, поэтому для сезонных слов
 * чек-лист говорит о вещах, а не о «погоде на фото» (оригинал: :26-35).
 */
const SEASON_HINTS: Record<string, string[]> = {
  winter: ["coat", "wool knit", "boots", "tights", "layers", "scarf"],
  snow: ["coat", "boots", "heavy knit"],
  puffer: ["puffer", "padded coat"],
  summer: ["sleeveless", "sundress", "shorts", "sandals", "linen"],
  beach: ["swimwear", "beach cover-up"],
  fall: ["trench", "knit", "boots", "light layers"],
  autumn: ["trench", "knit", "boots", "light layers"],
  spring: ["light jacket", "trench", "midi dress"],
};

/** Слова про повод, аудиторию и посадку: их не «видно» отдельным элементом (оригинал: :38-44). */
const ABSTRACT_TOKENS = new Set([
  "work", "office", "business", "corporate", "professional", "interview", "casual",
  "formal", "smart", "wedding", "party", "date", "travel", "weekend", "church",
  "women", "woman", "womens", "ladies", "men", "mens", "girls", "over", "plus",
  "size", "petite", "curvy", "apple", "pear", "hourglass", "midsize", "modest",
  "comfortable", "elegant", "classy", "minimalist", "capsule", "wardrobe", "outfit",
]);

type ExclusiveDef = { scope: RegExp | null; variants: string[][] };

function exclusiveDefsOf(profile: NicheProfile): ExclusiveDef[] {
  return (profile.exclusive_terms || []).map((g) => ({
    scope: g.scope ? new RegExp(g.scope, "i") : null,
    variants: g.variants || [],
  }));
}

export interface TopicRelevance {
  /** значимые слова темы — хотя бы одно должно подтверждаться */
  tokens: string[];
  /** самые характерные слова (мотив/цвет/форма) — проверяются жёстче */
  strong: string[];
  /** слова, которых в фото быть не должно (другой вариант группы) */
  forbidden: string[];
  /** описание ограничений для ИИ-промта */
  aiConstraints: string;
  /** чек-лист требований к кадру для ИИ: каждое проверяется отдельно */
  requirements: string[];
}

function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s-]/gi, " ")
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Строим правила релевантности из ключевого слова статьи (оригинал: photoRelevance.ts:82-208).
 */
export function buildTopicRelevance(keyword: string, niche?: string | null, profile?: NicheProfile | null): TopicRelevance {
  const prof = profile || defaultProfile(niche);
  const EXCLUSIVE_DEFS = exclusiveDefsOf(prof);
  const ATTRIBUTE_DICTS = prof.required_visuals || [];
  const tokens = Array.from(new Set(tokenize(keyword)));
  const nicheTokens = new Set(tokenize(`${niche || ""} nails nail hair interior outfit outfits room tattoo makeup`));
  const audience = audienceRule(keyword, niche);
  const audienceWords = new Set(audience ? audience.tokens : []);
  const hasTopicToken = (t: string) => tokens.includes(t) && !audienceWords.has(t);
  const strong = tokens.filter((t) => !nicheTokens.has(t) && !audienceWords.has(t));

  const scopeText = `${keyword} ${niche || ""}`;
  const groups = EXCLUSIVE_DEFS.filter((d) => !d.scope || d.scope.test(scopeText)).map((d) => d.variants);

  const forbidden: string[] = [];
  const constraints: string[] = [];
  for (const group of groups) {
    const matchedIdx = group.findIndex((variant) => variant.some((v) => hasTopicToken(v)));
    if (matchedIdx === -1) continue;
    const mine = group[matchedIdx];
    for (let i = 0; i < group.length; i++) {
      if (i === matchedIdx) continue;
      forbidden.push(...group[i]);
    }
    constraints.push(`the photo MUST show ${mine.join(" / ")} and MUST NOT show ${group
      .filter((_, i) => i !== matchedIdx).flat().slice(0, 12).join(" / ")}`);
  }
  // ногти без слов про ноги — значит статья про руки: пальцы ног запрещены
  const nailish = /nail/i.test(keyword) || String(niche || "").includes("nail");
  const toeGroup = EXCLUSIVE_DEFS
    .flatMap((d) => d.variants)
    .find((variant) => variant.includes("toenails") || variant.includes("pedicure"));
  if (nailish && toeGroup && !forbidden.length) {
    const toe = toeGroup;
    const hasToe = toe.some((t) => hasTopicToken(t));
    if (!hasToe) {
      forbidden.push(...toe);
      constraints.push("the topic is FINGERNAILS: reject any photo showing toenails, toes or feet");
    }
  }

  if (strong.length) {
    constraints.push(
      `the photo MUST clearly show the defining element(s) of the topic: ${strong.join(", ")}. ` +
      `If the defining element is not visibly present in the nails/subject itself, reject the photo.`,
    );
  }

  // ── чек-лист требований к кадру: явные признаки темы + мотив ──
  const requirements: string[] = [];
  const usedTokens = new Set<string>();
  for (const dict of ATTRIBUTE_DICTS) {
    let mine: string | null = null;
    for (const [value, words] of Object.entries(dict.values)) {
      if (words.some((w) => hasTopicToken(w))) { mine = value; words.forEach((w) => usedTokens.add(w)); break; }
    }
    if (!mine) continue;
    const others = Object.keys(dict.values).filter((v) => v !== mine);
    requirements.push(`${dict.label} is ${mine} (reject ${others.slice(0, 4).join(" / ")})`);
  }
  for (const group of groups) {
    const idx = group.findIndex((variant) => variant.some((v) => hasTopicToken(v)));
    if (idx === -1) continue;
    group[idx].forEach((w) => usedTokens.add(w));
    const label = group[idx][0];
    if (requirements.some((r) => r.includes(`is ${label} `))) continue;
    if (SEASON_HINTS[label]) {
      const opposite = group.filter((_, i) => i !== idx).flat()
        .flatMap((w) => SEASON_HINTS[w] || [w]).slice(0, 8).join(" / ");
      requirements.push(
        `the clothing is plausible for ${label} (${SEASON_HINTS[label].join(" / ")} — ` +
        `an indoor shot with no weather visible is fine); reject only clear ${opposite} looks`,
      );
      continue;
    }
    requirements.push(
      `subject is ${label} (reject ${group.filter((_, i) => i !== idx).flat().slice(0, 5).join(" / ")})`,
    );
  }
  if (nailish && toeGroup && !toeGroup.some((v) => hasTopicToken(v))) {
    requirements.push("subject is fingernails on a hand (reject toenails / toes / feet)");
  }
  const motifs = strong.filter((t) => !usedTokens.has(t));
  for (const m of motifs) {
    if (SEASON_HINTS[m]) {
      requirements.push(
        `the clothing is plausible for ${m} (${SEASON_HINTS[m].join(" / ")}); weather does not have to be visible`,
      );
      continue;
    }
    if (ABSTRACT_TOKENS.has(m)) {
      requirements.push(`the styling plausibly suits "${m}" (reject only clearly unsuitable looks)`);
      continue;
    }
    requirements.push(`the "${m}" element is clearly visible in the subject itself`);
  }
  // Аудитория — жёсткое требование к человеку в кадре, первым пунктом чек-листа.
  if (audience) {
    requirements.unshift(audience.rule);
    constraints.unshift(audience.rule);
  }

  return {
    tokens,
    strong,
    forbidden: Array.from(new Set(forbidden)),
    aiConstraints: constraints.map((c) => `- ${c}`).join("\n"),
    requirements,
  };
}

export interface TextRelevanceResult {
  reject: boolean;
  reason: string | null;
  /** признаков темы в подписи нет — решает ИИ по самой картинке */
  weak?: boolean;
}

/** Проверка по тексту источника: заголовок + адрес страницы + адрес картинки (оригинал: :218-237; используется фильтром). */
export function checkTextRelevance(rel: TopicRelevance, parts: Array<string | null | undefined>): TextRelevanceResult {
  const haystack = parts.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9а-яё]+/gi, " ");
  const words = new Set(haystack.split(/\s+/).filter(Boolean));
  const has = (t: string) => words.has(t) || (t.length >= 5 && haystack.includes(t));

  for (const bad of rel.forbidden) {
    if (has(bad)) return { reject: true, reason: `не та тема: «${bad}» вместо темы статьи` };
  }
  if (rel.strong.length) {
    const hit = rel.strong.some(has);
    if (!hit && haystack.trim().length > 12) {
      return { reject: false, reason: null, weak: true };
    }
  }
  return { reject: false, reason: null };
}
