/**
 * Аудитория темы: двусмысленные выражения, возраст (дети/взрослые), пол и этничность.
 * Порт оригинала _shared/audienceIntent.ts + _shared/photoAudience.ts + _shared/photoGender.ts, имена экспортов сохранены.
 * Правило этничности сделано строже (аудит 02, п.3 / 7.3): цвет («black hair color», «white hair») и страна-стиль
 * («korean nails», «japanese nail art») больше не считаются аудиторией — нужно явное указание на людей.
 */

// ── audienceIntent.ts:8-30 ──
const COLOURS = "blue|pink|yellow|green|purple|red|orange|peach|lilac|lavender|mint|teal|aqua|turquoise|gray|grey|white|brown|beige";

const AMBIGUOUS: Array<[RegExp, string]> = [
  [new RegExp(`\\bbaby[\\s-]+(?:${COLOURS})\\b`, "gi"), "pastel colour"],
  [/\bbaby'?s[\s-]+breath\b/gi, "gypsophila flower"],
  [/\bbaby[\s-]?doll\b/gi, "flared mini dress"],
  [/\bbaby[\s-]?lights\b/gi, "fine highlights"],
  [/\bbaby[\s-]+(?:hairs?|lights|bangs|braids?|curls)\b/gi, "fine hair detail"],
  [/\bbaby[\s-]+(?:french|boomer|nails?|tips?)\b/gi, "micro nail style"],
  [/\bbaby[\s-]+(?:face|skin|glow|lips|blush)\b/gi, "fresh dewy look"],
  [/\bbaby[\s-]+(?:tattoos?|tats?)\b/gi, "tiny tattoo"],
  [/\bbaby[\s-]+(?:tee|tees|t-shirts?)\b/gi, "cropped fitted tee"],
  [/\bmom[\s-]+(?:jeans|shorts|fit)\b/gi, "high-waist relaxed denim"],
  [/\b(?:boyfriend|girlfriend)[\s-]+(?:jeans|shirts?|blazers?|fit|cardigans?)\b/gi, "relaxed fit garment"],
  [/\bdad[\s-]+(?:sneakers|shoes|hats?|caps?|shorts|jeans|core|style)\b/gi, "chunky casual style"],
  [/\bgrand(?:pa|ma)[\s-]+(?:sweaters?|cardigans?|core|style|outfits?|looks?)\b/gi, "vintage knit style"],
  [/\b(?:boy|boyish)[\s-]+(?:cut|pixie|bob|brows?|style|look|blazer)\b/gi, "short tomboy style"],
  [/\bschool[\s-]?girl\b/gi, "preppy"],
  [/\b(?:princess|mermaid)[\s-]+(?:dress|dresses|gowns?|hair|waves|braid|silhouette|nails|makeup|style|cut)\b/gi, "romantic fantasy style"],
  // Испанские поисковые формы
  [/\bazul[\s-]+beb[eé]\b/gi, "azul cielo"],
  [/\brosa[\s-]+beb[eé]\b/gi, "rosa pastel"],
];

/** Убирает двусмысленные выражения, оставляя только реальные указания аудитории. */
export function normalizeAmbiguous(text: string): string {
  let out = String(text || "");
  for (const [re, rep] of AMBIGUOUS) out = out.replace(re, rep);
  return out;
}

/** Есть ли в теме двусмысленное выражение (для аудита очереди). */
export function hasAmbiguousPhrase(text: string): boolean {
  return AMBIGUOUS.some(([re]) => {
    re.lastIndex = 0;
    return re.test(String(text || ""));
  });
}

// оригинал: audienceIntent.ts:44 (слабое место 7.14 про «girls» оставлено как есть — решение владельца)
const CHILD_WORDS = /\b(baby|babies|infant|infants|newborn|toddler|toddlers|kid|kids|child|children|childrens|children's|boy|boys|girl|girls|teen|teens|nursery|bebé|bebe|niña|niño|niños|infantil)\b/i;

/** Явно ли тема про детей (после снятия двусмысленностей). */
export function isChildIntent(keyword: string, niche?: string | null): boolean {
  return CHILD_WORDS.test(normalizeAmbiguous(`${keyword || ""} ${niche || ""}`));
}

/** Возрастное правило для промтов оценки и модерации. */
export function ageRule(keyword: string, niche?: string | null): string {
  return isChildIntent(keyword, niche) ? "" : "AGE: this topic is for ADULTS. Reject any photo showing a baby, toddler, child or teen, or children's garments.";
}

// ── photoGender.ts ──
export type GenderAllow = "female" | "male" | "any";

const MALE_WORDS = /\b(men|mens|men's|man|male|males|boy|boys|guy|guys|gentleman|gentlemen|barber|beard|husband|groom|dad|father|papa|father's)\b/i;
const FEMALE_WORDS = /\b(women|womens|women's|woman|female|females|girl|girls|lady|ladies|bride|bridal|mom|mother|mum|wife|feminine)\b/i;
const UNISEX_WORDS = /\b(unisex|couple|couples|family|kids|children|baby|toddler|his and hers|matching)\b/i;

function audienceText(keyword: string, niche?: string | null): string {
  return normalizeAmbiguous(`${keyword || ""} ${niche || ""}`);
}

export interface GenderRule {
  allow: GenderAllow;
  /** Правило текстом — подставляется в промты оценки фото. */
  rule: string;
  /** Короткая причина отказа для лога. */
  rejectReason: string;
}

/** Правило пола по ключу статьи. По умолчанию — только женщины (оригинал: photoGender.ts:30-62). */
export function genderRule(keyword: string, niche?: string | null): GenderRule {
  const text = audienceText(keyword, niche);
  const male = MALE_WORDS.test(text);
  const female = FEMALE_WORDS.test(text);
  const unisex = UNISEX_WORDS.test(text);

  if (unisex || (male && female)) {
    return { allow: "any", rule: "People of any gender are allowed in the frame.", rejectReason: "" };
  }
  if (male && !female) {
    return {
      allow: "male",
      rule: "GENDER: this topic is about MEN. Reject any photo where the subject is a woman or a girl, and reject photos where a woman is clearly visible next to the man.",
      rejectReason: "женщина в кадре, тема про мужчин",
    };
  }
  return {
    allow: "female",
    rule:
      "GENDER: this topic is about WOMEN (no male word appears in the keyword)." +
      " Reject the photo if ANY man or boy is clearly visible — as the subject, as a partner in a couple," +
      " in the background, or in a side panel. Male hands, a male face, a male haircut or a male body" +
      " visible in the frame all mean verdict \"reject\". Children's photos are also rejected unless the" +
      " keyword asks for them.",
    rejectReason: "мужчина в кадре, тема про женщин",
  };
}

/** Правило одной строкой для чек-листов и контракта темы. */
export function genderReviewRule(keyword: string, niche?: string | null): string[] {
  const g = genderRule(keyword, niche);
  return g.allow === "any" ? [] : [g.rule];
}

// ── photoAudience.ts ──
export interface AudienceRule {
  /** ключ группы: black / latina / asian / south_asian / middle_eastern / white */
  code: string;
  /** человекочитаемое название для промта */
  label: string;
  /** слова из ключа, которые нельзя трактовать как цвет/мотив */
  tokens: string[];
  /** правило текстом для промтов оценки фото */
  rule: string;
  /** короткая причина отказа */
  rejectReason: string;
}

interface Def {
  code: string;
  label: string;
  re: RegExp;
  tokens: string[];
  /** как выглядит несоответствие — для явного примера в промте */
  reject: string;
}

// оригинал: photoAudience.ts:31-74
const DEFS: Def[] = [
  {
    code: "black",
    label: "Black / African American (dark brown skin tone, Afro-textured or protective styled hair)",
    re: /\b(black|african[\s-]?american|african|afro|melanin|dark[\s-]?skin(ned)?|brown[\s-]?skin(ned)?|ebony)\b/i,
    tokens: ["black", "african", "americans", "american", "afro", "melanin", "ebony", "dark", "skin", "skinned", "brown"],
    reject: "light-skinned, white / Caucasian, East Asian or Latina models",
  },
  {
    code: "latina",
    label: "Latina / Hispanic",
    re: /\b(latina|latinas|latino|hispanic|chicana|mexican)\b/i,
    tokens: ["latina", "latinas", "latino", "hispanic", "chicana", "mexican"],
    reject: "white / Caucasian, Black or East Asian models",
  },
  {
    code: "asian",
    label: "East Asian (Chinese / Korean / Japanese features)",
    re: /\b(asian|asians|korean|japanese|chinese|k[\s-]?beauty)\b/i,
    tokens: ["asian", "asians", "korean", "japanese", "chinese", "beauty"],
    reject: "white / Caucasian, Black or South Asian models",
  },
  {
    code: "south_asian",
    label: "South Asian (Indian / Pakistani / Desi)",
    re: /\b(indian|indians|desi|pakistani|south[\s-]?asian|bollywood)\b/i,
    tokens: ["indian", "indians", "desi", "pakistani", "south", "asian", "bollywood"],
    reject: "white / Caucasian, Black or East Asian models",
  },
  {
    code: "middle_eastern",
    label: "Middle Eastern / Arab",
    re: /\b(arab|arabic|middle[\s-]?eastern|hijabi|khaleeji|turkish|persian)\b/i,
    tokens: ["arab", "arabic", "middle", "eastern", "hijabi", "khaleeji", "turkish", "persian"],
    reject: "models who clearly do not read as Middle Eastern",
  },
  {
    code: "white",
    label: "White / Caucasian",
    re: /\b(white|caucasian|scandinavian|nordic|pale[\s-]?skin(ned)?|fair[\s-]?skin(ned)?)\b/i,
    tokens: ["white", "caucasian", "scandinavian", "nordic", "pale", "fair", "skin", "skinned"],
    reject: "Black, Latina or Asian models",
  },
];

/**
 * Аудит 02, п.3: слова о человеке — только люди. В оригинале сюда входили nails, hair, outfits, style, fashion,
 * beauty, hairstyles, из-за чего «black hair color ideas» и «korean nails» получали правило этничности.
 */
const PERSON_WORDS =
  /\b(women|woman|womens|women's|girl|girls|lady|ladies|men|man|mens|men's|boy|boys|guy|guys|people|person|models?|bride|brides|bridal|moms?|mothers?|teens?|queens?|skin|skinned|complexion)\b/i;

/** Слова, которые сами по себе называют людей/этничность (не цвет и не стиль) — им контекст человека не нужен. */
const SELF_EVIDENT = /^(african[\s-]?american|melanin|ebony|latina|latinas|latino|hispanic|chicana|desi|hijabi|khaleeji|caucasian|(?:dark|brown|pale|fair)[\s-]?skin(?:ned)?)$/i;

/** Слова, которые бывают и цветом: аудиторией становятся только стоя непосредственно перед словом о людях. */
const COLOUR_ONLY = new Set(["black", "white"]);

/**
 * Правило аудитории по ключу статьи. null — тема не называет аудиторию.
 * Аудит 02, п.3: страна/национальность (korean, japanese, mexican, indian, turkish…) и «asian/afro/nordic» требуют
 * слова о людях в теме; «black»/«white» — ещё и непосредственного соседства (без hair/beauty/hairstyles, это цвет).
 */
export function audienceRule(keyword: string, niche?: string | null): AudienceRule | null {
  const text = normalizeAmbiguous(String(keyword || ""));
  if (!text.trim()) return null;
  void niche;

  for (const def of DEFS) {
    const m = text.match(def.re);
    if (!m) continue;
    const word = m[0].toLowerCase();
    if (!SELF_EVIDENT.test(word)) {
      // «korean nails», «black hair color» — без слова о человеке это стиль или цвет
      if (!PERSON_WORDS.test(text)) continue;
      if (COLOUR_ONLY.has(word)) {
        // «black dress for women» — цвет вещи: слово должно стоять непосредственно перед словом о людях
        const nearPerson = new RegExp(
          `\\b${word}\\s+(?:\\w+\\s+){0,1}(women|woman|womens|women's|girl|girls|lady|ladies|men|man|mens|men's|models?|people|person|teens?|queens?|brides?|moms?|mothers?|skin|complexion)\\b`,
          "i",
        );
        if (!nearPerson.test(text)) continue;
      }
    }
    return {
      code: def.code,
      label: def.label,
      tokens: def.tokens,
      rule:
        `AUDIENCE (hard): the article is written for ${def.label}. The person in the photo MUST visibly read as ${def.label}. ` +
        `Reject the photo if the model is ${def.reject}, or if no person is visible at all when the topic is about how a look sits on a person. ` +
        `This is not about clothing colour — judge skin tone, facial features and hair texture of the person in the frame. ` +
        `If you cannot tell (face cropped out, heavy filter, black-and-white photo) → reject, do not guess.`,
      rejectReason: `модель не соответствует аудитории темы (${def.code})`,
    };
  }
  return null;
}

/** Слова аудитории, которые нельзя требовать как «цвет/мотив в кадре». */
export function audienceTokens(keyword: string, niche?: string | null): Set<string> {
  const rule = audienceRule(keyword, niche);
  return new Set(rule ? rule.tokens : []);
}

/** Сводка аудитории для facts.audience: что сохраняем в статье для соседних этапов. */
export type AudienceFacts = {
  gender: GenderAllow;
  genderRule: string;
  childTopic: boolean;
  ageRule: string;
  audience: { code: string; label: string; tokens: string[]; rule: string } | null;
};

export function audienceFacts(keyword: string, niche?: string | null): AudienceFacts {
  const g = genderRule(keyword, niche);
  const a = audienceRule(keyword, niche);
  return {
    gender: g.allow,
    genderRule: g.allow === "any" ? "" : g.rule,
    childTopic: isChildIntent(keyword, niche),
    ageRule: ageRule(keyword, niche),
    audience: a ? { code: a.code, label: a.label, tokens: a.tokens, rule: a.rule } : null,
  };
}
