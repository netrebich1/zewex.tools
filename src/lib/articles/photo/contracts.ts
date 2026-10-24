/**
 * Контракты темы — единые «замки» релевантности для фото-цепочки и текстов.
 * Порт оригинала _shared/topicContract.ts + _shared/fashionContract.ts + _shared/interiorContract.ts
 (имена экспортов сохранены). Бесплатная релевантность по тексту (photoRelevance.ts) — в соседнем ./relevance.ts.
 */
import type { AttributeDict, NicheProfile } from "./profile";
import { ageRule, audienceRule, genderRule, isChildIntent } from "./audience";

// ═══════════════════════ topicContract.ts ═══════════════════════

export interface ContractRule {
  /** название признака (length, cut family, technique…) */
  label: string;
  /** выбранное значение темы */
  value: string;
  /** слова, которые подтверждают соответствие теме */
  allow: string[];
  /** слова, при которых кадр/идея/промт считается не по теме */
  forbid: string[];
  /** обязателен ли хотя бы один allow-слово в тексте промта */
  required: boolean;
}

export interface TopicContract {
  niche: string;
  rules: ContractRule[];
  /** ведущий признак темы (обычно длина или семейство) */
  primary: ContractRule | null;
  lengthBucket: string;
  family: string;
  colorTokens: string[];
  /** блок «ALLOWED / FORBIDDEN» для промтов */
  promptBlock: string;
  /** готовые правила авто-отказа для приёмки фото */
  reviewRules: string[];
  empty: boolean;
}

const SCALE_LABELS = ["length", "nail length", "size", "hair length"];

/** Сезон/погода: судится по одежде, а не как жёсткий замок на кадре. */
const SEASON_WORDS = new Set(["winter", "summer", "spring", "fall", "autumn", "snow", "beach", "puffer"]);

function isSeasonVariant(words: string[]): boolean {
  return words.some((w) => SEASON_WORDS.has(String(w).toLowerCase()));
}

function isScale(label: string) {
  return SCALE_LABELS.includes(label.toLowerCase());
}

/** Признаки, где запрещать соседей опасно (акцентные цвета — норма). */
function softOnly(label: string) {
  const l = label.toLowerCase();
  return l === "colour" || l === "color" || l === "palette";
}

function esc(w: string) {
  return w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function wordsRegex(words: string[]): RegExp | null {
  const list = words.filter((w) => w && w.trim().length > 2).map(esc);
  if (!list.length) return null;
  return new RegExp(`\\b(${list.join("|")})\\b`, "i");
}

function hits(text: string, words: string[]): boolean {
  const re = wordsRegex(words);
  return re ? re.test(text) : false;
}

/** Семейства стрижек — enforce только когда тема прямо называет одно из них. */
const HAIR_FAMILIES: Record<string, string[]> = {
  pixie: ["pixie", "pixie cut"],
  bob: ["bob"],
  lob: ["lob", "long bob"],
  shag: ["shag", "shaggy"],
  mullet: ["mullet"],
  "wolf cut": ["wolf cut"],
  buzz: ["buzz cut", "buzzcut", "buzzed"],
  "butterfly cut": ["butterfly cut", "butterfly haircut"],
};

/** Общие слова («long», «medium») в запретах заменяются однозначными формулировками предмета. */
const FORBID_PHRASES: Record<string, string[]> = {
  long: ["long hair", "long haircut", "long nails", "long layers", "past the shoulders", "below the shoulders", "waist-length", "waist length"],
  medium: ["medium length", "medium-length", "medium nails"],
  short: ["short hair", "short haircut", "short nails", "cropped short"],
  mid: ["mid-length", "midlength"],
  extra: [],
  thick: [],
  fine: [],
  none: [],
};

function refineForbid(word: string): string[] {
  const key = word.toLowerCase().trim();
  if (key in FORBID_PHRASES) return FORBID_PHRASES[key];
  return [word];
}

function attrHaystack(attrs: Record<string, unknown> | null | undefined): string {
  if (!attrs) return "";
  return Object.values(attrs)
    .map((v) => (typeof v === "string" ? v : ""))
    .filter((v) => v && v.toLowerCase() !== "none")
    .join(" ");
}

/** Порядок значений шкалы: ключи JSON приходят в произвольном порядке. */
const SCALE_ORDER = ["micro", "buzz", "very short", "short", "shorter", "medium", "mid", "mid-length", "long", "extra long", "extra-long", "xl"];

function orderScaleKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ia = SCALE_ORDER.indexOf(a.toLowerCase());
    const ib = SCALE_ORDER.indexOf(b.toLowerCase());
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

function ruleFromDict(dict: AttributeDict, haystack: string): ContractRule | null {
  const keys = Object.keys(dict.values || {});
  if (keys.length < 2) return null;
  const matched = keys.filter((k) => hits(haystack, dict.values[k]));
  if (matched.length !== 1) return null; // неоднозначно — не запираем
  const picked = matched[0];
  const allow = [...(dict.values[picked] || [])];
  const allowedKeys = new Set<string>([picked]);

  if (isScale(dict.label)) {
    const ordered = orderScaleKeys(keys);
    const idx = ordered.indexOf(picked);
    // Крайние значения шкалы допускают соседа в сторону крайности («short» → «very short», «long» → «extra long»).
    // Аудит 02, п.7.11: в оригинале (idx <= 1 || idx >= len-2) «medium» в шкале из 3–4 значений разрешал и short, и long,
    // и замок на длину исчезал. Теперь сосед разрешается только в своей половине шкалы и никогда для medium/mid.
    const mid = (ordered.length - 1) / 2;
    const middling = /^(medium|mid)/i.test(picked);
    if (!middling && idx <= 1 && idx < mid) ordered.slice(0, idx).forEach((k) => allowedKeys.add(k));
    if (!middling && idx >= ordered.length - 2 && idx > mid) ordered.slice(idx + 1).forEach((k) => allowedKeys.add(k));
  }

  for (const k of allowedKeys) if (k !== picked) allow.push(...(dict.values[k] || []));

  const forbid: string[] = [];
  if (!softOnly(dict.label)) {
    for (const k of keys) {
      if (allowedKeys.has(k)) continue;
      for (const w of dict.values[k] || []) {
        if (allow.some((a) => a.toLowerCase() === w.toLowerCase())) continue;
        forbid.push(...refineForbid(w));
      }
    }
  }

  return { label: dict.label, value: picked, allow, forbid, required: !softOnly(dict.label) };
}

/** Основная сборка контракта. Никогда не бросает (оригинал: topicContract.ts:185-333). */
export function buildTopicContract(profile: NicheProfile, attrs: Record<string, unknown> | null | undefined, topicText?: string | null): TopicContract {
  const rawTopic = String(topicText || "").toLowerCase();
  // Слова аудитории («black women») нельзя читать как цвет/признак предмета:
  // для замков по признакам они вырезаются, для правила аудитории — остаются.
  const audienceOfTopic = audienceRule(rawTopic, profile.niche_code);
  const topic = audienceOfTopic
    ? rawTopic.replace(new RegExp(`\\b(${audienceOfTopic.tokens.join("|")})\\b`, "gi"), " ").replace(/\s+/g, " ").trim()
    : rawTopic;
  const haystack = `${topic} ${attrHaystack(attrs)}`.toLowerCase();
  const rules: ContractRule[] = [];

  // 1) Семейство (для волос) — только по явному упоминанию в теме.
  if (profile.niche_code === "hair") {
    const named = Object.keys(HAIR_FAMILIES).filter((f) => hits(topic, HAIR_FAMILIES[f]));
    if (named.length === 1) {
      const picked = named[0];
      const forbid: string[] = [];
      for (const f of Object.keys(HAIR_FAMILIES)) {
        if (f === picked) continue;
        forbid.push(...HAIR_FAMILIES[f]);
      }
      rules.push({ label: "cut family", value: picked, allow: HAIR_FAMILIES[picked], forbid: forbid.filter((w) => !HAIR_FAMILIES[picked].includes(w)), required: true });
    }
  }

  // 2) Признаки из словарей профиля (длина, текстура, техника, цвет…).
  for (const dict of profile.required_visuals || []) {
    const rule = ruleFromDict(dict, haystack);
    if (rule) rules.push(rule);
  }

  // 3) Взаимоисключающие группы профиля (например «волосы» vs «ногти»).
  for (const group of profile.exclusive_terms || []) {
    if (group.scope) {
      try {
        if (!new RegExp(group.scope, "i").test(haystack)) continue;
      } catch {
        /* некорректный scope — пропускаем */
      }
    }
    const variants = group.variants || [];
    const present = variants.filter((v) => hits(haystack, v));
    if (present.length !== 1) continue;
    const forbid = variants
      .filter((v) => v !== present[0])
      .flatMap((v) => v)
      .filter((w) => !present[0].some((p) => p.toLowerCase() === w.toLowerCase()))
      .flatMap((w) => refineForbid(w));
    if (!forbid.length) continue;
    const duplicate = rules.some((r) => r.allow.some((a) => present[0].some((p) => p.toLowerCase() === a.toLowerCase())));
    if (duplicate) continue;
    // Сезон нельзя требовать буквально: в помещении погоды не видно — подсказка в промте, не повод для авто-отказа.
    rules.push({
      label: isSeasonVariant(present[0]) ? "season (soft)" : "subject",
      value: present[0][0],
      allow: present[0],
      forbid: isSeasonVariant(present[0]) ? [] : forbid,
      required: false,
    });
  }

  // дедупликация по label (первое правило важнее)
  const seen = new Set<string>();
  const unique = rules.filter((r) => (seen.has(r.label) ? false : (seen.add(r.label), true)));

  const lengthRule = unique.find((r) => isScale(r.label));
  const familyRule = unique.find((r) => r.label === "cut family");
  const colorRule = unique.find((r) => softOnly(r.label));
  const primary = familyRule || lengthRule || unique[0] || null;

  const promptLines = unique.map((r) => {
    if (r.label === "season (soft)") {
      return `- season: the clothing should read as "${r.value}" through garments and layers; weather does not have to be visible and an indoor shot is fine. Reject only looks that clearly belong to the opposite season.`;
    }
    const parts = [`- ${r.label}: MUST be "${r.value}" (ok: ${r.allow.slice(0, 8).join(", ")})`];
    if (r.forbid.length) parts.push(`  FORBIDDEN: ${r.forbid.slice(0, 14).join(", ")}`);
    return parts.join("\n");
  });

  // Пол определяется темой: в ключе нет слова про мужчин — мужчин в кадре нет (решение владельца, аудит 02 п.7.12).
  const gender = genderRule(rawTopic, profile.niche_code);
  const genderLine = gender.allow === "any" ? "" : `- ${gender.rule}`;
  const ageText = /interior|decor|home|garden/i.test(String(profile.niche_code || "")) ? "" : ageRule(rawTopic, profile.niche_code);
  const ageLine = ageText ? `- ${ageText}` : "";
  const audience = audienceOfTopic;
  const audienceLine = audience ? `- ${audience.rule}` : "";

  const promptBlock = unique.length || genderLine || audienceLine || ageLine
    ? `## TOPIC RELEVANCE CONTRACT (hard limits — the article topic defines them)
Every idea, prompt and photo MUST satisfy ALL of these. A single forbidden term makes the item off-topic and unusable:
${[...promptLines, genderLine, ageLine, audienceLine].filter(Boolean).join("\n")}
Never substitute a neighbouring variant "for variety" — variety comes from other attributes (colour, texture, styling, angle, mood).`
    : "";

  const reviewRules = unique
    .filter((r) => r.forbid.length && r.label !== "season (soft)")
    .map((r) => {
      const tag = r.label === "cut family" ? "wrong_haircut" : isScale(r.label) ? "wrong_length" : "off_topic";
      return `If the photo shows ${r.label} that is NOT "${r.value}" (for example: ${r.forbid.slice(0, 8).join(", ")}) → REJECT with reject_reason "ai_artifacts" and add "${tag}" to issues. The article topic requires ${r.label} = "${r.value}".`;
    });
  if (gender.allow !== "any") {
    reviewRules.push(`${gender.rule} A photo that breaks this rule gets verdict "reject" with reject_reason "off_topic" and "wrong_gender" in issues.`);
  }
  if (audience) {
    reviewRules.push(`${audience.rule} A photo that breaks this rule gets verdict "reject" with reject_reason "off_topic" and "wrong_audience" in issues. Never approve it "because the outfit matches the topic".`);
  }

  return {
    niche: profile.niche_code,
    rules: unique,
    primary,
    lengthBucket: lengthRule?.value || "",
    family: familyRule?.value || "",
    colorTokens: colorRule?.allow || [],
    promptBlock,
    reviewRules,
    empty: unique.length === 0,
  };
}

/** Первое нарушение контракта в тексте, иначе null. */
export function contractViolation(contract: TopicContract, text: string): string | null {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return null;
  for (const rule of contract.rules) {
    const re = wordsRegex(rule.forbid);
    if (!re) continue;
    const m = t.match(re);
    if (m) return `«${m[0]}» противоречит теме: ${rule.label} должен быть «${rule.value}»`;
  }
  return null;
}

/** Признаки, которых не хватает в тексте (для промтов фото). */
export function contractMissing(contract: TopicContract, text: string): string[] {
  const t = String(text || "").toLowerCase();
  const out: string[] = [];
  for (const rule of contract.rules) {
    if (!rule.required) continue;
    if (!hits(t, rule.allow)) out.push(`${rule.label} = "${rule.value}"`);
  }
  return out;
}

/** Нишевые «замки» темы (оригинал: topicContract.ts:365-387) — только для волос. */
export function contractLocks(profile: NicheProfile, attrs: Record<string, unknown> | null | undefined, topicText?: string | null): Record<string, string> {
  const contract = buildTopicContract(profile, attrs, topicText);
  const a = (attrs || {}) as Record<string, unknown>;
  const clean = (v: unknown) => {
    const s = String(v ?? "").trim();
    return s && s.toLowerCase() !== "none" ? s : "";
  };
  if (profile.niche_code !== "hair") return {};
  const cut = clean(a.keyword_hair_cut);
  const lengthAttr = clean(a.keyword_hair_length);
  return {
    keyword_hero_item: contract.family || cut || "unknown",
    keyword_length_lock: contract.lengthBucket || lengthAttr || "none",
    keyword_color_lock: clean(a.keyword_hair_color) || "none",
    keyword_technique: clean(a.keyword_hair_color_technique) || "none",
    keyword_texture: clean(a.keyword_hair_texture) || "none",
    cut_family: contract.family || "",
  };
}

// ═══════════════════════ fashionContract.ts ═══════════════════════

export type OutfitMode = "piece" | "look";

export interface FashionContract {
  outfit_mode: OutfitMode;
  hero_piece: string;
  audience: string;
  occasion: string;
  season: string;
  style: string;
  silhouette: string;
  palette: string;
  body_context: string;
  source_keyword_en: string;
  hard_requirements: string[];
}

/** Предметы одежды: первое совпадение в ключе = hero piece (fashionContract.ts:18-24). */
export const FASHION_PIECES: Array<[string, RegExp]> = [
  ["jeans", /\b(?:jeans|denim pants?)\b/i], ["shoes", /\b(?:shoes?|heels?|pumps?|loafers?|sneakers?|trainers?|boots?|sandals?|flats?)\b/i],
  ["dress", /\b(?:dress(?:es)?|gown|sundress)\b/i], ["skirt", /\bskirts?\b/i], ["trousers", /\b(?:trousers|pants|slacks)\b/i],
  ["shorts", /\bshorts\b/i], ["blazer", /\bblazers?\b/i], ["suit", /\bsuits?\b/i], ["coat", /\b(?:coats?|trenches|trench coat)\b/i],
  ["jacket", /\bjackets?\b/i], ["top", /\b(?:tops?|shirts?|blouses?|tees?|t-shirts?)\b/i], ["sweater", /\b(?:sweaters?|cardigans?|knitwear)\b/i],
  ["jumpsuit", /\b(?:jumpsuits?|rompers?)\b/i], ["bag", /\b(?:bags?|handbags?|totes?|clutches?)\b/i], ["accessory", /\b(?:belts?|scarves?|jewellery|jewelry)\b/i],
];

const clean = (value: unknown): string => {
  const text = String(value ?? "").trim();
  return !text || text.toLowerCase() === "none" ? "" : text;
};

export function buildFashionContract(keyword: string, attrs?: Record<string, unknown> | null): FashionContract {
  const source = clean(keyword).replace(/\s+/g, " ");
  const a = attrs || {};
  const attrHero = clean(a.keyword_hero_piece);
  const attrMode = clean(a.outfit_mode).toLowerCase();
  const matched = FASHION_PIECES.find(([, pattern]) => pattern.test(source));
  const hero = attrHero || matched?.[0] || "";
  const mode: OutfitMode = attrMode === "piece" || attrMode === "look" ? attrMode : hero ? "piece" : "look";
  const explicitChildAudience = isChildIntent(source);
  const audience = clean(a.keyword_age) || clean(a.keyword_body_type) || (explicitChildAudience ? "children" : "adult women");
  const occasion = clean(a.keyword_occasion);
  const season = clean(a.keyword_season);
  const style = clean(a.keyword_style) || clean(a.keyword_outfit_type);
  const silhouette = clean(a.keyword_silhouette);
  const palette = clean(a.keyword_palette);
  const bodyContext = clean(a.keyword_body_type);
  const requirements = mode === "piece"
    ? [`The ${hero} must be clearly visible and central in every photo and section.`]
    : ["The complete outfit must be readable, including its main garments and styling relationship."];
  if (audience) requirements.push(`The visible styling must suit the stated audience: ${audience}.`);
  if (!explicitChildAudience) requirements.push("Every person and garment must be for adults. Baby, toddler and child models or children's garments are OFF-TOPIC.");
  if (occasion) requirements.push(`The complete styling must fit the stated occasion: ${occasion}.`);
  const SPECIAL = /\b(wedding|bridal|bride|prom|homecoming|gala|evening gown|ball gown|quincea|maternity|bump|costume|halloween)\b/i;
  if (!SPECIAL.test(`${source} ${occasion}`)) {
    requirements.push("No special-occasion looks: wedding or bridal gowns, prom, gala or ball gowns, maternity and costumes are OFF-TOPIC for this everyday topic.");
  }
  requirements.push("A real person must wear the look in a styled photo; e-commerce product listings (plain studio backdrop, size charts, mannequins, flat lays, marketplace cards) are off-topic.");
  if (season) {
    requirements.push(`The garments and layers should read as ${season}; weather, snow or outdoor setting do not have to be visible and indoor frames are fine. Only a look that clearly belongs to the opposite season is off-topic.`);
  }
  if (style) requirements.push(`The visible styling must fit the stated style: ${style}.`);
  if (silhouette) requirements.push(`The required silhouette must be visible: ${silhouette}.`);
  if (palette) requirements.push(`The required palette must be visible: ${palette}.`);
  return { outfit_mode: mode, hero_piece: hero, audience, occasion, season, style, silhouette, palette, body_context: bodyContext, source_keyword_en: source, hard_requirements: requirements };
}

export function fashionContractPrompt(contract: FashionContract): string {
  return `OUTFIT INTENT CONTRACT (derived from the original English Focus Keyword):\n` +
    `mode: ${contract.outfit_mode}\nhero_piece: ${contract.hero_piece || "none"}\n` +
    `audience: ${contract.audience || "none"}\noccasion: ${contract.occasion || "none"}\n` +
    `season: ${contract.season || "none"}\nstyle: ${contract.style || "none"}\n` +
    `silhouette: ${contract.silhouette || "none"}\npalette: ${contract.palette || "none"}\n` +
    contract.hard_requirements.map((r) => `- ${r}`).join("\n");
}

// ═══════════════════════ interiorContract.ts ═══════════════════════

export type DecorMode = "element" | "room" | "style";

export interface InteriorContract {
  decor_mode: DecorMode;
  hero_element: string;
  room: string;
  setting: "indoor" | "outdoor" | "any";
  style: string;
  palette: string;
  materials: string;
  season: string;
  occasion: string;
  size: string;
  budget: string;
  source_keyword_en: string;
  hard_requirements: string[];
}

/** Вещи и проекты: если ключ называет одну из них — режим element (interiorContract.ts:32-69). */
const ELEMENTS: Array<[string, RegExp]> = [
  ["gallery wall", /\bgallery wall\b/i],
  ["accent wall", /\baccent wall\b|\bfeature wall\b/i],
  ["wall panelling", /\b(?:panelling|paneling|wainscoting|shiplap|board and batten)\b/i],
  ["wallpaper", /\bwallpapers?\b/i],
  ["backsplash", /\bbacksplash(?:es)?\b/i],
  ["countertop", /\b(?:countertops?|worktops?)\b/i],
  ["kitchen island", /\bkitchen islands?\b/i],
  ["open shelving", /\b(?:open shelving|floating shelves|shelves|shelving|bookshelf|bookcase)\b/i],
  ["headboard", /\bheadboards?\b/i],
  ["bedding", /\b(?:bedding|duvet|comforter|bed linen)\b/i],
  ["curtains", /\b(?:curtains?|drapes?|window treatments?|blinds?|shades?)\b/i],
  ["rug", /\b(?:rugs?|runners?|carpets?)\b/i],
  ["lighting", /\b(?:lighting|pendant lights?|chandeliers?|sconces?|lamps?|string lights?|fairy lights?)\b/i],
  ["mirror", /\bmirrors?\b/i],
  ["coffee table", /\bcoffee tables?\b/i],
  ["console table", /\b(?:console tables?|entry tables?)\b/i],
  ["sofa", /\b(?:sofas?|couches?|sectionals?)\b/i],
  ["dining table", /\bdining tables?\b/i],
  ["mantel", /\b(?:mantels?|mantle|fireplaces?)\b/i],
  ["wall art", /\b(?:wall art|prints?|artwork|framed art|posters?)\b/i],
  ["plants", /\b(?:plants?|planters?|greenery|indoor trees?)\b/i],
  ["storage", /\b(?:storage|cabinets?|wardrobes?|closets?|pantry|baskets?)\b/i],
  ["paint colour", /\b(?:paint colou?rs?|wall colou?rs?|paint ideas?)\b/i],
  ["tile", /\btiles?\b|\bzellige\b|\bsubway tile\b/i],
  ["fire pit", /\bfire pits?\b|\bfireplace pit\b/i],
  ["pergola", /\b(?:pergolas?|gazebos?|awnings?|canopy)\b/i],
  ["deck", /\b(?:decks?|decking)\b/i],
  ["outdoor furniture", /\b(?:outdoor furniture|patio furniture|garden furniture|outdoor sofa|bistro set)\b/i],
  ["raised beds", /\b(?:raised beds?|garden beds?|vegetable beds?)\b/i],
  ["fence", /\b(?:fences?|fencing|privacy screens?|trellis(?:es)?)\b/i],
  ["pathway", /\b(?:pathways?|walkways?|stepping stones?|pavers?|gravel paths?)\b/i],
  ["water feature", /\b(?:water features?|fountains?|ponds?)\b/i],
  ["hot tub", /\b(?:hot tubs?|plunge pools?|pools?)\b/i],
  ["wreath", /\bwreaths?\b/i],
  ["table setting", /\b(?:table settings?|tablescapes?|centerpieces?|centrepieces?)\b/i],
  ["christmas tree", /\bchristmas trees?\b/i],
];

/** Комнаты и уличные зоны: если вещь не названа — режим room (interiorContract.ts:72-93). */
const ROOMS: Array<[string, RegExp, "indoor" | "outdoor"]> = [
  ["kitchen", /\bkitchens?\b|\bkitchenettes?\b/i, "indoor"],
  ["bathroom", /\b(?:bathrooms?|powder rooms?|ensuites?)\b/i, "indoor"],
  ["bedroom", /\bbedrooms?\b/i, "indoor"],
  ["living room", /\b(?:living rooms?|lounges?|family rooms?|sitting rooms?)\b/i, "indoor"],
  ["dining room", /\bdining rooms?\b|\bbreakfast nooks?\b/i, "indoor"],
  ["nursery", /\b(?:nurser(?:y|ies)|kids? rooms?|playrooms?|teen rooms?)\b/i, "indoor"],
  ["home office", /\b(?:home offices?|studies|studys|craft rooms?|workspaces?)\b/i, "indoor"],
  ["hallway", /\b(?:hallways?|entrywa?ys?|foyers?|mudrooms?|staircases?)\b/i, "indoor"],
  ["laundry", /\b(?:laundry rooms?|utility rooms?|laundries)\b/i, "indoor"],
  ["closet", /\b(?:closets?|walk-in closets?|dressing rooms?)\b/i, "indoor"],
  ["garage", /\b(?:garages?|basements?|attics?|lofts?)\b/i, "indoor"],
  ["studio apartment", /\b(?:studio apartments?|small apartments?|apartments?|rentals?|dorms?)\b/i, "indoor"],
  ["balcony", /\b(?:balcon(?:y|ies)|terraces?)\b/i, "outdoor"],
  ["patio", /\bpatios?\b/i, "outdoor"],
  ["porch", /\b(?:porch(?:es)?|front porch(?:es)?|verandas?)\b/i, "outdoor"],
  ["backyard", /\b(?:backyards?|back gardens?|yards?)\b/i, "outdoor"],
  ["garden", /\b(?:gardens?|flower beds?|landscap(?:e|ing))\b/i, "outdoor"],
  ["front yard", /\b(?:front yards?|curb appeal|driveways?)\b/i, "outdoor"],
  ["poolside", /\b(?:poolsides?|pool areas?)\b/i, "outdoor"],
  ["outdoor kitchen", /\b(?:outdoor kitchens?|grill stations?|bbq areas?)\b/i, "outdoor"],
];

const OUTDOOR_HINT = /\b(?:outdoor|outdoors|exterior|patio|porch|backyard|yard|garden|balcony|deck|terrace|curb appeal|landscaping|al fresco|alfresco|poolside)\b/i;
const INDOOR_HINT = /\b(?:indoor|interior|room|apartment|living room|bedroom|kitchen|bathroom|hallway|nursery|office)\b/i;

const STYLES: Array<[string, RegExp]> = [
  ["modern", /\b(?:modern|contemporary)\b/i], ["boho", /\b(?:boho|bohemian)\b/i],
  ["farmhouse", /\b(?:farmhouse|rustic|cottagecore|cottage)\b/i], ["scandi", /\b(?:scandinavian|scandi|nordic)\b/i],
  ["minimalist", /\bminimal(?:ist)?\b/i], ["japandi", /\bjapandi\b/i], ["mid-century", /\bmid[- ]century\b/i],
  ["coastal", /\b(?:coastal|nautical|beachy|hamptons)\b/i], ["industrial", /\bindustrial\b/i],
  ["traditional", /\b(?:traditional|classic|grandmillennial)\b/i], ["maximalist", /\bmaximalist\b/i],
  ["art deco", /\bart deco\b/i], ["mediterranean", /\b(?:mediterranean|tuscan|spanish)\b/i],
  ["eclectic", /\beclectic\b/i], ["luxury", /\b(?:luxury|glam|elegant)\b/i],
];

const SEASONS: Array<[string, RegExp]> = [
  ["winter", /\b(?:winter|christmas|holiday|snowy)\b/i],
  ["fall", /\b(?:fall|autumn|thanksgiving|halloween)\b/i],
  ["spring", /\b(?:spring|easter)\b/i],
  ["summer", /\bsummer\b/i],
];

/** Цвета и палитры прямо из ключа — жёсткий замок, даже если атрибуты пусты. */
const COLOURS: Array<[string, RegExp]> = [
  ["sage green", /\bsage(?: green)?\b/i], ["olive green", /\bolive\b/i], ["emerald green", /\bemerald\b/i],
  ["forest green", /\bforest green\b/i], ["mint green", /\bmint\b/i], ["green", /\bgreen\b/i],
  ["navy blue", /\bnavy\b/i], ["teal", /\bteal\b|\bturquoise\b/i], ["light blue", /\b(?:light|baby|sky|powder) blue\b/i],
  ["blue", /\bblue\b/i], ["terracotta", /\bterracott?a\b/i], ["rust", /\brust\b/i], ["burgundy", /\b(?:burgundy|maroon|wine)\b/i],
  ["red", /\bred\b/i], ["blush pink", /\b(?:blush|dusty pink)\b/i], ["pink", /\bpink\b/i], ["lavender", /\b(?:lavender|lilac)\b/i],
  ["purple", /\bpurple\b/i], ["mustard yellow", /\bmustard\b/i], ["yellow", /\byellow\b/i], ["orange", /\borange\b/i],
  ["warm neutral", /\bwarm neutrals?\b/i], ["neutral", /\bneutrals?\b/i], ["beige", /\b(?:beige|greige|taupe|sand)\b/i],
  ["cream", /\b(?:cream|ivory|off[- ]white)\b/i], ["white", /\bwhite\b/i], ["grey", /\b(?:gray|grey)\b/i],
  ["black", /\bblack\b/i], ["brown", /\b(?:brown|chocolate|cognac)\b/i], ["earth tones", /\bearth tones?\b/i],
  ["jewel tones", /\bjewel tones?\b/i], ["pastel", /\bpastels?\b/i], ["monochrome", /\bmonochrom(?:e|atic)\b/i],
];

const MATERIALS: Array<[string, RegExp]> = [
  ["wood", /\b(?:wood|wooden|oak|walnut|teak|pine|cedar)\b/i], ["rattan", /\b(?:rattan|wicker|cane)\b/i],
  ["marble", /\bmarble\b/i], ["brass", /\b(?:brass|gold(?:en)? metal)\b/i], ["stone", /\b(?:stone|slate|travertine|limestone)\b/i],
  ["concrete", /\bconcrete\b/i], ["brick", /\bbrick\b/i], ["tile", /\b(?:tile|tiled|zellige|terrazzo)\b/i],
  ["linen", /\blinen\b/i], ["velvet", /\bvelvet\b/i], ["bouclé", /\bboucle\b/i], ["jute", /\b(?:jute|sisal)\b/i],
  ["glass", /\bglass\b/i], ["metal", /\b(?:metal|steel|iron)\b/i],
];

const SIZES: Array<[string, RegExp]> = [
  ["tiny", /\btiny\b/i], ["small", /\b(?:small|compact|petite)\b/i], ["narrow", /\b(?:narrow|skinny|long and narrow)\b/i],
  ["open-plan", /\b(?:open[- ]plan|open concept)\b/i], ["large", /\b(?:large|big|spacious)\b/i],
];

export function buildInteriorContract(keyword: string, attrs?: Record<string, unknown> | null): InteriorContract {
  const source = clean(keyword).replace(/\s+/g, " ");
  const a = attrs || {};
  const hay = source;

  const attrHero = clean(a.keyword_hero_element) || clean(a.keyword_zone);
  const matchedElement = ELEMENTS.find(([, re]) => re.test(hay));
  const matchedRoom = ROOMS.find(([, re]) => re.test(hay));
  const attrRoom = clean(a.keyword_room);
  const attrStyle = clean(a.keyword_style);
  const attrMode = clean(a.decor_mode).toLowerCase();

  const hero = attrHero || matchedElement?.[0] || "";
  const room = matchedRoom?.[0] || attrRoom || "";
  const style = STYLES.find(([, re]) => re.test(hay))?.[0] || attrStyle;
  const season = SEASONS.find(([, re]) => re.test(hay))?.[0] || clean(a.keyword_season);

  const mode: DecorMode = ["element", "room", "style"].includes(attrMode) ? (attrMode as DecorMode) : hero ? "element" : room ? "room" : "style";

  const settingAttr = clean(a.keyword_setting_type).toLowerCase();
  const setting: InteriorContract["setting"] =
    settingAttr === "indoor" || settingAttr === "outdoor"
      ? settingAttr
      : matchedRoom?.[2] === "outdoor" || (OUTDOOR_HINT.test(hay) && !INDOOR_HINT.test(hay))
        ? "outdoor"
        : matchedRoom?.[2] === "indoor" || INDOOR_HINT.test(hay)
          ? "indoor"
          : "any";

  const palette = clean(a.keyword_palette) || COLOURS.find(([, re]) => re.test(hay))?.[0] || "";
  const materials = clean(a.keyword_materials) || MATERIALS.find(([, re]) => re.test(hay))?.[0] || "";
  const occasion = clean(a.keyword_occasion);
  const size = clean(a.keyword_size) || SIZES.find(([, re]) => re.test(hay))?.[0] || "";
  const budget = clean(a.keyword_budget);

  const requirements: string[] = [];
  if (mode === "element") {
    requirements.push(`The ${hero} is the hero of the article: it must be clearly visible and the main subject in every photo, and every section must be one version of it. The space around it stays simple and supporting.`);
  } else if (mode === "room") {
    requirements.push(`Every photo must show the stated space (${room}) and every section must describe that space. A different room or zone is off-topic, even if the styling is beautiful.`);
  } else {
    requirements.push(`Every photo and section must read as the stated style/mood of the topic; a space that clearly belongs to another style is off-topic.`);
  }
  if (room && mode !== "room") requirements.push(`The stated space must stay ${room} — never swap it for another room or zone.`);
  if (setting === "outdoor") {
    requirements.push(`This topic is OUTDOOR (patio, porch, balcony, deck, yard or garden). Every photo must be shot outside. An indoor living room or bedroom is off-topic, even when the styling matches.`);
  } else if (setting === "indoor") {
    requirements.push(`This topic is INDOOR. A patio, yard, garden or balcony shot is off-topic.`);
  }
  if (style) requirements.push(`The visible style must fit: ${style}.`);
  if (palette) requirements.push(`The required palette must be visible: ${palette}.`);
  if (materials) requirements.push(`The stated materials must be visible: ${materials}.`);
  if (size) requirements.push(`The space must read as ${size} where the frame shows enough of it.`);
  if (occasion) requirements.push(`The decor must fit the stated occasion: ${occasion}.`);
  if (season) {
    requirements.push(`The decor should read as ${season} through colours, textiles, greenery or seasonal props; weather does not have to be visible. Only decor that clearly belongs to the opposite season is off-topic.`);
  }
  if (!PEOPLE_WANTED_RE.test(keyword)) requirements.push("No people: no person or human body part (hands, arms, legs, back, silhouette, reflection) anywhere in the frame — only the space and the decor.");
  requirements.push(`Real photography only: no 3D render, no CGI, no AI-generated interior, no floor plan, no mood-board collage, no real-estate listing watermark, no furniture-catalogue cut-out on a white background.`);

  return { decor_mode: mode, hero_element: hero, room, setting, style, palette, materials, season, occasion, size, budget, source_keyword_en: source, hard_requirements: requirements };
}

export function interiorContractPrompt(contract: InteriorContract): string {
  return `HOME DECOR INTENT CONTRACT (derived from the original English Focus Keyword):\n` +
    `decor_mode: ${contract.decor_mode}\nhero_element: ${contract.hero_element || "none"}\n` +
    `room_or_zone: ${contract.room || "none"}\nsetting: ${contract.setting}\n` +
    `style: ${contract.style || "none"}\npalette: ${contract.palette || "none"}\n` +
    `materials: ${contract.materials || "none"}\nseason: ${contract.season || "none"}\n` +
    `occasion: ${contract.occasion || "none"}\nsize: ${contract.size || "none"}\n` +
    `budget: ${contract.budget || "none"}\n` +
    contract.hard_requirements.map((r) => `- ${r}`).join("\n");
}

/** Коды ниш, для которых работает контракт интерьера. */
export const INTERIOR_NICHES = ["interior", "decor", "outdoor"];

export function isInteriorNiche(niche?: string | null, subniche?: string | null): boolean {
  return INTERIOR_NICHES.includes(String(subniche || "")) || INTERIOR_NICHES.includes(String(niche || ""));
}

/** Ключ сам просит людей в кадре («family christmas photo»). Фигурки (gingerbread man, snowman, Santa) людьми не считаются. */
const PEOPLE_WANTED_RE = /\b(?:people|persons?|family|families|kids?|child(?:ren)?|toddlers?|babies|baby|couples?|women|woman|(?<!gingerbread )(?:men|man)|girls?|boys?|portraits?|selfies?)\b/i;

/**
 * Интерьер и декор — без людей (решение владельца 2026-10-19, аудит 20 рождественских статей best-for-you: ~20 кадров
 * с человеком, многие с баллом 10). Человек или часть тела в кадре — жёсткий отказ на оценке, отборе и ИИ-модерации.
 * Исключение — ключ сам просит людей.
 */
export function noPeopleInFrame(niche: string | null | undefined, subniche: string | null | undefined, keyword: string | null | undefined): boolean {
  return isInteriorNiche(niche, subniche) && !PEOPLE_WANTED_RE.test(String(keyword || ""));
}

/** Правило «без людей» для промтов (оценка, ИИ-модерация). */
export const NO_PEOPLE_RULE =
  "NO PEOPLE (hard): this is an interior/decor article — the photo must show the space and the decor only. " +
  "Reject any photo where a person or any human body part is visible: a face, hands holding or hanging something, arms, legs, feet, a back, " +
  "a silhouette or a reflection in a mirror — even small, blurred or in the background. Pets, figurines, dolls, gingerbread men, Santa or angel ornaments are fine.";
