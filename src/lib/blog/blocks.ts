/**
 * Каталог блоков инфо-статьи — из чего план (этап outline) собирает структуру «от контекста».
 * У блока: описание для модели, разрешённые теги для автора, типичный объём, нужна ли картинка.
 * Правила выбора по интенту отдаются модели текстом (blocksCatalogText), детерминированной проверкой — только границы.
 */

export type BlockKind =
  | "quick_answer" | "why_it_happens" | "what_you_need" | "steps" | "methods" | "comparison_table" | "mistakes" | "tips"
  | "troubleshooting" | "prevention" | "aftercare" | "myths" | "when_to_see_pro" | "timeline_cost" | "prose";

export type BlockSpec = {
  kind: BlockKind;
  label: string;
  /** Что это за блок и когда уместен (для модели) */
  describe: string;
  /** Какие теги автор может использовать внутри секции */
  tags: string[];
  /** Типичный объём, слов */
  words: [number, number];
  /** Картинка уместна (план решает сам, но hero всегда отдельно) */
  image: "often" | "sometimes" | "rarely";
};

export const BLOCKS: BlockSpec[] = [
  { kind: "quick_answer", label: "Быстрый ответ", describe: "A direct 2-4 sentence answer to the title question before the details; for 'which', 'why', 'what is' and 'can I' topics.", tags: ["p"], words: [60, 110], image: "rarely" },
  { kind: "why_it_happens", label: "Причины", describe: "Causes or mechanism: why the problem happens or how the thing works; sub-points as <h3> or a bullet list.", tags: ["p", "h3", "ul", "li"], words: [120, 220], image: "sometimes" },
  { kind: "what_you_need", label: "Что понадобится", describe: "Materials, tools or products needed, as a bullet list with a short note on each; only for hands-on topics.", tags: ["p", "ul", "li"], words: [70, 140], image: "sometimes" },
  { kind: "steps", label: "Пошаговая инструкция", describe: "Numbered steps with a bold step label and 1-3 sentences each; the core of a how-to. One photo per 2-4 steps.", tags: ["p", "ol", "li", "strong"], words: [180, 350], image: "often" },
  { kind: "methods", label: "Методы / способы", describe: "Several alternative methods, each as <h3> with how to use it and a 'Tip:' or 'Caution:' line; for 'how to remove / get rid of' topics.", tags: ["p", "h3", "ul", "li", "strong"], words: [220, 400], image: "often" },
  { kind: "comparison_table", label: "Сравнительная таблица", describe: "A 2-3 column table comparing options (type / best for / downside) with one intro sentence and one sentence after.", tags: ["p", "table", "thead", "tbody", "tr", "th", "td"], words: [90, 170], image: "rarely" },
  { kind: "mistakes", label: "Частые ошибки", describe: "Common mistakes and what to do instead; bullet list with a bold label per item.", tags: ["p", "ul", "li", "strong"], words: [100, 180], image: "rarely" },
  { kind: "tips", label: "Советы", describe: "Practical tips that do not fit the steps; bullet list with bold labels.", tags: ["p", "ul", "li", "strong"], words: [90, 170], image: "sometimes" },
  { kind: "troubleshooting", label: "Проблема → решение", describe: "A problem/solution table for things that go wrong, with a one-line intro.", tags: ["p", "table", "thead", "tbody", "tr", "th", "td"], words: [90, 170], image: "rarely" },
  { kind: "prevention", label: "Профилактика", describe: "How to prevent the problem from coming back; numbered or bullet list.", tags: ["p", "ul", "ol", "li", "strong"], words: [90, 170], image: "sometimes" },
  { kind: "aftercare", label: "Уход после", describe: "What to do after the procedure or fix: aftercare, maintenance schedule.", tags: ["p", "ul", "li"], words: [80, 150], image: "sometimes" },
  { kind: "myths", label: "Мифы", describe: "2-4 myths with the reality for each, as 'Myth:' / 'Reality:' pairs.", tags: ["p", "h3", "strong"], words: [100, 180], image: "rarely" },
  { kind: "when_to_see_pro", label: "Когда к специалисту", describe: "When to stop DIY and see a doctor, dermatologist, stylist or technician; mandatory for health-adjacent topics.", tags: ["p", "ul", "li"], words: [60, 120], image: "rarely" },
  { kind: "timeline_cost", label: "Сроки и стоимость", describe: "How long it takes, how often to repeat, rough cost tiers without exact prices.", tags: ["p", "ul", "li"], words: [70, 130], image: "rarely" },
  { kind: "prose", label: "Обычный раздел", describe: "A plain explanatory section in 2-3 paragraphs when no special block fits.", tags: ["p", "h3", "ul", "li"], words: [100, 200], image: "sometimes" },
];

export const BLOCK_BY_KIND: Record<string, BlockSpec> = Object.fromEntries(BLOCKS.map((b) => [b.kind, b]));

export function blockOf(kind: string): BlockSpec {
  return BLOCK_BY_KIND[kind] ?? BLOCK_BY_KIND.prose;
}

/** Правила выбора блоков по интенту — подсказка планировщику (не жёсткое ограничение). */
export const INTENT_RULES: Record<string, string> = {
  how_to: "REQUIRED: steps (or methods when there are alternative ways), what_you_need, mistakes. OFTEN: tips, troubleshooting or aftercare. OPTIONAL: comparison_table, timeline_cost.",
  why: "REQUIRED: quick_answer, why_it_happens. OFTEN: comparison_table or a sub-list of causes, prevention, when_to_see_pro (health). OPTIONAL: myths.",
  which: "REQUIRED: quick_answer, comparison_table. OFTEN: why_it_happens or methods (how to use/check), tips. OPTIONAL: when_to_see_pro (health), myths.",
  comparison: "REQUIRED: quick_answer, comparison_table, a section per option (prose or methods). OFTEN: tips on choosing. OPTIONAL: mistakes.",
  list: "REQUIRED: methods or prose per item with an <h3> per item. OFTEN: comparison_table, tips. OPTIONAL: mistakes.",
  problem_fix: "REQUIRED: why_it_happens, methods, prevention. OFTEN: troubleshooting, aftercare, when_to_see_pro (health). OPTIONAL: what_you_need, myths.",
  what_is: "REQUIRED: quick_answer, prose explanation. OFTEN: comparison_table, tips. OPTIONAL: myths, when_to_see_pro (health).",
  other: "Pick 4-8 blocks that answer the search intent completely; always start with the answer the reader came for.",
};

/** Текст каталога для промта планировщика. */
export function blocksCatalogText(): string {
  const lines = BLOCKS.map((b) => `- ${b.kind}: ${b.describe} Tags: ${b.tags.map((t) => `<${t}>`).join(" ")}. Typical length ${b.words[0]}-${b.words[1]} words. Photo: ${b.image}.`);
  return `BLOCK CATALOG (use the kind codes exactly):\n${lines.join("\n")}\n\nSELECTION RULES BY INTENT:\n${Object.entries(INTENT_RULES).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`;
}

/** Разрешённые теги секции по типу блока (для автора и для чистки HTML). Всегда разрешены <p>, <strong> для меток. */
export function allowedTags(kind: string): string[] {
  const base = new Set(["p", "strong"]);
  for (const t of blockOf(kind).tags) base.add(t);
  return [...base];
}

/** Блоки, где ожидается таблица. */
export function wantsTable(kind: string): boolean {
  return kind === "comparison_table" || kind === "troubleshooting";
}
