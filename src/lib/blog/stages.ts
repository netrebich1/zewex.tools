/**
 * Реестр этапов конвейера инфо-статей. Цепочка линейная; фазы — для подписей и расходов.
 * research → outline → photo_search → photo_filter → photo_rate → photo_select → write → wrap → meta → pin_images → assemble → publish.
 */
export const BLOG_STAGES = ["research", "outline", "photo_search", "photo_filter", "photo_rate", "photo_select", "write", "wrap", "meta", "pin_images", "assemble", "publish"] as const;
export type StageKey = (typeof BLOG_STAGES)[number];

export type StagePhase = "research" | "photos" | "writing" | "publish";

export type StageInfo = {
  label: string;
  phase: StagePhase;
  /** Ключи промтов рецепта, которые использует этап (пусто — встроенный текст) */
  promptKeys: string[];
  slots: string[];
  description: string;
};

export const STAGE_INFO: Record<StageKey, StageInfo> = {
  research: { label: "Исследование", phase: "research", promptKeys: ["research"], slots: ["text_fast", "serp_organic"], description: "Интент ключа, аудитория, бриф знаний: факты, ошибки, безопасность, вопросы читателей; при включённом SerpAPI — People Also Ask." },
  outline: { label: "План", phase: "research", promptKeys: ["outline"], slots: ["text_main"], description: "Адаптивная структура из каталога блоков: H1 и мета, секции с типами, объём, слоты картинок, FAQ, дисклеймер." },
  photo_search: { label: "Поиск фото", phase: "photos", promptKeys: [], slots: ["photo_dfs", "photo_serp"], description: "Запросы Google Images по каждому слоту картинки." },
  photo_filter: { label: "Технический фильтр", phase: "photos", promptKeys: [], slots: [], description: "Скачивание, размер, ориентация, дубли, коллажи, резкость, метки ИИ." },
  photo_rate: { label: "Оценка фото", phase: "photos", promptKeys: ["photo_rate"], slots: ["vision"], description: "Vision-модель: релевантность описанию слота, настоящее фото, качество." },
  photo_select: { label: "Выбор фото", phase: "photos", promptKeys: [], slots: [], description: "Лучший кадр и резерв на слот, уникальность между постами, файлы статьи." },
  write: { label: "Текст секций", phase: "writing", promptKeys: ["writer_system", "writer_user"], slots: ["text_main"], description: "Секции пачками по плану и брифу; HTML по типу блока." },
  wrap: { label: "Вступление, итоги, FAQ", phase: "writing", promptKeys: ["wrap"], slots: ["text_main"], description: "Вступление, ключевые выводы, заключение, FAQ и дисклеймер — по готовому телу." },
  meta: { label: "SEO-мета", phase: "writing", promptKeys: [], slots: ["text_fast"], description: "Проверка title/description/slug, одна починка ИИ, детерминированный запас." },
  pin_images: { label: "Текст на фото", phase: "writing", promptKeys: [], slots: ["text_fast"], description: "Плашка с заголовком по секции над или под фото (как Canvas-пин, кадр не обрезается): разные шрифты и палитры." },
  assemble: { label: "Сборка HTML", phase: "writing", promptKeys: [], slots: ["text_main"], description: "HTML статьи с картинками, таблицами, FAQ, JSON-LD; проверка качества и самопочинка." },
  publish: { label: "Публикация", phase: "publish", promptKeys: [], slots: ["text_fast"], description: "Категория, загрузка фото в медиатеку, пост в WordPress с Yoast-мета." },
};

/** Промты, без которых этап работает на встроенном тексте. */
export const OPTIONAL_PROMPT_KEYS = new Set(["photo_rate"]);

export const PROMPT_KEY_LABELS: Record<string, string> = {
  research: "Исследование темы",
  outline: "План статьи",
  photo_rate: "Оценка фото (vision)",
  writer_system: "Автор — постоянный блок (system)",
  writer_user: "Автор — секции",
  wrap: "Вступление, итоги, заключение, FAQ",
};

/** Переменные, которые код подставляет в промт каждого шага. */
export const STAGE_VARS: Record<string, string[]> = {
  research: ["keyword", "focus_keyword", "language", "country", "serp_block"],
  outline: ["keyword", "focus_keyword", "brief", "blocks_catalog", "length_min", "length_max", "images_min", "images_max", "faq_min", "faq_max", "takeaways_rule", "faq_rule", "disclaimer_rule", "closing_image_rule", "voice", "persona", "language", "country"],
  photo_rate: ["keyword", "slot_query", "slot_must_show", "slot_avoid"],
  writer_system: ["keyword", "voice", "persona", "language", "ymyl_rule", "links_rule"],
  writer_user: ["keyword", "article_map", "brief_short", "section_briefs", "written_summary"],
  wrap: ["keyword", "h1", "brief_short", "article_summary", "faq_questions", "faq_count", "takeaways_wanted", "disclaimer_wanted", "voice", "persona"],
};

export const VAR_HINTS: Record<string, string> = {
  keyword: "Ключ статьи (тема)",
  focus_keyword: "Фокус-ключ (если задан, иначе ключ)",
  language: "Язык текста",
  country: "Страна аудитории",
  serp_block: "Блок People Also Ask и заголовков топа (если SerpAPI включён)",
  brief: "Бриф исследования (JSON)",
  brief_short: "Короткий бриф: интент, аудитория, факты, безопасность",
  blocks_catalog: "Каталог блоков с правилами выбора",
  length_min: "Минимум слов статьи", length_max: "Максимум слов статьи",
  images_min: "Минимум картинок", images_max: "Максимум картинок",
  faq_min: "Минимум вопросов FAQ", faq_max: "Максимум вопросов FAQ",
  takeaways_rule: "Правило блока ключевых выводов", faq_rule: "Правило FAQ", disclaimer_rule: "Правило дисклеймера", closing_image_rule: "Правило последней картинки",
  voice: "Голос автора", persona: "Персона автора",
  ymyl_rule: "Правило осторожных формулировок (health/money)",
  links_rule: "Правило внешних ссылок",
  article_map: "Карта статьи: все секции с типами",
  section_briefs: "Брифы секций пачки",
  written_summary: "Сводка уже написанных секций",
  h1: "Заголовок H1",
  article_summary: "Сводка тела статьи для вступления и заключения",
  faq_questions: "Вопросы FAQ из плана",
  faq_count: "Сколько вопросов FAQ",
  takeaways_wanted: "Нужен ли блок ключевых выводов",
  disclaimer_wanted: "Нужен ли дисклеймер",
  slot_query: "Что должно быть на фото слота",
  slot_must_show: "Обязательно в кадре",
  slot_avoid: "Чего не должно быть в кадре",
};

export function firstStage(): StageKey {
  return BLOG_STAGES[0];
}

export function nextStage(stage: string): StageKey | null {
  const i = BLOG_STAGES.indexOf(stage as StageKey);
  if (i === -1 || i === BLOG_STAGES.length - 1) return null;
  return BLOG_STAGES[i + 1];
}

export function isStage(s: string): s is StageKey {
  return (BLOG_STAGES as readonly string[]).includes(s);
}

export function stageLabel(stage: string): string {
  return STAGE_INFO[stage as StageKey]?.label ?? (stage === "done" ? "Готово" : stage);
}

export function phaseOf(stage: string): StagePhase {
  return STAGE_INFO[stage as StageKey]?.phase ?? "writing";
}

/** Промт-шаги рецепта в порядке конвейера. */
export function promptSteps(): Array<{ key: string; label: string; stage: StageKey; stageLabel: string; required: boolean }> {
  const out: Array<{ key: string; label: string; stage: StageKey; stageLabel: string; required: boolean }> = [];
  for (const s of BLOG_STAGES) for (const key of STAGE_INFO[s].promptKeys) out.push({ key, label: PROMPT_KEY_LABELS[key] ?? key, stage: s, stageLabel: STAGE_INFO[s].label, required: !OPTIONAL_PROMPT_KEYS.has(key) });
  return out;
}
