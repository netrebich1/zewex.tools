/**
 * Помощники раздела «Сценарии»: шаги промтов формата, переменные шагов (что подставляет код — из отчёта
 * docs/articles-migration/06-prompts-and-config.md §2), готовность сценария, значения по умолчанию.
 */
import type { ArtFormat, ArtPrompt, ArtRecipe } from "@prisma/client";
import { STAGE_INFO, stagesFor, type StageKey } from "./stages";
import type { PhotoSearchConfig, RecipeImages, RecipePublish, RecipeShape, RecipeText } from "./types";

/** Популярные значения `provider:model` (из prisma/seed-data/articles/config.json). */
export const POPULAR_MODELS = ["openrouter:google/gemini-2.5-flash-lite", "openrouter:deepseek/deepseek-v4-flash", "openrouter:deepseek/deepseek-v4-pro-0813"];

/** Подписи ключей промтов (stageKey в ArtPrompt). */
export const PROMPT_KEY_LABELS: Record<string, string> = {
  rp_photo_search: "Поисковые запросы для фото",
  rp_photo_rate: "Оценка фото (vision)",
  rp_photo_plan: "Планирование по фото",
  rp_section_plan: "План секций",
  stage_7_writer_system: "Автор — постоянный блок (system)",
  stage_7_writer_user: "Автор — секции",
  stage_7_intro_outro: "Вступление и заключение",
  stage_2: "Концепт-план (ИИ-фото)",
  stage_5_scene_planner: "Планировщик сцены (ИИ-фото)",
  stage_6_image_seo: "SEO картинок",
};

/** Переменные, которые код подставляет в промт каждого шага (06-prompts-and-config.md §2, строки «К»). */
export const STAGE_VARS: Record<string, string[]> = {
  rp_photo_search: ["focus_keyword", "topic", "language", "target_country", "niche", "subniche", "outfit_mode", "fashion_contract", "decor_mode", "hero_element", "setting", "interior_contract", "topic_kind"],
  rp_photo_rate: ["topic", "focus_keyword", "niche", "subniche", "language", "topic_kind", "subject_label", "fashion_contract", "interior_contract"],
  rp_photo_plan: ["topic", "topic_kind", "niche_label", "subject_label", "required_facts", "focus_keyword", "language", "target_country", "niche", "subniche", "count_items", "sections_count", "total_sections", "target_word_count", "article_personality", "photos_table", "photo_captions", "outfit_mode", "fashion_contract", "decor_mode", "hero_element", "setting", "interior_contract"],
  rp_section_plan: ["topic", "topic_kind", "niche_label", "subject_label", "required_facts", "focus_keyword", "language", "niche", "subniche", "sections_count", "total_sections", "article_personality", "target_word_count", "photo_facts_table", "angles", "openers", "outfit_mode", "fashion_contract", "decor_mode", "hero_element", "setting", "interior_contract"],
  stage_7_writer_system: ["article_personality", "focus_keyword", "topic_kind", "required_facts", "COUNT"],
  stage_7_writer_user: ["niche_label", "topic_kind", "required_facts", "topic_facts", "batch_number", "total_batches", "batch_size", "article_personality", "focus_keyword", "previous_batch_summary", "previous_ending", "keywords_bolded_previous", "section_briefs", "batch_sections", "hair_brief", "trend_context", "cut_specs", "scene_context", "search_queries_brief", "article_context", "section_plans", "section_data", "COUNT"],
  stage_7_intro_outro: ["article_personality", "focus_keyword", "primary_keyword", "total_outfits", "intro_plan", "outro_plan", "care_plan", "trend_details", "content_angle", "subcategories", "trend_context", "article_context", "previous_ending", "fashion_contract", "outfit_mode", "interior_contract", "decor_mode", "hero_element", "setting", "room", "style", "hero_piece", "COUNT"],
  stage_2: ["topic", "focus_keyword", "niche", "subniche", "count_items", "sections_count", "language", "target_country", "target_word_count", "article_personality", "keywords_table", "niche_label", "topic_facts", "concept_fields", "COUNT"],
  stage_5_scene_planner: ["item_name", "item_details", "style_description", "photography_direction", "focus_keyword", "scene_context"],
  stage_6_image_seo: ["keyword", "focus_keyword", "language", "item_name", "image_context", "images_table"],
};

export const VAR_HINTS: Record<string, string> = {
  focus_keyword: "Ключ статьи (focus keyword)",
  topic: "Тема (ключ как написан)",
  primary_keyword: "Основной SEO-ключ",
  language: "Язык текста",
  target_country: "Страна аудитории",
  niche: "Код ниши",
  subniche: "Код подниши",
  niche_label: "Название ниши",
  topic_kind: "Тип темы из контракта",
  subject_label: "Кто/что в кадре (профиль ниши)",
  required_facts: "Обязательные признаки из профиля ниши",
  count_items: "Сколько фото/секций",
  sections_count: "Сколько секций",
  total_sections: "Всего секций",
  total_outfits: "Количество (= {{COUNT}})",
  target_word_count: "Целевой объём слов",
  article_personality: "Характер текста",
  photos_table: "Таблица фото с описаниями",
  photo_captions: "Подписи фото",
  photo_facts_table: "Таблица фактов по фото",
  section_briefs: "Брифы секций пачки",
  batch_sections: "То же, что section_briefs",
  batch_number: "Номер пачки",
  total_batches: "Всего пачек",
  batch_size: "Секций в пачке",
  previous_batch_summary: "Краткое содержание прошлой пачки",
  previous_ending: "Конец предыдущего текста",
  keywords_bolded_previous: "Ключи, уже выделенные жирным",
  trend_context: "Контекст трендов",
  trend_details: "Детали трендов",
  content_angle: "Угол подачи",
  subcategories: "Подкатегории",
  article_context: "Контекст статьи (мета, тема)",
  intro_plan: "План вступления",
  outro_plan: "План заключения",
  care_plan: "План ухода",
  fashion_contract: "Контракт темы (одежда)",
  interior_contract: "Контракт темы (интерьер)",
  outfit_mode: "Режим образа",
  decor_mode: "Режим декора",
  hero_element: "Главный элемент",
  hero_piece: "Главная вещь",
  setting: "Обстановка",
  room: "Комната",
  style: "Стиль",
  COUNT: "Метка количества — заменяется при сборке",
  keywords_table: "Таблица ключей",
  topic_facts: "Факты по теме",
  concept_fields: "Поля концепта ниши",
  item_name: "Название образа/картинки",
  item_details: "Детали образа",
  style_description: "Описание стиля",
  photography_direction: "Постановка съёмки",
  scene_context: "Контекст сцены",
  keyword: "Ключ статьи",
  image_context: "Контекст картинок",
  images_table: "Таблица картинок",
  angles: "Углы подачи",
  openers: "Варианты зачинов",
  hair_brief: "Бриф по волосам",
  cut_specs: "Спецификация стрижки",
  search_queries_brief: "Бриф поисковых запросов",
  section_plans: "Планы секций",
  section_data: "Данные секций",
};

export type PromptStep = { key: string; label: string; stage: StageKey; stageLabel: string; required: boolean };

/** Шаги промтов формата в порядке конвейера (один этап может использовать два ключа). */
export function promptSteps(format: ArtFormat): PromptStep[] {
  const out: PromptStep[] = [];
  for (const s of stagesFor(format)) {
    for (const key of STAGE_INFO[s].promptKeys) {
      // rp_photo_rate необязателен: без промта этап работает на встроенном тексте (06 §2).
      out.push({ key, label: PROMPT_KEY_LABELS[key] ?? key, stage: s, stageLabel: STAGE_INFO[s].label, required: key !== "rp_photo_rate" });
    }
  }
  return out;
}

export type Readiness = { ready: boolean; missing: PromptStep[]; filled: number; total: number };

/** Готовность сценария: для каждого обязательного шага есть активный промт в наборе (выбранный вариант или любой). */
export function recipeReadiness(recipe: Pick<ArtRecipe, "format" | "stagePromptIds">, prompts: Array<Pick<ArtPrompt, "id" | "stageKey" | "isActive">>): Readiness {
  const steps = promptSteps(recipe.format);
  const missing: PromptStep[] = [];
  let filled = 0;
  for (const st of steps) {
    // Выбранный вариант, которого нет в наборе, резолвер заменит первым активным — шаг всё равно «готов».
    const ok = prompts.some((p) => p.stageKey === st.key && p.isActive);
    if (ok) filled++;
    else if (st.required) missing.push(st);
  }
  return { ready: missing.length === 0, missing, filled, total: steps.length };
}

export const DEFAULT_PHOTO_SEARCH: PhotoSearchConfig = {
  source: "dataforseo",
  country: "us",
  language: "en",
  freshness: "any",
  license: "any",
  imageType: "photo",
  orientation: ["tall"],
  minWidth: 550,
  minHeight: 550,
  minScore: 6,
  candidatesTotal: 120,
  ratingBatchSize: 6,
  includeDomains: [],
  excludeDomains: [],
  uniqueMode: "soft",
  writerMode: "description",
  captionMode: "domain_link",
  captionTemplate: "{credit} {domain}",
  querySuffix: "",
};

export const DEFAULT_TEXT: RecipeText = { batchSize: 5, personality: null, wordCount: "compact3", schemaEnabled: true };
export const DEFAULT_IMAGES: RecipeImages = { provider: "openai", model: "gpt-image-2", quality: "medium", size: "1024x1536", mode: "single", groupId: null, promptId: null, promptWriterModel: "" };
export const DEFAULT_PUBLISH: RecipePublish = { mode: "publish_then_edit", seoYearUrlPercent: 0 };

/** Строка ArtRecipe → типизированный RecipeShape (JSON-поля с дефолтами). */
export function recipeShape(r: ArtRecipe): RecipeShape {
  const ps = (r.photoSearch ?? {}) as Partial<PhotoSearchConfig>;
  return {
    id: r.id,
    name: r.name,
    nicheCode: r.nicheCode,
    subnicheCode: r.subnicheCode,
    format: r.format,
    promptSetId: r.promptSetId,
    stagePromptIds: ((r.stagePromptIds ?? {}) as Record<string, string>) || {},
    stageModels: ((r.stageModels ?? {}) as Record<string, string>) || {},
    text: { ...DEFAULT_TEXT, ...((r.text ?? {}) as Partial<RecipeText>) },
    images: { ...DEFAULT_IMAGES, ...((r.images ?? {}) as Partial<RecipeImages>) },
    photoSearch: { ...DEFAULT_PHOTO_SEARCH, ...ps, orientation: Array.isArray(ps.orientation) && ps.orientation.length ? ps.orientation : DEFAULT_PHOTO_SEARCH.orientation, includeDomains: ps.includeDomains ?? [], excludeDomains: ps.excludeDomains ?? [] },
    publish: { ...DEFAULT_PUBLISH, ...((r.publish ?? {}) as Partial<RecipePublish>) },
  };
}

export const FORMAT_LABELS: Record<ArtFormat, string> = { REAL_PHOTO: "Реальные фото", GENERATED_PHOTO: "ИИ-фото" };

/** Справочники полей поиска фото для формы. */
export const SEARCH_OPTIONS = {
  source: [["dataforseo", "DataForSEO"], ["serpapi", "SerpAPI"]],
  freshness: [["any", "Любая"], ["y", "За год"], ["m", "За месяц"], ["w", "За неделю"]],
  license: [["any", "Любая"], ["commercial", "Коммерческая"]],
  imageType: [["photo", "Только фото"], ["any", "Любые изображения"]],
  orientation: [["tall", "Вертикальные"], ["square", "Квадратные"], ["wide", "Горизонтальные"]],
  uniqueMode: [["soft", "Мягко (предупреждать)"], ["strict", "Строго (не брать повторы)"], ["off", "Не учитывать"]],
  writerMode: [["description", "По описанию кадра (дешевле)"], ["vision", "Автор видит фото (vision)"]],
  captionMode: [["domain_link", "Домен со ссылкой"], ["domain", "Только домен"], ["none", "Без подписи"]],
  country: [["us", "США"], ["gb", "Великобритания"], ["ca", "Канада"], ["au", "Австралия"], ["de", "Германия"], ["fr", "Франция"], ["it", "Италия"], ["es", "Испания"], ["pl", "Польша"], ["ua", "Украина"], ["br", "Бразилия"]],
} as const;
