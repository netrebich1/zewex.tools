/**
 * Разметка ключа → keyword_attributes (признаки темы для контрактов).
 * Детерминированная часть — порт src/lib/parseKeyword.ts (словарный парсер ногтей) + обобщение на другие ниши
 * по закрытым спискам profile.attributes и словарям required_visuals. ИИ-часть (parse-keyword-ai) не обязательна
 * для контрактов (они строятся и по самому ключу), поэтому в этапе search используется словарная разметка;
 * `parseKeywordAi` оставлен как необязательный вариант (слот text_fast, модель rp_photo_search), с фолбэком на словарь.
 */
import { aiChat, type AiCtx } from "@/lib/articles/ai";
import { stageModel } from "@/lib/articles/prompts";
import type { ArticleRecipeSnapshot } from "@/lib/articles/types";
import { SLOTS } from "@/lib/articles/types";
import type { NicheProfile } from "./profile";
import { FASHION_PIECES } from "./contracts";

export type KeywordAttributes = Record<string, string>;

export interface ParsedKeyword extends KeywordAttributes {
  keyword_surface: "fingernails" | "toenails";
  keyword_nail_shape: string;
  keyword_nail_length: string;
  keyword_nail_color: string;
  keyword_nail_art: string;
  keyword_nail_technique: string;
  keyword_finish: string;
  keyword_aesthetic: string;
  keyword_occasion: string;
  keyword_age: string;
  keyword_skin_tone: string;
  keyword_setting: string;
  keyword_season: string;
}

// ── словари ногтей (parseKeyword.ts:32-170) ──
const TOE_PATTERN = /\b(pedicure|pedi|toenails?|toe\s*nails?|toes?|feet\s*nails?|foot\s*nails?)\b/i;

const NAIL_SHAPES = ["lipstick nails", "edge nails", "arrow nails", "almond", "coffin", "ballerina", "stiletto", "square", "squoval", "oval", "round", "pipe", "flare", "duck"];
const NAIL_LENGTHS = ["extra long", "extra-long", "super long", "long", "medium", "short", "micro"];
const NAIL_COLORS = [
  "cherry red", "wine red", "milky white", "milky pink", "baby blue", "baby pink", "hot pink", "bubblegum pink",
  "rose gold", "sage green", "forest green", "kelly green", "butter yellow", "mustard yellow",
  "cherry coke", "cherry chocolate", "glazed donut", "silver chrome", "gold chrome", "rose gold chrome",
  "red", "pink", "rose", "coral", "salmon", "peach", "fuchsia", "burgundy", "merlot", "maroon",
  "nude", "beige", "taupe", "mocha", "milk", "milky", "cream", "ivory", "champagne",
  "blue", "navy", "cobalt", "teal", "mint", "sage", "olive", "emerald",
  "lilac", "lavender", "purple", "plum", "mauve", "black", "charcoal", "grey", "gray", "white",
  "chrome", "silver", "gold", "brown", "chocolate", "caramel", "espresso", "cinnamon",
  "orange", "rust", "terracotta", "tangerine", "amber", "yellow", "butter", "lemon", "pastel", "neon",
];
const SKIN_TONE_PATTERNS = [
  /\b(dark|deep|brown|olive|tan|fair|light|pale)\s+skin\b/i,
  /\b(black|asian|latina|hispanic|indian)\s+(woman|women|girl|girls|lady|ladies|hands?|fingers?)\b/i,
  /\bfor\s+(dark|deep|brown|olive|tan|fair|light|pale)\s+(skin|hands?|women|girls?|ladies?)\b/i,
];
const NAIL_ART_STYLES = [
  "french tip", "french tips", "french manicure", "french pedicure", "french pedi", "french mani", "reverse french",
  "micro french", "colored french", "baby french", "french", "milk bath nails", "milk bath", "glazed donut", "glass nails",
  "cat eye", "velvet nails", "aura nails", "cow print", "leopard print", "zebra print", "tortoise shell", "tortoiseshell",
  "polka dot", "polka dots", "evil eye", "smiley face", "animal print", "3d nails", "3d charms",
  "aura", "ombre", "gradient", "chrome", "glitter", "floral", "flower", "geometric", "abstract", "marble",
  "swirl", "swirls", "wavy", "minimalist", "minimal", "jelly", "sheer", "rhinestone", "rhinestones", "jeweled", "bedazzled",
  "cherry", "butterfly", "star", "stars", "heart", "hearts", "tribal", "paisley", "plaid", "gingham",
  "watercolor", "splatter", "newspaper", "foil",
];
const NAIL_TECHNIQUES = [
  "gel-x", "gel x", "soft gel", "hard gel", "builder gel", "rubber base", "gel polish", "regular polish", "standard polish",
  "dip powder", "apres gel x", "poly gel", "press-on", "press ons", "press on", "fake nails",
  "gel", "acrylic", "acrylics", "dip", "sns", "polygel", "sculpted", "extension", "extensions", "tips", "shellac", "soak-off",
];
const FINISHES = [
  "cat eye", "matte top", "wet look", "matte", "glossy", "shiny", "metallic", "jelly", "shimmer", "sheer", "milky",
  "holographic", "holo", "chrome", "duochrome", "magnetic", "flake", "flakes", "pearlescent", "pearl", "velvet", "sugar", "sugared", "textured",
];
const AESTHETICS = [
  "clean girl", "old money", "quiet luxury", "soft girl", "pilates princess", "mob wife", "mob-wife", "tomato girl",
  "dark academia", "cottagecore", "fairycore", "coquette", "y2k", "minimalist", "minimal", "maximalist",
  "edgy", "punk", "grunge", "goth", "gothic", "preppy", "sporty", "romantic", "feminine",
  "modern", "classic", "timeless", "trendy", "vintage", "retro", "bohemian", "boho", "eclectic",
  "whimsical", "playful", "sophisticated", "elegant",
];
const OCCASIONS = [
  "date night", "new year", "new year's", "nye", "fourth of july", "mother's day", "mothers day", "pool party",
  "wedding", "weddings", "bridal", "bride", "brides", "bridesmaid", "prom", "graduation", "birthday", "birthdays",
  "halloween", "christmas", "holiday", "thanksgiving", "valentine's", "valentines", "easter",
  "work", "office", "professional", "business", "date", "dates", "casual",
  "vacation", "beach", "pool", "cruise", "travel", "party", "parties",
];
const SEASONS = ["summer", "fall", "autumn", "winter", "spring"];
const AGE_PATTERNS = [/\bover\s+(\d{2})\b/i, /\bin\s+(?:her|their)\s+(\d{2})s\b/i, /\b(\d{2})s\b/i, /\b(teen|teenage|teenager)\b/i, /\b(mature)\b/i];
const SETTINGS = [
  "holding coffee", "with coffee", "holding mug", "holding flowers", "with flowers", "floral background", "holding book", "reading",
  "marble surface", "wooden surface", "fabric background", "beach background", "pool background", "white background", "minimal background",
  "flat lay", "flat-lay", "flatlay", "beach", "pool", "ocean", "sand", "urban", "street", "cafe", "salon", "studio",
  "outdoor", "nature", "garden", "marble", "wood", "linen",
];

const reCache = new Map<string, RegExp>();
function wb(word: string): RegExp {
  let re = reCache.get(word);
  if (!re) {
    re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    reCache.set(word, re);
  }
  return re;
}

function firstMatch(kw: string, list: string[]): string {
  for (const item of list) if (wb(item).test(kw)) return item;
  return "none";
}

function parseAge(kw: string): string {
  for (const pattern of AGE_PATTERNS) {
    const match = kw.match(pattern);
    if (!match) continue;
    const captured = match[1] || match[0];
    const num = parseInt(captured, 10);
    if (!isNaN(num)) {
      if (num >= 60) return "mature";
      if (num >= 50) return "50s";
      if (num >= 40) return "40s";
      if (num >= 30) return "30s";
      if (num >= 20) return "20s";
      return "teen";
    }
    if (/teen/i.test(captured)) return "teen";
    if (/mature/i.test(captured)) return "mature";
    return "none";
  }
  return "none";
}

function parseSkinTone(kw: string): { tone: string; words: Set<string> } {
  const words = new Set<string>();
  let tone = "none";
  for (const pattern of SKIN_TONE_PATTERNS) {
    const m = kw.match(pattern);
    if (m) {
      if (tone === "none") tone = m[1].toLowerCase();
      words.add(m[1].toLowerCase());
    }
  }
  return { tone, words };
}

/** Словарный парсер ключа для ногтей (порт parseKeyword.ts:181-294, поведение 1:1). */
export function parseKeyword(keyword: string | null | undefined): ParsedKeyword {
  const kw = (keyword || "").toLowerCase().trim();
  const result: ParsedKeyword = {
    keyword_surface: "fingernails",
    keyword_nail_shape: "none", keyword_nail_length: "none", keyword_nail_color: "none", keyword_nail_art: "none",
    keyword_nail_technique: "none", keyword_finish: "none", keyword_aesthetic: "none", keyword_occasion: "none",
    keyword_age: "none", keyword_skin_tone: "none", keyword_setting: "none", keyword_season: "none",
  };
  if (!kw) return result;

  if (TOE_PATTERN.test(kw)) result.keyword_surface = "toenails";

  const skin = parseSkinTone(kw);
  result.keyword_skin_tone = skin.tone;

  result.keyword_nail_shape = firstMatch(kw, NAIL_SHAPES);
  result.keyword_nail_length = firstMatch(kw, NAIL_LENGTHS);

  for (const color of NAIL_COLORS) {
    if (skin.words.has(color)) continue;
    if (wb(color).test(kw)) {
      // «black women», «dark skin» — не цвет лака
      const stripped = kw.replace(/\b(black|brown|dark|deep|olive|tan|fair|light|pale)\s+(skin|woman|women|girl|girls|lady|ladies|hands?|fingers?)\b/gi, "");
      if (wb(color).test(stripped)) {
        result.keyword_nail_color = color;
        break;
      }
    }
  }

  result.keyword_nail_art = firstMatch(kw, NAIL_ART_STYLES);
  result.keyword_nail_technique = firstMatch(kw, NAIL_TECHNIQUES);
  result.keyword_finish = firstMatch(kw, FINISHES);
  result.keyword_aesthetic = firstMatch(kw, AESTHETICS);
  result.keyword_occasion = firstMatch(kw, OCCASIONS);
  result.keyword_season = firstMatch(kw, SEASONS);
  result.keyword_age = parseAge(kw);
  result.keyword_setting = firstMatch(kw, SETTINGS);
  return result;
}

const NAIL_NICHES = new Set(["nails", "manicure", "pedicure"]);

/**
 * Детерминированная разметка ключа для любой ниши. Для ногтей — словарный парсер оригинала; для остальных —
 * закрытые списки profile.attributes (длинные значения раньше коротких), словари required_visuals того же признака
 * и общие словари (сезон, возраст, повод, эстетика, тон кожи, сеттинг, hero piece одежды).
 */
export function parseKeywordAttributes(keyword: string, profile: NicheProfile): KeywordAttributes {
  if (NAIL_NICHES.has(profile.niche_code)) return { ...parseKeyword(keyword) };
  const kw = String(keyword || "").toLowerCase().replace(/\s+/g, " ").trim();
  const out: KeywordAttributes = {};
  const skin = parseSkinTone(kw);
  const byLabel = (label: string) => profile.required_visuals.find((d) => d.label.toLowerCase() === label);
  const fromDict = (label: string): string => {
    const dict = byLabel(label);
    if (!dict) return "none";
    for (const [value, words] of Object.entries(dict.values)) if (words.some((w) => wb(w).test(kw))) return value;
    return "none";
  };

  for (const attr of profile.attributes) {
    let value = "none";
    if (attr.values?.length) {
      const sorted = [...attr.values].filter((v) => v !== "none").sort((a, b) => b.length - a.length);
      value = firstMatch(kw, sorted);
    }
    if (value === "none") {
      switch (attr.key) {
        case "keyword_season": value = firstMatch(kw, SEASONS); break;
        case "keyword_age": value = parseAge(kw); break;
        case "keyword_occasion": value = firstMatch(kw, OCCASIONS); break;
        case "keyword_aesthetic": case "keyword_style": value = firstMatch(kw, AESTHETICS); break;
        case "keyword_skin_tone": value = skin.tone; break;
        case "keyword_setting": value = firstMatch(kw, SETTINGS); break;
        case "keyword_hero_piece": value = FASHION_PIECES.find(([, re]) => re.test(kw))?.[0] || "none"; break;
        case "keyword_hair_length": value = fromDict("length"); break;
        case "keyword_hair_texture": value = fromDict("texture"); break;
        case "keyword_hair_color_technique": value = fromDict("technique"); break;
        case "keyword_silhouette": value = fromDict("silhouette"); break;
        case "keyword_outfit_type": value = fromDict("garment"); break;
        case "keyword_room": value = fromDict("space"); break;
        case "keyword_palette": case "keyword_hair_color": case "keyword_nail_color": value = fromDict("colour"); break;
        case "keyword_placement": value = fromDict("placement"); break;
        case "keyword_tattoo_style": case "keyword_makeup_type": value = fromDict("style") !== "none" ? fromDict("style") : fromDict("focus"); break;
        case "keyword_eye_technique": value = fromDict("technique"); break;
        case "keyword_finish": value = fromDict("finish"); break;
        default: value = "none";
      }
    }
    if (value === "none" && attr.fallback) value = attr.fallback;
    out[attr.key] = value;
  }
  // Пол/аудитория не кладутся в атрибуты — ими занимается audience.ts.
  return out;
}

// ── ИИ-разметка (необязательная): порт parse-keyword-ai/index.ts без Supabase ──

// оригинал: parse-keyword-ai/index.ts:19-102
const NAILS_SYSTEM_PROMPT = `You are a precise entity extractor for nail content keywords. Your job: parse a focus_keyword like "almond chrome nails for summer 2026" and extract structured fields.

Return STRICT JSON with these fields (use "none" if not present in the keyword):

{
  "keyword_surface": "fingernails|toenails",
  "keyword_nail_shape": "almond|coffin|square|oval|stiletto|ballerina|round|squoval|pipe|flare|lipstick|none",
  "keyword_nail_length": "short|medium|long|extra-long|micro|none",
  "keyword_nail_color": "primary nail color word — exact match preferred (e.g., 'cherry red', 'milky white', 'sage') or 'none'",
  "keyword_nail_art": "the specific visual design, technique, or motif rendered on the nails. Use your world knowledge to recognize ANY noun in the keyword that names a recognizable visual subject (object, creature, plant, food, character, symbol, pattern, abstract technique, etc.) and could plausibly be painted/applied on a nail. Copy that noun verbatim from the keyword (lowercased, minimal normalization). Do NOT restrict yourself to a predefined list — if the keyword names a thing that has a visual identity, it IS the nail art. Return 'none' only when the keyword contains no such subject (e.g. pure color + shape + season).",
  "keyword_nail_technique": "gel|acrylic|dip powder|polygel|gel-x|press-on|regular polish|none",
  "keyword_finish": "matte|glossy|glitter|chrome|cat eye|velvet|holographic|milky|none",
  "keyword_aesthetic": "clean girl|old money|y2k|coquette|minimalist|mob wife|dark academia|cottagecore|edgy|romantic|none",
  "keyword_occasion": "wedding|prom|halloween|christmas|valentines|work|date night|birthday|graduation|new year|vacation|beach|none",
  "keyword_season": "summer|fall|winter|spring|none",
  "keyword_age": "teen|20s|30s|40s|50s|60s|mature|none",
  "keyword_skin_tone": "dark|brown|light|fair|olive|tan|none",
  "keyword_setting": "flatlay|holding coffee|holding flowers|beach|salon|studio|marble|wood|outdoor|none"
}

RULES:
0. SURFACE detection: default "fingernails". Set "toenails" if the keyword contains any of: "pedicure", "pedi", "toe nails", "toenails", "toenail", "toe", "toes", "feet nails", "foot nails". Otherwise "fingernails" (including bare "manicure", "mani", "nails").
1. NEVER return a color in keyword_nail_color if the word is part of a skin-tone phrase ("dark skin", "black woman", "olive hands"). In that case, set keyword_skin_tone instead and keyword_nail_color="none".
2. "lipstick nails" → shape="lipstick" (compound match). "lipstick red" → color="red" (not shape).
3. "french tip" / "french tips" / "french manicure" / "french pedicure" / "french pedi" / "french mani" / bare "french" applied to nails/mani/pedi/toes → art="french tip" (NOT color="french"). "french" is NEVER a color.
4. "cat eye nails" → finish="cat eye" (compound match before generic).
5. "glazed donut nails" → art="glazed donut" AND finish="chrome" (implied by glazed). color may be "none" or what's specified.
6. "milk bath" / "milky" → if "milk bath nails" appears, art="milk bath" and color="milky" or "none". If only "milky" → color="milky".
7. "chrome" alone in keyword → color="chrome" AND finish="chrome" (it's both — chrome is a finish achieved via chrome powder/pigment, often referred to as a color).
8. "mature" / "over 40" / "for women over 50" / "for women in their 40s" → age="40s" or "50s" or "mature".
9. "wedding" / "bride" / "brides" / "bridesmaid" → occasion="wedding".
10. "design" / "designs" / "ideas" — these are NOT entities, ignore them.
11. MOTIF DETECTION (CRITICAL — AI-LEVEL, NOT DICTIONARY): treat keyword_nail_art as an OPEN entity slot. Use semantic understanding to detect ANY visual subject in the keyword — fruits, flowers, animals, insects, characters, logos, symbols, foods, drinks, weather, celestial objects, mythical creatures, holiday icons, abstract patterns, textures, finishes-as-effect, etc. There is no closed vocabulary. If the keyword contains a noun that names something with a recognizable visual form, that noun goes into keyword_nail_art. Never lose a motif just because it is unusual or unfamiliar.
12. Motif vs color disambiguation: when a noun denotes a real-world object/creature with a canonical color identity AND it is functioning as the art subject (not as a color modifier of another noun), set BOTH art=<motif> AND color=<the natural dominant color(s) of that motif as you know them>. When the same word is used purely as a color qualifier of another head noun ("cherry red nails", "lemon yellow tips"), keep it in color only and art="none" unless another subject is also present.
13. NEVER invent fields not in the schema. NEVER add extra keys.
14. If unsure → "none" for that field.
15. Return ONLY the JSON object. No commentary, no markdown fences, no explanation.

EXAMPLES:

Input: "almond chrome nails summer 2026"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"almond","keyword_nail_length":"none","keyword_nail_color":"chrome","keyword_nail_art":"chrome","keyword_nail_technique":"none","keyword_finish":"chrome","keyword_aesthetic":"none","keyword_occasion":"none","keyword_season":"summer","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "short french tip nails for dark skin women"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"none","keyword_nail_length":"short","keyword_nail_color":"none","keyword_nail_art":"french tip","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"none","keyword_occasion":"none","keyword_season":"none","keyword_age":"none","keyword_skin_tone":"dark","keyword_setting":"none"}

Input: "coquette milky white gel nails with pink bows"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"none","keyword_nail_length":"none","keyword_nail_color":"milky white","keyword_nail_art":"bows","keyword_nail_technique":"gel","keyword_finish":"milky","keyword_aesthetic":"coquette","keyword_occasion":"none","keyword_season":"none","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "wedding nail designs for brides 2026"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"none","keyword_nail_length":"none","keyword_nail_color":"none","keyword_nail_art":"none","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"none","keyword_occasion":"wedding","keyword_season":"none","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "lipstick red almond nails"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"almond","keyword_nail_length":"none","keyword_nail_color":"red","keyword_nail_art":"none","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"none","keyword_occasion":"none","keyword_season":"none","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "edgy glazed donut chrome nails for clubbing"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"none","keyword_nail_length":"none","keyword_nail_color":"chrome","keyword_nail_art":"glazed donut","keyword_nail_technique":"none","keyword_finish":"chrome","keyword_aesthetic":"edgy","keyword_occasion":"none","keyword_season":"none","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "minimal cherry chocolate manicure 2026 for women over 40"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"none","keyword_nail_length":"none","keyword_nail_color":"cherry chocolate","keyword_nail_art":"none","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"minimal","keyword_occasion":"none","keyword_season":"none","keyword_age":"40s","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "summer pedicure ideas red toenails"
Output: {"keyword_surface":"toenails","keyword_nail_shape":"none","keyword_nail_length":"none","keyword_nail_color":"red","keyword_nail_art":"none","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"none","keyword_occasion":"none","keyword_season":"summer","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "french tip toe nails for beach vacation"
Output: {"keyword_surface":"toenails","keyword_nail_shape":"none","keyword_nail_length":"none","keyword_nail_color":"none","keyword_nail_art":"french tip","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"none","keyword_occasion":"vacation","keyword_season":"none","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"beach"}

Input: "french pedicure for summer 2026"
Output: {"keyword_surface":"toenails","keyword_nail_shape":"none","keyword_nail_length":"none","keyword_nail_color":"none","keyword_nail_art":"french tip","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"none","keyword_occasion":"none","keyword_season":"summer","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "summer watermelon nails 2026"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"none","keyword_nail_length":"none","keyword_nail_color":"pink and green","keyword_nail_art":"watermelon","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"none","keyword_occasion":"none","keyword_season":"summer","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "cherry red almond nails"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"almond","keyword_nail_length":"none","keyword_nail_color":"cherry red","keyword_nail_art":"none","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"none","keyword_occasion":"none","keyword_season":"none","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "butterfly toe nails for beach"
Output: {"keyword_surface":"toenails","keyword_nail_shape":"none","keyword_nail_length":"none","keyword_nail_color":"none","keyword_nail_art":"butterfly","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"none","keyword_occasion":"none","keyword_season":"none","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"beach"}

Input: "hello kitty pink coquette nails"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"none","keyword_nail_length":"none","keyword_nail_color":"pink","keyword_nail_art":"hello kitty","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"coquette","keyword_occasion":"none","keyword_season":"none","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}

Input: "halloween ghost nails short"
Output: {"keyword_surface":"fingernails","keyword_nail_shape":"none","keyword_nail_length":"short","keyword_nail_color":"none","keyword_nail_art":"ghost","keyword_nail_technique":"none","keyword_finish":"none","keyword_aesthetic":"none","keyword_occasion":"halloween","keyword_season":"none","keyword_age":"none","keyword_skin_tone":"none","keyword_setting":"none"}`;

/** Универсальный промт извлечения признаков из профиля ниши (parse-keyword-ai/index.ts:105-126). */
function genericSystemPrompt(profile: NicheProfile): string {
  const lines = profile.attributes.map((a) => {
    const vals = a.values?.length ? a.values.join("|") : "free text — copy the wording from the keyword";
    return `  "${a.key}": "${a.label} — ${vals}"`;
  });
  return `You are a precise entity extractor for ${profile.label} content keywords.
Parse the focus keyword and extract structured fields.

Return STRICT JSON with exactly these fields (use "none" when the keyword does not state it):

{
${lines.join(",\n")}
}

RULES:
1. Extract only what the keyword actually says — never invent or infer beyond common sense.
2. For a field with a closed list, return one of the listed values or "none".
3. For a free-text field, copy the wording from the keyword, lowercased, minimally normalised.
4. Words like "ideas", "designs", "best", "trends", years and numbers are NOT entities — ignore them.
5. Never add keys that are not in the schema. If unsure → "none".
6. Return ONLY the JSON object — no commentary, no markdown fences.`;
}

const sanitize = (v: unknown, fallback: string): string => {
  if (!v || typeof v !== "string") return fallback;
  const c = v.toLowerCase().trim().slice(0, 60);
  return c || fallback;
};

/**
 * ИИ-разметка ключа (один дешёвый вызов, temperature 0.1, maxTokens 800, timeout 15 с — как оригинал).
 * Закрытые списки проверяются реально: чужое значение → "none" (аудит 03, п.1.1: validateClosed только писал warn).
 * При любой ошибке возвращает словарную разметку — ИИ не обязателен.
 */
export async function parseKeywordAi(ctx: AiCtx, recipe: ArticleRecipeSnapshot, keyword: string, profile: NicheProfile): Promise<{ attrs: KeywordAttributes; source: "ai" | "dictionary"; error?: string }> {
  const dictionary = parseKeywordAttributes(keyword, profile);
  const isNails = NAIL_NICHES.has(profile.niche_code);
  try {
    const r = await aiChat(ctx, {
      slot: SLOTS.textFast,
      model: stageModel(recipe, "rp_photo_search"),
      system: isNails ? NAILS_SYSTEM_PROMPT : genericSystemPrompt(profile),
      user: `Keyword: "${keyword}"\nReturn JSON.`,
      json: true,
      temperature: 0.1,
      maxTokens: 800,
      timeoutMs: 15_000,
    });
    const parsed = (r.json && typeof r.json === "object" ? r.json : {}) as Record<string, unknown>;
    const out: KeywordAttributes = {};
    for (const a of profile.attributes) {
      let v = sanitize(parsed[a.key], a.fallback || "none");
      if (a.values?.length && v !== "none" && !a.values.includes(v)) v = a.fallback || "none";
      out[a.key] = v;
    }
    if (isNails) {
      // детерминированный override поверхности: формулировка ключа важнее догадки модели (оригинал :267-274)
      out.keyword_surface = TOE_PATTERN.test(keyword) ? "toenails" : "fingernails";
    }
    return { attrs: out, source: "ai" };
  } catch (e) {
    return { attrs: dictionary, source: "dictionary", error: (e as Error).message.slice(0, 200) };
  }
}
