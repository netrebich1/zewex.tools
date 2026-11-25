/**
 * Чистка фактов фото (аудит текстов, раунд 3 — text-v3.md, §3 и §4 п.1).
 * Модель оценки фото копировала в значения описания полей схемы: у 20 из 57 фото ногтей прогона bf37757f
 * `craft` = «visible execution quality — line cleanliness, cuticle work, evenness», у части — `craft: "visible"`,
 * `occasion: "none" | "any"`. Эти «значения» уходили автору как факты и в хвосты H2 («…, The Single Detail
 * A Reader Notices First», «…, None»).
 *
 * Здесь чистые функции без базы: их зовут и при записи фактов (ranking.cleanFacts, photoDescribe), и при чтении
 * (factsLine для автора, хвосты H2 в textGuards) — старые записи в базе чистятся на лету.
 * Описания полей по умолчанию лежат здесь (их же использует профиль ниши), профиль из базы может передать свои.
 */

/** Поля фактов фото по нишам: имя → что описывать (инструкция модели, НЕ образец значения). */
export const PHOTO_FACT_DESCRIPTIONS: Record<string, Record<string, string>> = {
  nails: {
    colors: "main shade + accent shades + any gradient/ombre direction",
    shape_length: "nail shape and length (e.g. \"medium almond\")",
    finish: "glossy / matte / shimmer / chrome / jelly / cat-eye / glitter density",
    decor: "placement of art — french tips, lines, dots, foil, rhinestones, stickers, and on WHICH nails it sits",
    craft: "visible execution quality — line cleanliness, cuticle work, evenness",
    difficulty: "\"diy\" | \"salon\" | \"salon-leaning\" + why in a few words",
    framing: "what the shot shows — one hand, both hands, close macro, hand + toes",
    occasion: "season / event the design reads as, only if visible in the design itself",
    standout: "the single detail a reader notices first",
  },
  hair: {
    cut: "haircut family and shape (pixie, bob, lob, layers, shag…)",
    length: "where the hair ends (ear, chin, collarbone, shoulder, mid-back)",
    texture: "straight / wavy / curly / coily, plus density (fine, thick)",
    colour: "base colour + any dimension (highlights, balayage, money piece, root shadow)",
    styling: "how it is styled — blowout, braids, updo, ponytail, wet look, air dried",
    bangs: "bangs type or \"no bangs\"",
    parting: "middle / side / zig-zag / slicked back",
    difficulty: "\"diy\" | \"salon\" | \"salon-leaning\" + why in a few words",
    framing: "what the shot shows — front, side, back view, close crop",
    standout: "the single detail a reader notices first",
  },
  outfits: {
    hero_piece: "the garment that defines the look",
    layers: "every visible layer top to bottom",
    palette: "main colours and how they combine",
    silhouette: "fit and shape (oversized, fitted, wide leg, a-line)",
    fabrics: "visible fabrics and textures",
    shoes: "shoe type and colour",
    accessories: "bag, belt, jewellery, hat — only if visible",
    occasion: "where the look reads as appropriate",
    framing: "full body, three-quarter, detail crop",
    standout: "the single detail a reader notices first",
  },
  interior: {
    room: "which room or outdoor zone the photo shows (kitchen, patio, porch, backyard…)",
    setting: "indoor or outdoor",
    hero_element: "the element the frame is really about (gallery wall, rug, fire pit, bedding…)",
    style: "interior style (modern, boho, farmhouse, scandi, japandi…)",
    palette: "wall, cabinetry, textile and planting colours",
    materials: "visible materials and finishes (oak, marble, brass, linen, tile, rattan, stone)",
    key_pieces: "the defining furniture, fixtures or plants",
    lighting: "light sources and how the space is lit, day or evening",
    layout: "how the space is organised, storage solutions, placement of the hero element",
    size_feel: "compact / roomy / open plan, only if visible",
    framing: "wide room shot, corner, detail vignette, outdoor wide view",
    standout: "the single detail a reader notices first",
  },
  tattoo: {
    subject: "what the tattoo depicts",
    style: "tattoo style (fine line, blackwork, realism, geometric…)",
    placement: "exact body placement and orientation",
    size: "micro / small / medium / large relative to the body part",
    colour_mode: "black and grey / colour, and which colours",
    linework: "line weight, shading, dotwork, saturation",
    healed: "fresh or healed, if visible",
    framing: "close crop, full placement, body in frame",
    standout: "the single detail a reader notices first",
  },
  makeup: {
    focus: "what the look is built around — eyes, lips, cheeks, full face",
    technique: "eye/lip technique used (smokey, cut crease, graphic liner, overlined lips)",
    palette: "shades used and where they sit",
    finish: "matte / glowy / dewy / glitter, on skin and on eyes",
    intensity: "natural / soft / bold / dramatic",
    lashes_brows: "lash and brow treatment, if visible",
    base: "skin finish and coverage, if visible",
    framing: "close eye crop, face front, three-quarter",
    standout: "the single detail a reader notices first",
  },
};

/** Значения-заглушки: «none», «n/a», «visible», «any», «...», «<value>» и т.п. */
const PLACEHOLDER_RE =
  /^(?:none|none visible|nothing|n\/?a|na|nil|null|undefined|unknown|unclear|not visible|not shown|not applicable|not specified|unspecified|no detail|no details|any|all|various|varies|visible|not sure|see description|same as above|tbd|tbc|value|string|text|\.{2,}|…|-+|—|–|\?+|""|'')\.?$/i;
/** Обрывки схемы внутри значения: так модель не описывает кадр, так пишется инструкция. */
const SCHEMA_SPEAK_RE =
  /\be\.g\.|\bonly if visible\b|\bif visible\b|\bin a few words\b|\bthe single detail\b|\ba reader notices\b|\bwhat the shot shows\b|\bexecution quality\b|\bplacement of art\b|\bon which nails\b|\bwhere the look reads\b|\bthe garment that defines\b|\bevery visible layer\b|\bhow they combine\b|\bwhat the look is built around\b|\bthe element the frame\b|<[^>]{1,40}>|\{[^}]{0,40}\}/i;

/** Нормализация для сравнения: нижний регистр, только буквы и цифры, одинарные пробелы. */
function norm(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Все известные описания поля (по умолчанию для всех ниш + переданные профилем). */
function descriptionsFor(key: string, extra?: Record<string, string> | null): string[] {
  const out: string[] = [];
  for (const m of Object.values(PHOTO_FACT_DESCRIPTIONS)) if (m[key]) out.push(m[key]);
  if (extra?.[key]) out.push(extra[key]);
  return out;
}

/**
 * Значение повторяет описание поля. Описание = «инструкция» (до « — », «(» или «:») + варианты-примеры.
 * Копия: совпадает целиком; начинается с первых трёх слов инструкции или содержит её (3+ слова); длинный кусок
 * описания (5+ слов и половина его слов: «line cleanliness, cuticle work, evenness»); перечень 3+ вариантов через «/» или «|».
 * Значение из самих вариантов («back view, close crop», «both hands, close macro») — нормальный ответ.
 */
function copiesDescription(value: string, desc: string): boolean {
  const v = norm(value);
  const d = norm(desc);
  if (!v || !d) return false;
  if (v === d) return true;
  const vw = v.split(" ");
  const dw = d.split(" ");
  const head = norm(String(desc).split(/\s+[—–-]\s+|\(|:/)[0]);
  const hw = head.split(" ").filter(Boolean);
  if (hw.length >= 3) {
    if (vw.length >= 3 && vw.slice(0, 3).join(" ") === hw.slice(0, 3).join(" ")) return true;
    if (` ${v} `.includes(` ${head} `)) return true;
  }
  if (vw.length >= 5 && ` ${d} `.includes(` ${v} `) && vw.length / dw.length >= 0.5) return true;
  const opts = String(value).split(/\s*[/|]\s*/).filter(Boolean);
  if (opts.length >= 3 && opts.every((o) => ` ${d} `.includes(` ${norm(o)} `))) return true;
  return false;
}

/**
 * Значение факта — заглушка или копия описания поля (а не то, что видно на фото).
 * `descriptions` — поля профиля ниши (если профиль переопределён в базе).
 */
export function isPlaceholderFact(key: string, value: unknown, descriptions?: Record<string, string> | null): boolean {
  const raw = Array.isArray(value) ? value.map((x) => String(x ?? "")).join(", ") : String(value ?? "");
  const v = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!v) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (SCHEMA_SPEAK_RE.test(v)) return true;
  // Перечень вариантов через «|» — это строка схемы («"diy" | "salon" | "salon-leaning"»), не ответ.
  if ((v.match(/\|/g) || []).length >= 1 && /"/.test(v)) return true;
  for (const d of descriptionsFor(key, descriptions)) if (copiesDescription(v, d)) return true;
  return false;
}

/**
 * Факты без заглушек и копий описаний; пустой результат — null. Массивы склеиваются через запятую,
 * значение режется до 300 символов (как в cleanFacts). Ключи не переименовываются.
 */
export function sanitizeFacts(raw: unknown, descriptions?: Record<string, string> | null, keys?: string[]): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const list = keys?.length ? keys : Object.keys(obj);
  const out: Record<string, string> = {};
  for (const k of list) {
    const v = obj[k];
    if (v == null || (typeof v === "object" && !Array.isArray(v))) continue;
    const text = (Array.isArray(v) ? v.filter(Boolean).map(String).join(", ") : String(v)).trim();
    if (!text || isPlaceholderFact(k, text, descriptions)) continue;
    out[k] = text.slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Инструкция полей для промта: описание без примеров «(e.g. …)» — пример тоже тянет модель к копии
 * (в прогоне bf37757f «shape_length: medium almond» — у 19 из 57 фото ногтей).
 */
export function factFieldGuide(facts: Record<string, string> | null | undefined): string {
  if (!facts || !Object.keys(facts).length) return '- description_facts: everything visible about the subject of the topic';
  return Object.entries(facts)
    .map(([k, v]) => `- ${k}: ${String(v).replace(/\s*\(e\.g\.[^)]*\)/gi, "").trim()}`)
    .join("\n");
}
