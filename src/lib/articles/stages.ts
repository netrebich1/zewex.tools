/**
 * Реестр этапов конвейера статей. Ключи — наши, номера — из оригинала (для сверки с отчётами docs/articles-migration).
 * Цепочка строго линейная; откаты «назад» (добор фото) происходят внутри этапов через Article.cursor.
 */
import type { ArtFormat } from "@prisma/client";

export const REAL_PHOTO_STAGES = ["search", "filter", "rank", "rate", "select", "plan", "section_plan", "blueprint", "intro_outro", "sections", "meta", "assemble", "publish"] as const;
export const GENERATED_PHOTO_STAGES = ["concept", "images", "image_seo", "blueprint", "intro_outro", "sections", "meta", "assemble", "publish"] as const;

export type StageKey = (typeof REAL_PHOTO_STAGES)[number] | (typeof GENERATED_PHOTO_STAGES)[number];
export const ALL_STAGES: readonly StageKey[] = Array.from(new Set<StageKey>([...REAL_PHOTO_STAGES, ...GENERATED_PHOTO_STAGES]));

/** Фаза этапа: лимиты автозапуска сайта считаются отдельно для «фото» и «написания»; публикация — своя. */
export type StagePhase = "photos" | "writing" | "publish";

export type StageInfo = {
  label: string;
  /** Номер шага в оригинальном сервисе */
  legacy: number;
  phase: StagePhase;
  /** Ключи промтов набора, которые использует этап */
  promptKeys: string[];
  /** Какой слот ключей использует (для подсказок в UI) */
  slots: string[];
  description: string;
};

export const STAGE_INFO: Record<StageKey, StageInfo> = {
  search: { label: "Поиск фото", legacy: 11, phase: "photos", promptKeys: ["rp_photo_search"], slots: ["text_fast", "photo_dfs", "photo_serp"], description: "ИИ даёт варианты запросов, DataForSEO (или SerpAPI) — кандидатов из Google Images." },
  filter: { label: "Технический фильтр", legacy: 12, phase: "photos", promptKeys: [], slots: [], description: "Скачивание, размер, ориентация, дубли по отпечатку, коллажи, резкость." },
  rank: { label: "Сравнение кадров", legacy: 125, phase: "photos", promptKeys: [], slots: ["vision"], description: "Группы миниатюр и турнир лучших: предварительный рейтинг красоты." },
  rate: { label: "ИИ-оценка", legacy: 13, phase: "photos", promptKeys: ["rp_photo_rate"], slots: ["vision"], description: "Оценка 1–10, релевантность теме, аудитория, аутентичность, виральность, тренд." },
  select: { label: "Отбор", legacy: 14, phase: "photos", promptKeys: [], slots: ["vision"], description: "Уникальность между сайтами, сеточный отбор, раскладка; ≥15 кадров — дальше." },
  plan: { label: "План по фото", legacy: 15, phase: "writing", promptKeys: ["rp_photo_plan"], slots: ["text_fast"], description: "Порядок фото, заголовки H2, H1, title, описание, URL, план вступления." },
  section_plan: { label: "План секций", legacy: 16, phase: "writing", promptKeys: ["rp_section_plan"], slots: ["text_fast"], description: "Рецепт каждой секции: угол, объём, список, уход, честный минус." },
  blueprint: { label: "Блюпринт", legacy: 65, phase: "writing", promptKeys: [], slots: [], description: "Детерминированная сборка структуры статьи (без ИИ)." },
  intro_outro: { label: "Вступление и заключение", legacy: 72, phase: "writing", promptKeys: ["stage_7_intro_outro"], slots: ["text_main"], description: "Вступление 2 абзаца 90–120 слов и обязательное заключение." },
  sections: { label: "Тексты секций", legacy: 73, phase: "writing", promptKeys: ["stage_7_writer_system", "stage_7_writer_user"], slots: ["text_main"], description: "Секции пачками, частичный результат сохраняется, минимум 40 слов." },
  meta: { label: "SEO-мета", legacy: 77, phase: "writing", promptKeys: [], slots: ["text_main"], description: "Title, description, H1, slug; резервный детерминированный вариант." },
  assemble: { label: "Сборка HTML", legacy: 76, phase: "writing", promptKeys: [], slots: [], description: "HTML статьи с фото, alt и подписями источника." },
  publish: { label: "Публикация", legacy: 78, phase: "publish", promptKeys: [], slots: [], description: "Проверка качества, категория, загрузка фото в медиатеку, пост в WordPress." },
  concept: { label: "Концепт-план", legacy: 2, phase: "photos", promptKeys: ["stage_2"], slots: ["text_fast"], description: "Тренды, список образов (по одному на секцию), структура, ключи, мета." },
  images: { label: "Генерация картинок", legacy: 5, phase: "photos", promptKeys: ["stage_5_scene_planner"], slots: ["image_main", "text_fast"], description: "gpt-image-2 с референсами; ворота: ≥70 % образов с картинкой." },
  image_seo: { label: "SEO картинок", legacy: 6, phase: "writing", promptKeys: ["stage_6_image_seo"], slots: ["text_fast"], description: "Имена файлов, alt-тексты, сжатие." },
};

export function stagesFor(format: ArtFormat): readonly StageKey[] {
  return format === "GENERATED_PHOTO" ? GENERATED_PHOTO_STAGES : REAL_PHOTO_STAGES;
}

export function firstStage(format: ArtFormat): StageKey {
  return stagesFor(format)[0];
}

/** Следующий этап после успешно завершённого; null — конвейер закончен. */
export function nextStage(format: ArtFormat, stage: string): StageKey | null {
  const list = stagesFor(format);
  const i = list.indexOf(stage as StageKey);
  if (i === -1 || i === list.length - 1) return null;
  return list[i + 1];
}

export function stageIndex(format: ArtFormat, stage: string): number {
  return stagesFor(format).indexOf(stage as StageKey);
}

export function phaseOf(stage: string): StagePhase {
  return STAGE_INFO[stage as StageKey]?.phase ?? "writing";
}

export function stageLabel(stage: string): string {
  return STAGE_INFO[stage as StageKey]?.label ?? stage;
}

/** Этапы данной фазы — для подсчёта лимитов сайта в очереди. */
export function stagesOfPhase(phase: StagePhase): StageKey[] {
  return ALL_STAGES.filter((s) => STAGE_INFO[s].phase === phase);
}

/** Первый этап цепочки «написание» для формата (откуда стартует статья после модерации фото). */
export function firstWritingStage(format: ArtFormat): StageKey {
  return stagesFor(format).find((s) => STAGE_INFO[s].phase === "writing")!;
}
