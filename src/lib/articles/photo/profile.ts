/**
 * Профиль ниши — единый источник «деталей» для фото-цепочки и текстовых этапов.
 * Порт оригинала _shared/nicheProfile.ts: встроенные профили (DEFAULT_NICHE_PROFILES) + таблица ArtNicheProfile,
 * которая перекрывает код только непустыми полями (оригинал: mergeProfile, nicheProfile.ts:764-783).
 * Имена экспортов и типов сохранены — их импортируют этапы rank/rate/select и текстовая цепочка.
 */
import { prisma } from "@/lib/db";
import { PHOTO_FACT_DESCRIPTIONS, factFieldGuide, sanitizeFacts } from "./factSanitize";

export interface NicheAttribute {
  /** ключ поля в keyword_attributes */
  key: string;
  /** подпись для промта извлечения */
  label: string;
  /** закрытый список значений (пусто = свободное значение) */
  values?: string[];
  /** значение по умолчанию, если не найдено */
  fallback?: string;
}

export interface DiversityAxis {
  key: string;
  weight: number;
  /** значение → слова-маркеры */
  values: Record<string, string[]>;
}

export interface ExclusiveGroup {
  /** когда правило применимо (regexp по теме+нише), пусто = всегда */
  scope?: string | null;
  /** взаимоисключающие наборы слов */
  variants: string[][];
}

export interface AttributeDict {
  label: string;
  values: Record<string, string[]>;
}

export interface NicheProfile {
  niche_code: string;
  label: string;
  attributes: NicheAttribute[];
  /** словари признаков для чек-листа релевантности */
  required_visuals: AttributeDict[];
  exclusive_terms: ExclusiveGroup[];
  diversity_axes: DiversityAxis[];
  search_templates: {
    /** шаблоны основного запроса; {keyword} — ключ статьи */
    primary?: string[];
    /** шаблоны для доборов */
    topup?: string[];
    /** слова, которые запрещено добавлять в запросы */
    negative?: string[];
  };
  constraint_specs: Record<string, unknown>;
  concept_fields: string[];
  fact_block: {
    fields: string[];
    note?: string;
    /** как называть предмет статьи в промтах ("the hair", "the outfit") */
    subject_label?: string;
    /** поля фактов для оценки фото: имя → что описывать */
    photo_facts?: Record<string, string>;
  };
}

// оригинал: nicheProfile.ts:78-104
const COLOR_VOCAB: Record<string, string[]> = {
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
};

const COLOUR_DICT: AttributeDict = {
  label: "colour",
  values: {
    red: ["red"], pink: ["pink"], blue: ["blue"], navy: ["navy"], green: ["green"],
    black: ["black"], white: ["white"], nude: ["nude"], beige: ["beige"], brown: ["brown"],
    yellow: ["yellow"], orange: ["orange"], purple: ["purple", "lilac", "lavender"],
    grey: ["grey", "gray"], gold: ["gold"], silver: ["silver"], burgundy: ["burgundy", "wine"],
  },
};

// ── НОГТИ (nicheProfile.ts:107-190) ──
const NAILS: NicheProfile = {
  niche_code: "nails",
  label: "Дизайн ногтей",
  attributes: [
    { key: "outfit_mode", label: "article intent mode", values: ["piece", "look"] },
    { key: "keyword_surface", label: "fingernails or toenails", values: ["fingernails", "toenails"], fallback: "fingernails" },
    { key: "keyword_nail_shape", label: "nail shape", values: ["almond", "coffin", "square", "oval", "stiletto", "ballerina", "round", "squoval", "pipe", "flare", "lipstick", "none"] },
    { key: "keyword_nail_length", label: "nail length", values: ["short", "medium", "long", "extra-long", "micro", "none"] },
    { key: "keyword_nail_color", label: "main colour" },
    { key: "keyword_nail_art", label: "design / art motif" },
    { key: "keyword_nail_technique", label: "technique", values: ["gel", "acrylic", "dip powder", "polygel", "gel-x", "press-on", "regular polish", "none"] },
    { key: "keyword_finish", label: "finish", values: ["matte", "glossy", "glitter", "chrome", "cat eye", "velvet", "holographic", "milky", "none"] },
    { key: "keyword_aesthetic", label: "aesthetic" },
    { key: "keyword_occasion", label: "occasion" },
    { key: "keyword_season", label: "season", values: ["summer", "fall", "winter", "spring", "none"] },
    { key: "keyword_age", label: "age group", values: ["teen", "20s", "30s", "40s", "50s", "60s", "mature", "none"] },
    { key: "keyword_skin_tone", label: "skin tone", values: ["dark", "brown", "light", "fair", "olive", "tan", "none"] },
    { key: "keyword_setting", label: "setting" },
  ],
  required_visuals: [
    { label: "length", values: { short: ["short", "shorter", "stubby"], medium: ["medium", "mid"], long: ["long", "extra", "xl"] } },
    { label: "shape", values: { almond: ["almond"], square: ["square"], squoval: ["squoval"], oval: ["oval"], round: ["round"], coffin: ["coffin", "ballerina"], stiletto: ["stiletto"] } },
    { label: "finish", values: { matte: ["matte"], glossy: ["glossy", "gloss"], chrome: ["chrome", "mirror"], glitter: ["glitter", "sparkle"], "cat-eye": ["cat"], jelly: ["jelly", "sheer"] } },
    COLOUR_DICT,
  ],
  exclusive_terms: [
    {
      scope: "nail|manicure|pedicure",
      variants: [
        ["toenail", "toenails", "toe", "toes", "pedicure", "pedi", "feet", "foot"],
        ["fingernail", "fingernails", "manicure", "hand", "hands", "finger", "fingers"],
      ],
    },
  ],
  diversity_axes: [
    { key: "color", weight: 3, values: COLOR_VOCAB },
    { key: "design", weight: 2.2, values: {
      french: ["french", "tip"],
      ombre: ["ombre", "gradient", "baby boomer"],
      art: ["nail art", "snowflake", "floral", "flower", "star", "heart", "marble", "dots", "polka", "stripe", "checker", "animal", "leopard", "abstract", "swirl", "aura"],
      solid: ["solid", "single colour", "single color", "one colour", "one color", "plain"],
    } },
    { key: "shape", weight: 1.8, values: { almond: ["almond"], square: ["square", "squoval"], coffin: ["coffin", "ballerina"], stiletto: ["stiletto", "sharp point", "pointed"], oval: ["oval", "round"] } },
    { key: "finish", weight: 1.2, values: {
      glossy: ["glossy", "high gloss", "shiny", "high-shine"], matte: ["matte", "velvet"],
      chrome: ["chrome", "metallic", "mirror", "foil"], glitter: ["glitter", "sparkle", "shimmer", "sequin"],
      jelly: ["jelly", "sheer", "translucent"],
    } },
    { key: "length", weight: 1, values: { short: ["short"], medium: ["medium length", "mid-length", "medium"], long: ["long", "extra long", "extra-long"] } },
  ],
  search_templates: { primary: ["{keyword}"], topup: ["{keyword} ideas", "{keyword} inspiration", "{keyword} close up"] },
  constraint_specs: { source: "nailSpecs" },
  concept_fields: ["design", "style_description", "mood", "occasion", "color_palette", "hero_piece"],
  fact_block: {
    fields: ["shape", "length", "colour", "finish", "technique", "design"],
    note: "форма и длина ногтей обязательны в тексте секции",
    subject_label: "the nails / the design",
    photo_facts: PHOTO_FACT_DESCRIPTIONS.nails,
  },
};

// ── ВОЛОСЫ (nicheProfile.ts:193-304) ──
const HAIR: NicheProfile = {
  niche_code: "hair",
  label: "Волосы",
  attributes: [
    { key: "keyword_hair_cut", label: "haircut family (pixie, bob, lob, shag, layers, long cut…)" },
    { key: "keyword_hair_length", label: "hair length", values: ["very short", "short", "chin length", "shoulder length", "medium", "long", "extra-long", "none"] },
    { key: "keyword_hair_texture", label: "texture / curl pattern", values: ["straight", "wavy", "curly", "coily", "fine", "thick", "none"] },
    { key: "keyword_hair_color", label: "hair colour" },
    { key: "keyword_hair_color_technique", label: "colouring technique", values: ["balayage", "highlights", "ombre", "babylights", "money piece", "root shadow", "single process", "foilyage", "none"] },
    { key: "keyword_hair_styling", label: "styling (blowout, braids, updo, ponytail, curtain bangs…)" },
    { key: "keyword_face_shape", label: "face shape", values: ["round", "oval", "square", "heart", "long", "none"] },
    { key: "keyword_aesthetic", label: "aesthetic" },
    { key: "keyword_occasion", label: "occasion" },
    { key: "keyword_season", label: "season", values: ["summer", "fall", "winter", "spring", "none"] },
    { key: "keyword_age", label: "age group", values: ["teen", "20s", "30s", "40s", "50s", "60s", "mature", "none"] },
    { key: "keyword_setting", label: "setting" },
  ],
  required_visuals: [
    { label: "length", values: {
      "very short": ["pixie", "buzz", "crop", "cropped", "very short"],
      short: ["short", "bob", "bixie"],
      medium: ["lob", "shoulder", "medium", "mid-length", "midlength", "collarbone"],
      long: ["long", "waist", "extra long"],
    } },
    { label: "texture", values: { straight: ["straight", "sleek", "blunt"], wavy: ["wavy", "waves", "beachy"], curly: ["curly", "curls", "ringlet", "perm"], coily: ["coily", "afro", "kinky", "4c"] } },
    { label: "bangs", values: { curtain: ["curtain"], blunt: ["blunt bangs", "blunt fringe"], side: ["side swept", "side-swept"], wispy: ["wispy"], none: ["no bangs", "without bangs"] } },
    { label: "technique", values: { balayage: ["balayage"], highlights: ["highlights", "babylights", "foilyage"], ombre: ["ombre"], "money piece": ["money piece"], solid: ["single process", "all over"] } },
    COLOUR_DICT,
  ],
  exclusive_terms: [
    { scope: "hair|haircut|hairstyle|bob|pixie|braid|curls|bangs|balayage|blonde|brunette", variants: [["short", "bob", "pixie", "lob", "crop", "bixie"], ["long", "waist-length", "midlength", "mid-length", "shoulder"]] },
    { scope: "hair|haircut|hairstyle", variants: [["nail", "nails", "manicure", "pedicure"], ["hair", "haircut", "hairstyle", "bangs", "braid"]] },
  ],
  diversity_axes: [
    { key: "color", weight: 2.6, values: {
      ...COLOR_VOCAB,
      blonde: ["blonde", "blond", "platinum", "honey", "vanilla", "butter blonde"],
      brunette: ["brunette", "chestnut", "chocolate brown", "espresso"],
      auburn: ["auburn", "copper", "ginger", "red hair"],
      balayage: ["balayage", "highlights", "babylights"],
    } },
    { key: "length", weight: 2.4, values: { "very short": ["pixie", "buzz", "cropped"], short: ["short", "bob", "bixie"], medium: ["lob", "shoulder", "medium", "collarbone"], long: ["long", "waist"] } },
    { key: "texture", weight: 2.2, values: { straight: ["straight", "sleek", "blunt"], wavy: ["wavy", "waves", "beachy"], curly: ["curly", "curls", "ringlets"], coily: ["coily", "afro", "kinky"] } },
    { key: "styling", weight: 1.6, values: { updo: ["updo", "bun", "chignon", "topknot"], braid: ["braid", "braids", "plait", "cornrow"], ponytail: ["ponytail", "pony"], down: ["blowout", "loose", "worn down", "half up"] } },
    { key: "bangs", weight: 1.2, values: { curtain: ["curtain bangs"], blunt: ["blunt bangs", "blunt fringe"], side: ["side swept bangs"], wispy: ["wispy bangs"], none: ["no bangs"] } },
  ],
  search_templates: { primary: ["{keyword}"], topup: ["{keyword} hair", "{keyword} hairstyle", "{keyword} back view"], negative: ["wig for sale", "hair extension bundles"] },
  constraint_specs: { source: "cutSpecs" },
  concept_fields: ["cut", "length", "texture", "colour", "styling", "who_it_suits", "mood", "occasion"],
  fact_block: {
    fields: ["cut", "length", "texture", "colour", "technique", "styling"],
    note: "стрижка и длина обязательны в тексте секции",
    subject_label: "the hair — cut, colour and styling",
    photo_facts: PHOTO_FACT_DESCRIPTIONS.hair,
  },
};

// ── ОДЕЖДА (nicheProfile.ts:308-389) ──
const OUTFITS: NicheProfile = {
  niche_code: "outfits",
  label: "Одежда",
  attributes: [
    { key: "keyword_outfit_type", label: "outfit type (dress, jeans look, suit, co-ord…)" },
    { key: "keyword_hero_piece", label: "hero garment" },
    { key: "keyword_silhouette", label: "silhouette", values: ["oversized", "fitted", "a-line", "straight", "wide leg", "bodycon", "relaxed", "none"] },
    { key: "keyword_palette", label: "colour palette" },
    { key: "keyword_style", label: "style / aesthetic" },
    { key: "keyword_occasion", label: "occasion" },
    { key: "keyword_season", label: "season", values: ["summer", "fall", "winter", "spring", "none"] },
    { key: "keyword_age", label: "age group", values: ["teen", "20s", "30s", "40s", "50s", "60s", "mature", "none"] },
    { key: "keyword_body_type", label: "body type" },
    { key: "keyword_setting", label: "setting" },
  ],
  required_visuals: [
    { label: "garment", values: {
      dress: ["dress", "gown"], skirt: ["skirt"], jeans: ["jeans", "denim"], trousers: ["trousers", "pants", "slacks"],
      shorts: ["shorts"], suit: ["suit", "blazer set"], jumpsuit: ["jumpsuit", "romper"], coat: ["coat", "trench"],
    } },
    { label: "silhouette", values: { oversized: ["oversized", "baggy", "slouchy"], fitted: ["fitted", "bodycon", "tailored"], "wide leg": ["wide leg", "wide-leg", "flare"], straight: ["straight", "relaxed"] } },
    COLOUR_DICT,
  ],
  exclusive_terms: [
    { scope: "outfit|dress|skirt|jeans|denim|shorts|suit|jumpsuit|wear|style|look", variants: [["dress"], ["skirt"], ["jeans", "denim"], ["shorts"], ["suit"], ["jumpsuit"]] },
    { scope: "outfit|look|wear", variants: [["summer", "beach"], ["winter", "snow", "puffer"]] },
  ],
  diversity_axes: [
    { key: "color", weight: 2.8, values: COLOR_VOCAB },
    { key: "garment", weight: 2.4, values: {
      dress: ["dress", "gown"], skirt: ["skirt"], jeans: ["jeans", "denim"], trousers: ["trousers", "pants"],
      shorts: ["shorts"], suit: ["suit", "blazer"], jumpsuit: ["jumpsuit", "romper"], knit: ["sweater", "knit", "cardigan"],
    } },
    { key: "layer", weight: 1.8, values: { coat: ["coat", "trench", "puffer", "parka"], blazer: ["blazer", "jacket"], none: ["no jacket", "single layer"], vest: ["vest", "waistcoat"] } },
    { key: "silhouette", weight: 1.6, values: { oversized: ["oversized", "baggy"], fitted: ["fitted", "bodycon", "tailored"], wide: ["wide leg", "flare", "a-line"], straight: ["straight", "relaxed"] } },
    { key: "shoes", weight: 1, values: { sneakers: ["sneakers", "trainers"], boots: ["boots", "booties"], heels: ["heels", "pumps", "stilettos"], flats: ["flats", "loafers", "ballet"], sandals: ["sandals", "slides"] } },
  ],
  search_templates: { primary: ["{keyword}"], topup: ["{keyword} outfit", "{keyword} street style", "{keyword} outfit ideas"], negative: ["product listing", "shop now"] },
  constraint_specs: {},
  concept_fields: ["outfit_mode", "outfit_name", "hero_piece", "layers", "palette", "shoes", "accessories", "occasion", "audience", "season", "style", "silhouette", "body_context", "mood"],
  fact_block: {
    fields: ["hero_piece", "layers", "palette", "shoes", "silhouette"],
    note: "ключевая вещь и обувь обязательны в тексте секции",
    subject_label: "the outfit — garments, layers and shoes",
    photo_facts: PHOTO_FACT_DESCRIPTIONS.outfits,
  },
};

// ── ИНТЕРЬЕР (nicheProfile.ts:392-508) ──
const INTERIOR: NicheProfile = {
  niche_code: "interior",
  label: "Дизайн интерьеров",
  attributes: [
    { key: "decor_mode", label: "article intent mode", values: ["element", "room", "style"] },
    { key: "keyword_room", label: "room or outdoor zone", values: ["kitchen", "bathroom", "bedroom", "living room", "nursery", "home office", "hallway", "balcony", "dining room", "laundry", "closet", "studio apartment", "patio", "porch", "backyard", "garden", "front yard", "deck", "poolside", "none"] },
    { key: "keyword_hero_element", label: "hero element or project (gallery wall, rug, fire pit)" },
    { key: "keyword_setting_type", label: "indoor or outdoor", values: ["indoor", "outdoor", "none"] },
    { key: "keyword_occasion", label: "occasion / holiday" },
    { key: "keyword_zone", label: "zone / focal area" },
    { key: "keyword_style", label: "interior style" },
    { key: "keyword_palette", label: "colour palette" },
    { key: "keyword_materials", label: "key materials" },
    { key: "keyword_size", label: "space size", values: ["small", "compact", "medium", "large", "open plan", "none"] },
    { key: "keyword_budget", label: "budget level", values: ["budget", "mid", "luxury", "none"] },
    { key: "keyword_season", label: "season", values: ["summer", "fall", "winter", "spring", "none"] },
    { key: "keyword_setting", label: "setting" },
  ],
  required_visuals: [
    { label: "space", values: {
      kitchen: ["kitchen"], bathroom: ["bathroom", "bath"], bedroom: ["bedroom"], living: ["living room", "lounge"],
      nursery: ["nursery", "kids room"], office: ["home office", "study"], hallway: ["hallway", "entryway", "mudroom"],
      dining: ["dining room", "breakfast nook"], laundry: ["laundry room", "utility room"], closet: ["closet", "dressing room"],
      balcony: ["balcony", "terrace"], patio: ["patio"], porch: ["porch", "veranda"],
      backyard: ["backyard", "back garden", "yard"], garden: ["garden", "flower bed"], deck: ["deck", "decking"],
      "front yard": ["front yard", "curb appeal", "driveway"], poolside: ["poolside", "pool area"],
    } },
    { label: "style", values: {
      modern: ["modern", "contemporary"], boho: ["boho", "bohemian"], farmhouse: ["farmhouse", "rustic", "cottage"],
      scandi: ["scandinavian", "scandi", "nordic"], minimal: ["minimalist", "minimal"], japandi: ["japandi"],
      "mid-century": ["mid century", "mid-century"], coastal: ["coastal", "nautical"], industrial: ["industrial"],
      traditional: ["traditional", "classic"], mediterranean: ["mediterranean", "tuscan"], "art deco": ["art deco"],
    } },
    COLOUR_DICT,
  ],
  exclusive_terms: [
    {
      scope: "interior|room|kitchen|bathroom|bedroom|living|nursery|office|hallway|laundry|closet|decor",
      variants: [
        ["kitchen"], ["bathroom", "bath"], ["bedroom"], ["living room", "lounge"], ["nursery", "kids room"],
        ["home office", "study"], ["hallway", "entryway", "mudroom"], ["dining room"], ["laundry room", "utility room"],
        ["closet", "dressing room"],
      ],
    },
    {
      scope: "interior|decor|outdoor|patio|porch|backyard|yard|garden|balcony|deck|room|curb appeal",
      variants: [
        ["patio", "porch", "backyard", "yard", "garden", "balcony", "deck", "terrace", "outdoor", "curb appeal", "poolside"],
        ["living room", "bedroom", "kitchen", "bathroom", "hallway", "nursery", "home office", "indoor", "interior room"],
      ],
    },
  ],
  diversity_axes: [
    { key: "palette", weight: 2.6, values: COLOR_VOCAB },
    { key: "zone", weight: 2.2, values: {
      storage: ["shelves", "storage", "cabinet", "wardrobe"],
      seating: ["sofa", "seating", "armchair", "bench", "outdoor sofa", "bistro set"],
      bed: ["bed", "headboard", "bedding"],
      worktop: ["counter", "worktop", "island", "backsplash"],
      lighting: ["lighting", "lamp", "pendant", "sconce", "string lights", "lantern"],
      wall: ["wall", "gallery wall", "paneling", "wallpaper", "fence", "privacy screen"],
      greenery: ["plants", "planters", "raised beds", "garden beds", "hanging baskets"],
      dining: ["dining table", "table setting", "tablescape", "outdoor dining"],
      fire: ["fire pit", "fireplace", "mantel", "chiminea"],
    } },
    { key: "style", weight: 2, values: {
      modern: ["modern", "contemporary"], boho: ["boho", "bohemian"], farmhouse: ["farmhouse", "rustic"],
      scandi: ["scandinavian", "scandi"], minimal: ["minimalist"], japandi: ["japandi"],
      "mid-century": ["mid century"], coastal: ["coastal"], industrial: ["industrial"],
    } },
    { key: "material", weight: 1.6, values: {
      wood: ["wood", "oak", "walnut", "timber"], stone: ["stone", "marble", "granite", "terrazzo"],
      metal: ["brass", "metal", "steel", "chrome"], textile: ["linen", "velvet", "rattan", "boucle"],
      tile: ["tile", "zellige", "subway"],
    } },
    { key: "angle", weight: 1.2, values: { wide: ["wide shot", "full room", "overall view"], detail: ["close up", "detail", "vignette"], corner: ["corner", "nook"] } },
    { key: "light", weight: 1, values: { day: ["daylight", "morning light", "bright"], evening: ["evening", "dusk", "lit up", "night", "lamplight"] } },
  ],
  search_templates: {
    primary: ["{keyword}"],
    topup: ["{keyword} real home", "{keyword} decor ideas", "{keyword} photo", "{keyword} inspiration"],
    negative: ["3d render", "3d rendering", "cgi", "ai generated", "floor plan", "for sale listing", "real estate listing", "watermark", "collage", "mood board", "clipart", "product cutout"],
  },
  constraint_specs: {},
  concept_fields: [
    "decor_mode", "design_name", "hero_element", "room", "zone", "setting", "style", "palette", "materials",
    "key_elements", "layout_detail", "lighting_detail", "shopping_cue", "real_experience",
    "difficulty", "renter_friendly", "best_for", "mood", "budget", "season",
  ],
  fact_block: {
    fields: ["room", "hero_element", "zone", "style", "palette", "materials", "layout_detail", "lighting_detail"],
    note: "комната или уличная зона, главный предмет и стиль обязательны в тексте секции; размеры — только из брифа",
    subject_label: "the space and its decor",
    photo_facts: PHOTO_FACT_DESCRIPTIONS.interior,
  },
};

// ── ДЕКОР (подниша интерьера, nicheProfile.ts:511-523) ──
const DECOR: NicheProfile = {
  ...INTERIOR,
  niche_code: "decor",
  label: "Декор и предметы",
  search_templates: { ...INTERIOR.search_templates, topup: ["{keyword} real home", "{keyword} styling ideas", "{keyword} photo", "{keyword} inspiration"] },
  fact_block: { ...INTERIOR.fact_block, subject_label: "the decor element and the space around it" },
};

// ── УЛИЦА И ДВОР (подниша интерьера, nicheProfile.ts:526-544) ──
const OUTDOOR: NicheProfile = {
  ...INTERIOR,
  niche_code: "outdoor",
  label: "Улица и двор",
  search_templates: {
    primary: ["{keyword}"],
    topup: ["{keyword} real backyard", "{keyword} patio photo", "{keyword} outdoor decor ideas", "{keyword} inspiration"],
    negative: [...(INTERIOR.search_templates.negative || []), "landscape architecture drawing", "site plan", "catalog"],
  },
  fact_block: {
    ...INTERIOR.fact_block,
    note: "уличная зона, главный предмет и материалы обязательны; погодостойкость и уход — только из брифа",
    subject_label: "the outdoor space and its decor",
  },
};

// ── ТАТУ (nicheProfile.ts:547-642) ──
const TATTOO: NicheProfile = {
  niche_code: "tattoo",
  label: "Татуировки",
  attributes: [
    { key: "keyword_placement", label: "body placement", values: ["forearm", "upper arm", "sleeve", "shoulder", "back", "spine", "chest", "ribs", "thigh", "calf", "ankle", "wrist", "hand", "finger", "neck", "collarbone", "none"] },
    { key: "keyword_tattoo_style", label: "tattoo style", values: ["fine line", "blackwork", "realism", "watercolour", "geometric", "tribal", "minimalist", "traditional", "neo-traditional", "illustrative", "lettering", "dotwork", "none"] },
    { key: "keyword_tattoo_size", label: "size", values: ["micro", "small", "medium", "large", "full sleeve", "none"] },
    { key: "keyword_tattoo_subject", label: "subject / motif" },
    { key: "keyword_color_mode", label: "colour mode", values: ["black and grey", "colour", "single needle black", "none"] },
    { key: "keyword_aesthetic", label: "aesthetic" },
    { key: "keyword_age", label: "age group", values: ["teen", "20s", "30s", "40s", "50s", "mature", "none"] },
    { key: "keyword_setting", label: "setting" },
  ],
  required_visuals: [
    { label: "placement", values: {
      forearm: ["forearm"], arm: ["upper arm", "bicep", "sleeve"], shoulder: ["shoulder"], back: ["back", "spine"],
      chest: ["chest", "sternum"], ribs: ["ribs", "side"], thigh: ["thigh"], calf: ["calf", "leg"],
      ankle: ["ankle"], wrist: ["wrist"], hand: ["hand", "finger"], neck: ["neck", "collarbone"],
    } },
    { label: "style", values: {
      "fine line": ["fine line", "single needle"], blackwork: ["blackwork", "solid black"],
      realism: ["realism", "realistic", "portrait"], watercolour: ["watercolour", "watercolor"],
      geometric: ["geometric"], minimalist: ["minimalist", "minimal"], traditional: ["traditional", "americana"],
      lettering: ["lettering", "script", "quote"], dotwork: ["dotwork", "stippling"],
    } },
    { label: "colour mode", values: { "black and grey": ["black and grey", "black and gray", "blackwork"], colour: ["colour", "color", "vibrant"] } },
  ],
  exclusive_terms: [
    { scope: "tattoo|ink|tatt", variants: [["sketch", "drawing", "flash sheet", "stencil", "paper", "design sheet"], ["tattoo", "tattooed", "inked", "skin", "healed"]] },
    { scope: "tattoo|ink", variants: [["forearm", "wrist", "hand", "arm", "sleeve"], ["thigh", "calf", "ankle", "leg"], ["back", "spine"], ["chest", "sternum", "ribs"]] },
  ],
  diversity_axes: [
    { key: "placement", weight: 2.8, values: {
      forearm: ["forearm"], arm: ["upper arm", "bicep", "sleeve"], shoulder: ["shoulder"],
      back: ["back", "spine"], chest: ["chest", "sternum"], ribs: ["ribs"], leg: ["thigh", "calf", "ankle"],
      hand: ["hand", "wrist", "finger"], neck: ["neck", "collarbone"],
    } },
    { key: "style", weight: 2.4, values: {
      "fine line": ["fine line", "single needle"], blackwork: ["blackwork"], realism: ["realism", "realistic"],
      watercolour: ["watercolour", "watercolor"], geometric: ["geometric"], traditional: ["traditional"],
      lettering: ["lettering", "script"], dotwork: ["dotwork"],
    } },
    { key: "size", weight: 1.8, values: { micro: ["micro", "tiny"], small: ["small"], medium: ["medium"], large: ["large", "full sleeve", "big"] } },
    { key: "subject", weight: 2, values: {
      floral: ["flower", "floral", "rose", "peony", "botanical"],
      animal: ["snake", "butterfly", "bird", "wolf", "lion", "moth"],
      celestial: ["moon", "star", "sun", "celestial"],
      abstract: ["abstract", "line art", "shapes"],
      symbol: ["symbol", "rune", "cross", "heart"],
    } },
    { key: "color", weight: 1.4, values: { black: ["black and grey", "black and gray", "black ink"], colour: ["colour", "color", "vibrant"] } },
  ],
  search_templates: { primary: ["{keyword}"], topup: ["{keyword} tattoo", "{keyword} tattoo ideas", "{keyword} healed tattoo"], negative: ["tattoo stencil", "flash sheet", "temporary tattoo"] },
  constraint_specs: {},
  concept_fields: ["subject", "style", "placement", "size", "colour_mode", "mood", "meaning"],
  fact_block: {
    fields: ["subject", "style", "placement", "size", "colour_mode"],
    note: "стиль и место на теле обязательны в тексте секции",
    subject_label: "the tattoo itself",
    photo_facts: PHOTO_FACT_DESCRIPTIONS.tattoo,
  },
};

// ── МАКИЯЖ (nicheProfile.ts:645-730) ──
const MAKEUP: NicheProfile = {
  niche_code: "makeup",
  label: "Макияж",
  attributes: [
    { key: "keyword_makeup_type", label: "makeup type (eye look, full face, lip look…)" },
    { key: "keyword_eye_technique", label: "eye technique", values: ["smokey", "cut crease", "graphic liner", "winged liner", "halo", "siren eyes", "no liner", "none"] },
    { key: "keyword_palette", label: "colour palette" },
    { key: "keyword_finish", label: "finish", values: ["matte", "glowy", "dewy", "satin", "glitter", "none"] },
    { key: "keyword_intensity", label: "intensity", values: ["natural", "soft", "bold", "dramatic", "none"] },
    { key: "keyword_occasion", label: "occasion" },
    { key: "keyword_skin_tone", label: "skin tone", values: ["dark", "brown", "light", "fair", "olive", "tan", "none"] },
    { key: "keyword_eye_shape", label: "eye shape", values: ["hooded", "almond", "round", "monolid", "downturned", "none"] },
    { key: "keyword_age", label: "age group", values: ["teen", "20s", "30s", "40s", "50s", "60s", "mature", "none"] },
    { key: "keyword_season", label: "season", values: ["summer", "fall", "winter", "spring", "none"] },
  ],
  required_visuals: [
    { label: "focus", values: { eyes: ["eye look", "eyeshadow", "liner", "lashes"], lips: ["lip", "lipstick", "lip liner"], "full face": ["full face", "full glam", "base", "foundation"], blush: ["blush", "cheeks", "contour"] } },
    { label: "technique", values: { smokey: ["smokey", "smoky"], "cut crease": ["cut crease"], graphic: ["graphic liner", "graphic"], winged: ["winged", "wing liner", "cat eye"], halo: ["halo"] } },
    { label: "finish", values: { matte: ["matte"], glowy: ["glowy", "dewy", "glass skin"], glitter: ["glitter", "shimmer", "metallic"] } },
    COLOUR_DICT,
  ],
  exclusive_terms: [
    { scope: "makeup|make-up|eyeshadow|lipstick|liner|glam", variants: [["natural", "no makeup", "soft", "minimal"], ["bold", "dramatic", "full glam", "graphic"]] },
    { scope: "makeup|eyeshadow|liner", variants: [["nail", "nails", "manicure"], ["makeup", "eyeshadow", "lipstick", "liner", "glam"]] },
  ],
  diversity_axes: [
    { key: "color", weight: 2.8, values: COLOR_VOCAB },
    { key: "focus", weight: 2.4, values: { eyes: ["eye look", "eyeshadow", "liner", "lashes"], lips: ["lip", "lipstick"], "full face": ["full face", "full glam", "base"], cheeks: ["blush", "cheeks", "contour"] } },
    { key: "technique", weight: 2, values: { smokey: ["smokey", "smoky"], "cut crease": ["cut crease"], graphic: ["graphic liner"], winged: ["winged", "cat eye"], halo: ["halo"], soft: ["soft wash", "diffused", "blurred"] } },
    { key: "finish", weight: 1.6, values: { matte: ["matte"], glowy: ["glowy", "dewy", "glass"], glitter: ["glitter", "shimmer", "metallic"] } },
    { key: "intensity", weight: 1.2, values: { natural: ["natural", "everyday", "no makeup"], bold: ["bold", "dramatic", "full glam"] } },
  ],
  search_templates: { primary: ["{keyword}"], topup: ["{keyword} makeup", "{keyword} makeup look", "{keyword} close up"], negative: ["product swatch on paper", "palette only"] },
  constraint_specs: {},
  concept_fields: ["look_name", "focus", "technique", "palette", "finish", "intensity", "occasion", "who_it_suits"],
  fact_block: {
    fields: ["focus", "technique", "palette", "finish", "intensity"],
    note: "техника и палитра обязательны в тексте секции",
    subject_label: "the makeup look",
    photo_facts: PHOTO_FACT_DESCRIPTIONS.makeup,
  },
};

// оригинал: nicheProfile.ts:732-760
export const DEFAULT_NICHE_PROFILES: Record<string, NicheProfile> = {
  nails: NAILS,
  manicure: { ...NAILS, niche_code: "manicure", label: "Маникюр" },
  pedicure: { ...NAILS, niche_code: "pedicure", label: "Педикюр" },
  hair: HAIR,
  outfits: OUTFITS,
  interior: INTERIOR,
  decor: DECOR,
  outdoor: OUTDOOR,
  tattoo: TATTOO,
  makeup: MAKEUP,
  blog: {
    niche_code: "blog",
    label: "Блоговая статья",
    attributes: [
      { key: "keyword_topic", label: "main topic" },
      { key: "keyword_aesthetic", label: "aesthetic / mood" },
      { key: "keyword_season", label: "season", values: ["summer", "fall", "winter", "spring", "none"] },
      { key: "keyword_setting", label: "setting" },
    ],
    required_visuals: [COLOUR_DICT],
    exclusive_terms: [],
    diversity_axes: [{ key: "color", weight: 2, values: COLOR_VOCAB }],
    search_templates: { primary: ["{keyword}"], topup: ["{keyword} ideas", "{keyword} photo"] },
    constraint_specs: {},
    concept_fields: ["title", "angle", "mood", "key_points"],
    fact_block: { fields: [], subject_label: "the subject of the topic" },
  },
};

/** Поле из таблицы перекрывает код, только если оно непустое (оригинал: mergeProfile). */
function mergeProfile(base: NicheProfile, row: { label?: string | null; profile?: unknown } | null): NicheProfile {
  if (!row) return base;
  const p = (row.profile && typeof row.profile === "object" ? row.profile : {}) as Record<string, unknown>;
  const pick = <K extends keyof NicheProfile>(key: K, val: unknown): NicheProfile[K] => {
    if (val == null) return base[key];
    if (Array.isArray(val)) return (val.length ? val : base[key]) as NicheProfile[K];
    if (typeof val === "object") return (Object.keys(val as object).length ? val : base[key]) as NicheProfile[K];
    return val as NicheProfile[K];
  };
  return {
    niche_code: base.niche_code,
    label: row.label || base.label,
    attributes: pick("attributes", p.attributes),
    required_visuals: pick("required_visuals", p.required_visuals),
    exclusive_terms: pick("exclusive_terms", p.exclusive_terms),
    diversity_axes: pick("diversity_axes", p.diversity_axes),
    search_templates: pick("search_templates", p.search_templates),
    constraint_specs: pick("constraint_specs", p.constraint_specs),
    concept_fields: pick("concept_fields", p.concept_fields),
    fact_block: pick("fact_block", p.fact_block),
  };
}

/** Дефолтный профиль по коду ниши/подниши (без обращения к базе): подниша → ниша → nails. */
export function defaultProfile(niche?: string | null, subniche?: string | null): NicheProfile {
  const sub = subniche ? DEFAULT_NICHE_PROFILES[String(subniche)] : undefined;
  if (sub) return sub;
  const n = niche ? DEFAULT_NICHE_PROFILES[String(niche)] : undefined;
  return n || DEFAULT_NICHE_PROFILES.nails;
}

/** Кеш профилей с TTL — в долгоживущем воркере правки таблицы подхватываются без перезапуска (аудит 02, п.7.16). */
const PROFILE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; profile: NicheProfile }>();

/**
 * Профиль ниши: подниша перекрывает нишу, таблица ArtNicheProfile перекрывает код (по непустым полям).
 * Никогда не бросает — при ошибке базы возвращает встроенный профиль.
 */
export async function getNicheProfile(nicheCode?: string | null, subnicheCode?: string | null): Promise<NicheProfile> {
  const codes = [subnicheCode, nicheCode].filter(Boolean).map(String);
  const cacheKey = codes.join(">") || "default";
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;

  const base = defaultProfile(nicheCode, subnicheCode);
  let profile = base;
  try {
    if (codes.length) {
      const rows = await prisma.artNicheProfile.findMany({ where: { nicheCode: { in: codes }, isActive: true } });
      const row = codes.map((c) => rows.find((r) => r.nicheCode === c)).find(Boolean);
      if (row) profile = mergeProfile(base, { label: row.label, profile: row.profile });
    }
  } catch (e) {
    console.warn("[nicheProfile] fallback to defaults:", (e as Error).message);
  }
  cache.set(cacheKey, { at: Date.now(), profile });
  return profile;
}

/** Имя оригинала — для кода, который переносится дословно. */
export const loadNicheProfile = getNicheProfile;

/** Список полей признаков профиля — используется при чтении keyword_attributes. */
export function attributeKeys(profile: NicheProfile): string[] {
  return profile.attributes.map((a) => a.key);
}

/** Короткая сводка признаков темы для промтов ("shape: almond; length: short"). */
export function describeAttributes(profile: NicheProfile, attrs: Record<string, unknown> | null | undefined): string {
  if (!attrs) return "";
  const out: string[] = [];
  for (const a of profile.attributes) {
    const v = attrs[a.key];
    if (!v || v === "none") continue;
    out.push(`${a.label.split(" (")[0]}: ${String(v)}`);
  }
  return out.join("; ");
}

/**
 * Поля фактов для оценки фото — список-инструкция («- craft: что описать»), без примеров «(e.g. …)».
 * Аудит text-v3: раньше описания стояли прямо внутри образца JSON (`"facts":{"craft": visible execution quality…}`),
 * и модель копировала их как значения. Теперь образец JSON — только пустой скелет (photoFactSkeleton),
 * а описания идут отдельным списком с запретом копировать (photoFactRules).
 */
export function photoFactFields(profile: NicheProfile): string {
  return factFieldGuide(profile.fact_block?.photo_facts);
}

/** Правило заполнения фактов для промтов оценки/описания фото: список полей + запрет копировать инструкцию. */
export function photoFactRules(profile: NicheProfile): string {
  return (
    `FACT FIELDS — for each field write the VALUE you actually SEE in THIS photo, 1-8 plain words (a shade, a shape, a placement), different photos get different values.\n` +
    `The text after each field name is an instruction for you, never a value: do not copy it, its examples or its option lists.\n` +
    `Not visible or not applicable → "" (never "none", "n/a", "any" or "visible").\n` +
    photoFactFields(profile)
  );
}

/** Пустой объект фактов для примера JSON в промте. */
export function photoFactSkeleton(profile: NicheProfile): string {
  const keys = Object.keys(profile.fact_block?.photo_facts || {});
  const list = keys.length ? keys : ["description_facts"];
  return list.map((k) => `"${k}":""`).join(",");
}

/** Факты фото без заглушек и копий описаний полей профиля (перед записью и перед использованием). */
export function sanitizePhotoFacts(raw: unknown, profile?: NicheProfile | null, keys?: string[]): Record<string, string> | null {
  return sanitizeFacts(raw, profile?.fact_block?.photo_facts ?? null, keys);
}

/** Как называть предмет статьи в промтах. */
export function subjectLabel(profile: NicheProfile): string {
  return profile.fact_block?.subject_label || "the subject of the topic";
}

// ── Тип темы внутри ниши волос: стрижка / цвет / причёска (nicheProfile.ts:877-1033) ──
export type HairTopicKind = "cut" | "colour" | "style";

const HAIR_CUT_WORDS = [
  "haircut", "hair cut", "cut", "cuts", "bob", "lob", "pixie", "bixie", "shag", "shaggy",
  "layers", "layered", "fringe", "bangs", "crop", "cropped", "buzz", "mullet", "wolf cut",
  "butterfly cut", "blunt", "undercut", "taper", "trim", "face framing", "curtain bangs",
  "hairstyles for", "short hair", "long hair", "medium hair", "shoulder length",
];
const HAIR_COLOUR_WORDS = [
  "color", "colour", "colors", "colours", "balayage", "highlights", "babylights", "lowlights",
  "ombre", "money piece", "root shadow", "foilyage", "blonde", "blond", "brunette", "brown hair",
  "black hair", "red hair", "auburn", "copper", "ginger", "platinum", "ash", "caramel", "honey",
  "bronde", "dye", "dyed", "toner", "hair dye", "tint", "melt", "dimensional",
];
const HAIR_STYLE_WORDS = [
  "hairstyle", "hairstyles", "updo", "up do", "bun", "chignon", "topknot", "ponytail", "pony",
  "braid", "braids", "braided", "plait", "cornrow", "twist", "twists", "knotless", "space buns",
  "half up", "blowout", "curls", "curled", "waves", "wavy style", "sleek", "slicked",
  "wedding hair", "bridal", "prom hair", "updos", "protective style", "locs", "wash and go",
];

function scoreWords(text: string, words: string[]): number {
  let score = 0;
  for (const w of words) if (text.includes(w)) score += w.includes(" ") ? 2 : 1;
  return score;
}

/** Тип темы волос по ключу/теме. По умолчанию — стрижка. */
export function hairTopicKind(topicText?: string | null): HairTopicKind {
  const t = String(topicText || "").toLowerCase();
  if (!t.trim()) return "cut";
  const scores: [HairTopicKind, number][] = [
    ["cut", scoreWords(t, HAIR_CUT_WORDS)],
    ["colour", scoreWords(t, HAIR_COLOUR_WORDS)],
    ["style", scoreWords(t, HAIR_STYLE_WORDS)],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : "cut";
}

const HAIR_STYLING_DICT: AttributeDict = {
  label: "styling",
  values: {
    updo: ["updo", "bun", "chignon", "topknot"],
    braid: ["braid", "braids", "plait", "cornrow", "twist"],
    ponytail: ["ponytail", "pony"],
    down: ["blowout", "loose", "worn down", "half up", "curls", "waves"],
    sleek: ["sleek", "slicked", "wet look"],
  },
};

const HAIR_TECHNIQUE_AXIS: DiversityAxis = {
  key: "technique",
  weight: 3,
  values: {
    balayage: ["balayage", "foilyage"],
    highlights: ["highlights", "babylights", "lowlights"],
    ombre: ["ombre", "melt", "gradient"],
    "money piece": ["money piece", "face frame"],
    solid: ["single process", "all over", "solid"],
  },
};

const HAIR_KIND_LABEL: Record<HairTopicKind, string> = {
  cut: "haircut (shape, length, layers, bangs)",
  colour: "hair colour (base shade, colouring technique, tone)",
  style: "hairstyle / styling (how the hair is worn and how it holds)",
};

/** Человеко-читаемый тип темы для промтов ({topic_kind}); для не-волос — пусто. */
export function topicKindLabel(profile: NicheProfile, topicText?: string | null): string {
  if (profile.niche_code !== "hair") return "";
  return HAIR_KIND_LABEL[hairTopicKind(topicText)];
}

function weighAxes(axes: DiversityAxis[], weights: Record<string, number>): DiversityAxis[] {
  return axes.map((a) => (weights[a.key] != null ? { ...a, weight: weights[a.key] } : a));
}

/** Уточняет профиль под конкретную тему. Работает для волос (стрижка / цвет / причёска); остальные ниши — без изменений. */
export function specializeProfile(profile: NicheProfile, topicText?: string | null): NicheProfile {
  if (profile.niche_code !== "hair") return profile;
  const kind = hairTopicKind(topicText);
  const byLabel = (label: string) => profile.required_visuals.find((v) => v.label === label);
  const colour = byLabel("colour") || COLOUR_DICT;
  const length = byLabel("length");
  const texture = byLabel("texture");
  const bangs = byLabel("bangs");
  const technique = byLabel("technique");
  const keep = (...items: (AttributeDict | undefined)[]) => items.filter(Boolean) as AttributeDict[];

  if (kind === "colour") {
    return {
      ...profile,
      required_visuals: keep(colour, technique, length),
      diversity_axes: weighAxes([...profile.diversity_axes, HAIR_TECHNIQUE_AXIS], { color: 3.4, length: 1.6, texture: 1.6, styling: 1.2, bangs: 0.8 }),
      search_templates: { ...profile.search_templates, topup: ["{keyword} hair color", "{keyword} hair", "{keyword} balayage"] },
      concept_fields: ["colour", "technique", "tone", "length", "texture", "who_it_suits", "upkeep", "mood"],
      fact_block: {
        ...profile.fact_block,
        fields: ["colour", "technique", "tone", "length", "texture"],
        note: "базовый цвет, техника окрашивания и глубина тона обязательны в тексте секции",
        subject_label: "the hair colour — base shade, technique and tone",
      },
    };
  }
  if (kind === "style") {
    return {
      ...profile,
      required_visuals: keep(HAIR_STYLING_DICT, length, texture, colour),
      diversity_axes: weighAxes(profile.diversity_axes, { styling: 3.2, texture: 2.2, length: 1.6, color: 1.4, bangs: 1 }),
      search_templates: { ...profile.search_templates, topup: ["{keyword} hairstyle", "{keyword} hair", "{keyword} back view"] },
      concept_fields: ["styling", "length", "texture", "finish", "who_it_suits", "occasion", "hold", "mood"],
      fact_block: {
        ...profile.fact_block,
        fields: ["styling", "length", "texture", "colour", "hold"],
        note: "тип укладки и то, как она держится, обязательны в тексте секции",
        subject_label: "the hairstyle — how the hair is worn",
      },
    };
  }
  return {
    ...profile,
    required_visuals: keep(length, texture, bangs, colour),
    diversity_axes: weighAxes(profile.diversity_axes, { length: 3.2, texture: 2.6, bangs: 2, styling: 1.4, color: 1.4 }),
    search_templates: { ...profile.search_templates, topup: ["{keyword} haircut", "{keyword} hair", "{keyword} back view"] },
    concept_fields: ["cut", "length", "layers", "bangs", "texture", "who_it_suits", "upkeep", "mood"],
    fact_block: {
      ...profile.fact_block,
      fields: ["cut", "length", "layers", "bangs", "texture"],
      note: "форма стрижки, длина и чёлка обязательны в тексте секции",
      subject_label: "the haircut — shape, length, layers and bangs",
    },
  };
}
