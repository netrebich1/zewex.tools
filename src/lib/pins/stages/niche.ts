/**
 * Авто-определение ниши по ключу / заголовку / URL (порт legacy src/lib/nicheDetect.ts).
 *
 * Используется, когда на шаге 2 ниша страницы не была задана вручную.
 * Логика простая и предсказуемая: каждая ниша описана большим словарём
 * слов-маркеров, побеждает ниша с наибольшим весом совпадений.
 */

export type NicheId = "decor" | "nails" | "hair" | "outfit" | "cooking";

/** Словари маркеров. Все слова в нижнем регистре, латиница + кириллица. */
const WORDS: Record<NicheId, string[]> = {
  nails: [
    "nail", "nails", "manicure", "pedicure", "gel polish", "gel nails", "acrylic",
    "almond nails", "coffin nails", "stiletto nails", "square nails", "french tip",
    "french manicure", "chrome nails", "ombre nails", "nail art", "nail design",
    "nail ideas", "nail colors", "nail inspo", "press on", "dip powder", "cuticle",
    "matte nails", "glitter nails", "aura nails", "polish", "shellac",
    "ногт", "маникюр", "педикюр", "гель-лак", "нігт", "манікюр",
  ],
  hair: [
    "hair", "hairstyle", "hairstyles", "haircut", "haircuts", "bob", "lob", "pixie",
    "bangs", "fringe", "balayage", "highlights", "ombre hair", "braid", "braids",
    "curls", "curly hair", "updo", "ponytail", "bun", "blonde", "brunette", "brownette",
    "hair color", "hair colour", "hair ideas", "wolf cut", "shag", "layered hair",
    "extensions", "wig", "blowout", "waves",
    "волос", "причёск", "прическ", "стрижк", "окрашивани", "коса", "косы", "зачіск", "волосс",
  ],
  outfit: [
    "outfit", "outfits", "ootd", "fashion", "style guide", "capsule wardrobe", "wardrobe",
    "dress", "dresses", "jeans", "denim", "skirt", "blouse", "sweater", "cardigan",
    "coat", "jacket", "blazer", "trousers", "pants", "shoes", "boots", "sneakers",
    "heels", "handbag", "bag outfit", "accessories", "streetwear", "look", "lookbook",
    "casual", "workwear", "party outfit", "wedding guest", "trend", "trends",
    "одежд", "образ", "лук", "наряд", "платье", "джинс", "юбк", "гардероб", "мода", "стиль одежды",
    "одяг", "сукн",
  ],
  cooking: [
    "recipe", "recipes", "food", "meal", "meals", "dinner", "lunch", "breakfast",
    "brunch", "dessert", "desserts", "cake", "cakes", "cookies", "cupcake", "pie",
    "bread", "pasta", "soup", "salad", "smoothie", "drink", "drinks", "cocktail",
    "snack", "snacks", "appetizer", "casserole", "crockpot", "slow cooker", "air fryer",
    "keto", "vegan", "vegetarian", "gluten free", "low carb", "high protein", "meal prep",
    "baking", "bake", "roast", "grill", "sauce", "chicken", "beef", "pork", "shrimp",
    "рецепт", "блюд", "выпечк", "десерт", "торт", "салат", "суп", "завтрак", "ужин",
    "закуск", "напит", "готов", "страв", "їж", "вечер",
  ],
  decor: [
    "decor", "decoration", "decorations", "interior", "home", "house", "room",
    "living room", "bedroom", "kitchen decor", "bathroom", "nursery", "apartment",
    "farmhouse", "boho", "minimalist home", "cozy", "aesthetic room", "wall art",
    "gallery wall", "shelf", "shelves", "furniture", "sofa", "rug", "curtains",
    "lighting", "lamp", "candles", "table setting", "tablescape", "centerpiece",
    "porch", "patio", "garden", "backyard", "front door", "wreath", "mantel",
    "christmas decor", "halloween decor", "diy", "organization", "storage",
    "декор", "интерьер", "інтер", "комнат", "кімнат", "спальн", "кухн", "гостин",
    "дом", "квартир", "сад", "двор", "мебел", "меблі", "уют",
  ],
};

/** Слова с высоким весом — однозначно определяют нишу. */
const STRONG: Partial<Record<NicheId, string[]>> = {
  nails: ["nail", "nails", "manicure", "ногт", "маникюр"],
  hair: ["hairstyle", "haircut", "hair color", "волос", "причёск", "прическ", "стрижк"],
  outfit: ["outfit", "outfits", "ootd", "одежд", "образ"],
  cooking: ["recipe", "recipes", "рецепт"],
  decor: ["decor", "interior", "декор", "интерьер"],
};

const NICHES: NicheId[] = ["nails", "hair", "outfit", "cooking", "decor"];

const normalize = (s: string) =>
  String(s || "")
    .toLowerCase()
    .replace(/[_\-/]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

export interface NicheGuess {
  niche: NicheId;
  score: number;
  /** true — совпадений не нашлось, вернули fallback. */
  fallback: boolean;
  matches: string[];
}

/**
 * Определяет нишу по произвольному тексту (ключ + заголовок + h1 + URL).
 * `fallback` — ниша по умолчанию, если ничего не совпало.
 */
export function detectNiche(text: string, fallback: NicheId = "decor"): NicheGuess {
  const hay = normalize(text);
  if (!hay) return { niche: fallback, score: 0, fallback: true, matches: [] };

  let best: NicheGuess = { niche: fallback, score: 0, fallback: true, matches: [] };
  for (const niche of NICHES) {
    const matches: string[] = [];
    let score = 0;
    for (const w of WORDS[niche]) {
      if (!hay.includes(w)) continue;
      const strong = (STRONG[niche] || []).includes(w);
      score += strong ? 6 : w.includes(" ") ? 3 : 2;
      matches.push(w);
    }
    if (score > best.score) best = { niche, score, fallback: false, matches };
  }
  return best;
}

/** Определение ниши для страницы прогона: ручное значение важнее авто. */
export function detectPageNiche(
  page: { niche?: string | null; keyword?: string | null; page_title?: string | null; h1?: string | null; url?: string | null; topic?: string | null },
  fallback: NicheId = "decor",
): { niche: NicheId; auto: boolean } {
  const manual = String(page.niche || "").trim().toLowerCase();
  if (manual && (NICHES as string[]).includes(manual)) return { niche: manual as NicheId, auto: false };

  const text = [page.keyword, page.page_title, page.h1, page.topic, page.url]
    .filter(Boolean)
    .join(" ");
  const guess = detectNiche(text, fallback);
  return { niche: guess.niche, auto: true };
}
