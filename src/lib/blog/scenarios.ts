/**
 * Типы (форматы) инфо-статей. Формат и тема — разные вещи: формат — КАК устроена статья (инструкция, нумерованный список,
 * подборка, рецепт…), тема (кожа, здоровье, уборка) на формат не влияет. Здоровье/деньги/безопасность (YMYL из брифа) —
 * надстройка над любым форматом: осторожные формулировки, дисклеймер, без видео и ИИ-картинок.
 *
 * Определение (этап `scenario`, после исследования): по ТЕМЕ СТАТЬИ (заголовку, который задаёт редактор: «25 Clear Skin Tips»),
 * затем по ключу, затем по интенту из брифа. Число в начале темы — число пунктов (с ограничением формата).
 * В интерфейсе это «Тип статьи»; «Сценарий» — набор промтов, моделей и параметров (BlogRecipe).
 * Новый формат = новая запись в SCENARIOS (порядок важен: побеждает первый подходящий) + при необходимости блоки в blocks.ts
 * и правила структуры в outline.ts (structureRules).
 */
import type { BlogBrief, BlogRecipeParams } from "./types";

/** Каркас статьи: как план раскладывает секции (outline.ts) и как собирается HTML (html.ts). */
export type Structure = "sections" | "numbered" | "roundup" | "big_list" | "recipe" | "workout" | "plan";

export type ScenarioOverrides = Partial<Pick<BlogRecipeParams, "source" | "video">> & {
  aiImages?: Partial<BlogRecipeParams["aiImages"]>;
  blocks?: Partial<BlogRecipeParams["blocks"]>;
  length?: { min: number; max: number };
};

export type Scenario = {
  key: string;
  label: string;
  /** Что это за формат и какая стратегия — показывается в сценарии и карточке статьи */
  description: string;
  structure: Structure;
  /** Признак по теме статьи (заголовку) и ключу; brief — запасной признак по интенту */
  match: (ctx: { topic: string; keyword: string; brief: BlogBrief; n: number | null }) => boolean;
  overrides: ScenarioOverrides;
  /** Пределы числа пунктов: по умолчанию и максимум (тема «40 Easy Recipes» в подборке станет 25) */
  count?: { def: number; max: number };
  /** Дополнение к промту плана (английский) */
  outlineHint?: string;
  /** Пример темы для подсказки в интерфейсе */
  example?: string;
};

const has = (s: string, re: RegExp) => re.test(s);
const FOOD = /\b(recipes?|meals?|dinners?|lunch(?:es)?|breakfasts?|brunch|snacks?|soups?|salads?|desserts?|smoothies?|drinks?|mocktails?|cocktails?|casseroles?|appetizers?|side dishes|sides|bowls?|sandwich(?:es)?|wraps?|pasta|chicken|beef|pork|salmon|shrimp|tofu|vegan|vegetarian|keto|low carb|high protein|meal prep|crockpot|slow cooker|air fryer|instant pot|cookies|cakes?|muffins?|bars|dips?|sauces?)\b/i;
const VISUAL = /\b(organi[sz]ation|organi[sz]ing|storage|decor|room|closet|pantry|kitchen|bathroom|bedroom|living room|garden|patio|porch|party|birthday|gift|basket|board|charcuterie|nails?|manicure|hair(?:styles?)?|braids?|outfits?|tattoos?|makeup looks?|centerpieces?|wreaths?|shelf|shelves|drawer|laundry|garage|entryway)\b/i;
const BIG = /\b(questions?|prompts?|affirmations?|quotes?|captions?|sayings?|names?|words?|things to (?:do|say|write|ask)|bucket list|hobbies|goals?|journal(?:ing)? (?:ideas|prompts)|conversation starters|would you rather|dares?|truth or dare|pick[- ]up lines|bible verses|mantras|ideas for (?:a )?journal)\b/i;
const NUMBERED_NOUNS = /\b(tips|ways|habits|signs|hacks|tricks|things|foods|mistakes|rules|secrets|remedies|benefits|reasons|products|uses|steps|ideas|lessons|facts|symptoms|causes|essentials|staples|swaps|rituals|boundaries|skills|routines?|techniques|changes|methods|exercises|oils|treatments|items|practices|strategies|questions|affirmations|prompts|quotes|phrases|goals|hobbies|activities|drinks|teas|herbs|supplements|vitamins|nutrients|plants|ingredients|stretches|poses|jobs|side hustles|upgrades|templates|apps|books|podcasts|gifts)\b/i;
const RECIPE_PLURAL = "recipes|meals|dinners|lunches|lunch ideas|breakfasts|breakfast ideas|snacks|snack ideas|soups|salads|desserts|smoothies|mocktails|cocktails|casseroles|appetizers|side dishes|sides|bowls|sandwiches|wraps|dinner ideas|meal ideas|meal prep ideas|shot recipes|tea recipes|water recipes|drink recipes|juices";

/** Число пунктов: число прямо перед существительным списка (до 5 слов между), иначе число в начале темы. */
export function listNumber(topic: string, nouns: RegExp = NUMBERED_NOUNS): number | null {
  const t = String(topic ?? "");
  const re = new RegExp(`\\b(\\d{1,3})\\+?\\s+(?:[A-Za-z\u2019'&-]+\\s+){0,5}?(?:${nouns.source.replace(/^\\b\(|\)\\b$/g, "")})\\b`, "i");
  const m = t.match(re);
  if (m) { const n = Number(m[1]); if (n >= 3) return n; }
  return leadingNumber(t);
}
const RECIPE_RE = new RegExp(`\\b(${RECIPE_PLURAL})\\b`, "i");

/**
 * Отложенные форматы (владелец 2026-10-23: «не нужны, потом отдельно сделаем»): в определение не участвуют.
 * Код каркаса «roundup» (structure.ts, ссылка «Get the recipe» в assemble.ts) оставлен — чтобы включить, перенести запись в SCENARIOS.
 */
export const DEFERRED_SCENARIOS: Scenario[] = [
  {
    key: "roundup_recipes", label: "Подборка рецептов", structure: "roundup",
    description: "«31 Easy Soup Recipes»: N блюд, у каждого реальное фото, 2–3 фразы о блюде и ссылка на рецепт автора. До 25 пунктов.",
    // «31 Easy Soup Recipes», «15 Healthy No-Bake Protein Balls», «Easy Zucchini Recipes» (без числа — 15 пунктов)
    match: ({ topic }) => (RECIPE_RE.test(topic) && !/^\s*how to make\b(?![^:]*:\s*\d)/i.test(topic)) || (listNumber(topic, FOOD) != null && FOOD.test(topic)),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" }, length: { min: 900, max: 2600 } },
    count: { def: 15, max: 25 }, example: "31 Easy Soup Recipes Even Picky Eaters Love",
  },
  {
    key: "roundup_ideas", label: "Подборка идей с фото", structure: "roundup",
    description: "«30 Pantry Organization Ideas»: N идей, у каждой реальное фото и 2–3 фразы, подпись источника. До 25 пунктов.",
    match: ({ topic, n }) => n != null && /\b(ideas?|looks?|designs?|styles?|ways to (?:organi[sz]e|decorate|style))\b/i.test(topic) && VISUAL.test(topic) && !BIG.test(topic) && !/\b(date night|birthday ideas for (?:him|her))\b/i.test(topic),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" }, length: { min: 900, max: 2600 } },
    count: { def: 15, max: 25 }, example: "30 Pantry Organization Ideas to Keep Everything in Order",
  },
];

export const SCENARIOS: Scenario[] = [
  {
    key: "checklist", label: "Чеклист", structure: "big_list",
    description: "«The Ultimate Whole House Cleaning Checklist», «First Apartment Checklist»: задачи или вещи в одну строку по группам (комнатам, этапам), короткие советы. Файл для печати — позже.",
    match: ({ topic, keyword }) => (/\bcheck ?list\b|\b(supplies|packing|shopping|grocery|essentials) list\b|\bessentials\b/i.test(topic || keyword)) && !/\b\d+[- ]day\b/i.test(topic),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" }, length: { min: 900, max: 3500 } },
    count: { def: 60, max: 150 }, example: "The Ultimate Whole House Cleaning Checklist",
  },
  {
    key: "big_list", label: "Большой список", structure: "big_list",
    description: "«400 Interesting Questions», аффирмации, промпты, идеи: пункты в одну строку по группам, 2–4 фото. Почти только текст — дёшево.",
    match: ({ topic, keyword, n }) => BIG.test(topic || keyword) || (n != null && n >= 40 && /\b(ideas|things)\b/i.test(topic)),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" }, length: { min: 900, max: 5000 } },
    count: { def: 100, max: 400 }, example: "400 Interesting Questions to Ask Anyone",
  },
  {
    key: "workout", label: "Тренировка", structure: "workout",
    description: "«10-Minute Ab Workout»: упражнения карточками (как делать, подходы и повторы, подсказка по технике), план по дням таблицей, видео — если найдётся.",
    match: ({ topic, keyword }) => {
      const t = topic || keyword;
      if (/\b(mindful|mindfulness|breathing|vagus|meditation|cycle|phases?|syncing|explained|eye|face yoga|kegel)\b/i.test(t)) return false;
      return /\bworkouts?\b|\b(ab|abs|arm|leg|glute|core|back|waist|stomach|belly|hip|butt|booty|thigh|shoulder|posture|strength|dumbbell|resistance band|kettlebell|treadmill|full body|toning|wall pilates)\b[\w\s-]{0,20}\b(exercises?|moves|routine)\b|\b(stretch(?:es|ing)? routine|yoga poses|pilates|hiit|cardio)\b/i.test(t);
    },
    overrides: { source: "research", video: { embed: "auto" }, aiImages: { mode: "off" } },
    count: { def: 8, max: 15 }, example: "Quick 10-Minute At-Home Ab Workout for Women",
    outlineHint: "Fitness: no medical promises; mention warming up and stopping if anything hurts.",
  },
  {
    key: "plan", label: "План по дням", structure: "plan",
    description: "«7-Day Meal Plan», «30-Day Challenge»: таблица по дням, список покупок или что понадобится, советы. Тема диет — с осторожностью.",
    match: ({ topic, keyword }) => /\b(meal plan|diet plan|eating plan|workout plan|\d+[- ]day|\d+[- ]week|weekly plan|challenge|schedule)\b/i.test(topic || keyword),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" } },
    example: "7-Day Mediterranean Diet Meal Plan for Beginners",
  },
  {
    key: "recipe", label: "Рецепт", structure: "recipe",
    description: "Одно блюдо или DIY-средство (скраб, лосьон, очиститель): карточка с ингредиентами и количествами, шаги, советы, варианты, хранение; разметка Recipe для Google.",
    match: ({ topic, keyword }) => {
      const t = topic || keyword;
      if (/\brecipe\b/i.test(t) && !/\brecipes\b/i.test(t)) return true;
      const DIY = /\b(lotion|scrub|body butter|cuticle oil|hair mask|face mask|cleaner|spray|shots?|latte|matcha|pudding|granola|broth|tea|golden milk|gel|serum|soap|candle|deodorant|toner|mouthwash|detergent|air freshener)\b/i;
      return (/\bhow to make\b/i.test(t) && (FOOD.test(t) || DIY.test(t))) || (/\b(diy|homemade)\b/i.test(t) && DIY.test(t) && listNumber(t) == null)
        || (/\b(homemade|healthy|easy)\b/i.test(t) && FOOD.test(t) && listNumber(t) == null && !RECIPE_RE.test(t));
    },
    overrides: { source: "research", video: { embed: "auto" } },
    example: "Easy Homemade Granola Recipe",
  },
  {
    key: "numbered", label: "Нумерованный список", structure: "numbered",
    description: "«25 Clear Skin Tips», «10 Signs You're Low in Vitamin D», «25 Best Foods for Gut Health», «How to Build Self-Discipline: 10 Proven Tips»: N пунктов, у каждого заголовок и абзац, фото на самых наглядных. До 50 пунктов.",
    // + списки без числа в заголовке: «Top High-Fiber Foods», «Foods That Lower Blood Pressure», «B12 Deficiency Signs and Foods»
    match: ({ topic }) => (listNumber(topic) != null && NUMBERED_NOUNS.test(topic)) || (/\b(foods|drinks|remedies|signs|symptoms|cheat sheet)\b/i.test(topic) && !/^\s*how to\b/i.test(topic)),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" }, length: { min: 900, max: 4000 } },
    count: { def: 12, max: 50 }, example: "25 Clear Skin Tips That Actually Work",
  },
  {
    key: "how_to_video", label: "Инструкция по лучшему видео", structure: "sections",
    description: "How-to и «как исправить»: метод, порядок и цифры из лучшего видео YouTube, исследование дополняет; видео встроено. Нет годного видео — статья по исследованию.",
    match: ({ topic, keyword, brief }) => /^\s*how to\b|\bstep[- ]by[- ]step\b|\bguide\b|\broutine\b/i.test(topic || keyword) || ["how_to", "problem_fix"].includes(brief.intent),
    overrides: { source: "video", video: { embed: "auto" } },
    example: "How to Use Hair Rollers for Bouncy Curls",
  },
  {
    key: "comparison", label: "Сравнение и выбор", structure: "sections",
    description: "«Какой выбрать», «X или Y»: исследование, обязательная таблица сравнения, видео не ищем.",
    match: ({ topic, keyword, brief }) => /\b(vs\.?|versus|which)\b|\bor\b[^?]*\?\s*$/i.test(topic || keyword) || ["which", "comparison"].includes(brief.intent),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" } },
    outlineHint: "This is a choice/comparison article: include one comparison_table section and a clear 'which one to pick' rule.",
    example: "Hot Rollers vs Velcro Rollers: Which Is Better?",
  },
  {
    key: "explainer", label: "Объяснение", structure: "sections",
    description: "«Почему», «что это», «польза»: исследование, причины и факты, без видео и ИИ-картинок.",
    match: ({ topic, keyword, brief }) => /^\s*(why|what (?:is|are|does)|is it)\b|\b(explained|benefits|meaning)\b/i.test(topic || keyword) || ["why", "what_is"].includes(brief.intent),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" } },
    example: "The 5 Love Languages Explained",
  },
  {
    key: "general", label: "Общая статья", structure: "sections",
    description: "Всё остальное: исследование, видео — если найдётся хорошее.",
    match: () => true,
    overrides: { source: "research", video: { embed: "auto" } },
  },
];

export const SCENARIO_BY_KEY = new Map(SCENARIOS.map((s) => [s.key, s]));

export type AppliedScenario = {
  key: string;
  label: string;
  reason: string;
  auto: boolean;
  outlineHint?: string;
  structure?: Structure;
  /** Число пунктов (нумерованный список, подборка, большой список, тренировка) */
  n?: number | null;
  /** Надстройка «здоровье, деньги, безопасность» */
  ymyl?: boolean;
};

/** Число в начале темы: «25 Clear Skin Tips» → 25, «250+ Bucket List Ideas» → 250. */
export function leadingNumber(topic: string): number | null {
  const m = String(topic ?? "").match(/^\s*(\d{1,3})\+?\s+\S/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 3 ? n : null;
}

/** Тема относится к отложенному формату («31 Easy Soup Recipes») — такие статьи пока не пишем (запуск их пропускает). */
export function deferredFormatOf(topic: string): Scenario | null {
  const t = String(topic ?? "").trim();
  if (!t) return null;
  const brief = { intent: "other", ymyl: false } as BlogBrief;
  return DEFERRED_SCENARIOS.find((s) => s.match({ topic: t, keyword: "", brief, n: listNumber(t) })) ?? null;
}

/** Выбор формата: закреплённый в сценарии или первый подходящий по теме/ключу/брифу. null — «manual». */
export function pickScenario(setting: string | undefined, brief: BlogBrief, keyword: string, topic = ""): { scenario: Scenario; auto: boolean; n: number | null } | null {
  if (setting === "manual") return null;
  const n0 = listNumber(topic);
  const fixed = setting && setting !== "auto" ? SCENARIO_BY_KEY.get(setting) : undefined;
  const scenario = fixed ?? SCENARIOS.find((s) => s.match({ topic: topic.trim(), keyword, brief, n: n0 })) ?? SCENARIOS[SCENARIOS.length - 1];
  const nFmt = scenario.key === "roundup_recipes" ? listNumber(topic, RECIPE_RE) ?? listNumber(topic, FOOD) ?? n0 : n0;
  const n = scenario.count ? Math.min(scenario.count.max, nFmt ?? scenario.count.def) : null;
  return { scenario, auto: !fixed, n };
}

/** Надстройка YMYL: здоровье, деньги, безопасность — над любым форматом. */
const YMYL_OVERRIDES: ScenarioOverrides = { source: "research", video: { embed: "off" }, aiImages: { mode: "off" }, blocks: { disclaimer: "always" } };
export const YMYL_HINT = "This is a health, money or safety topic: careful wording, no diagnoses or guarantees, never invent numbers, include when to see a professional.";

/** Параметры сценария с наложенным форматом и, если тема YMYL, надстройкой здоровья (ИИ-картинки формат может только выключить). */
export function applyScenario(params: BlogRecipeParams, s: Scenario, ymyl = false): BlogRecipeParams {
  const layers = ymyl ? [s.overrides, YMYL_OVERRIDES] : [s.overrides];
  let p: BlogRecipeParams = { ...params };
  for (const o of layers) {
    p = {
      ...p,
      ...(o.source ? { source: o.source } : {}),
      ...(o.video ? { video: { ...p.video, ...o.video } } : {}),
      aiImages: o.aiImages?.mode === "off" ? { ...p.aiImages, mode: "off" } : p.aiImages,
      blocks: { ...p.blocks, ...(o.blocks ?? {}) },
      ...(o.length ? { length: { min: Math.max(p.length.min, o.length.min), max: Math.max(p.length.max, o.length.max) } } : {}),
    };
  }
  return p;
}

export function scenarioReason(s: Scenario, brief: BlogBrief, auto: boolean, topic = ""): string {
  if (!auto) return "закреплён в сценарии";
  const by = topic ? `по теме «${topic.slice(0, 80)}»` : `по ключу и интенту «${brief.intent}»`;
  return `${by}${brief.ymyl ? " · тема здоровья, денег или безопасности" : ""}${brief.topicDomain ? ` · ${brief.topicDomain}` : ""}`;
}
