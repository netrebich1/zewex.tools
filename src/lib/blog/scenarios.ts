/**
 * Сценарии инфо-статей: тип статьи → стратегия. После исследования (этап `scenario`) система сама выбирает сценарий
 * по интенту ключа, YMYL-флагу и теме из брифа и записывает в снимок рецепта поста итоговые параметры
 * (основа статьи, видео, ИИ-картинки, подсказка плану). Рецепт может закрепить сценарий (params.scenario = ключ)
 * или отключить выбор («manual» — берутся параметры рецепта как есть).
 *
 * Новый тип статей = новая запись в SCENARIOS (порядок важен: побеждает первый подходящий).
 * Решение владельца 2026-10-22: стратегия по умолчанию для инструкций — «по видео»; для здоровья/денег, «почему», «какой» —
 * статья по исследованию.
 */
import type { BlogBrief, BlogRecipeParams } from "./types";

export type ScenarioOverrides = Partial<Pick<BlogRecipeParams, "source" | "video">> & {
  aiImages?: Partial<BlogRecipeParams["aiImages"]>;
  blocks?: Partial<BlogRecipeParams["blocks"]>;
};

export type Scenario = {
  key: string;
  label: string;
  /** Для чего и почему такая стратегия — показывается в рецепте и карточке статьи */
  description: string;
  match: (b: BlogBrief, keyword: string) => boolean;
  overrides: ScenarioOverrides;
  /** Дополнение к промту плана (английский), если тип статьи требует особых блоков */
  outlineHint?: string;
};

const intentIs = (b: BlogBrief, ...xs: string[]) => xs.includes(b.intent);

export const SCENARIOS: Scenario[] = [
  {
    key: "health_money",
    label: "Здоровье, деньги, безопасность",
    description: "YMYL-темы: только исследование, без видео и ИИ-картинок (видео по таким темам редко проходит проверку), дисклеймер всегда.",
    match: (b) => b.ymyl === true,
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" }, blocks: { disclaimer: "always" } },
    outlineHint: "This is a health, money or safety topic: careful wording, no diagnoses or guarantees, include when to see a professional.",
  },
  {
    key: "how_to_video",
    label: "Инструкция по лучшему видео",
    description: "How-to и «как исправить»: метод, порядок и цифры из лучшего видео YouTube, исследование дополняет; видео встроено. Нет годного видео — статья по исследованию.",
    match: (b) => intentIs(b, "how_to", "problem_fix"),
    overrides: { source: "video", video: { embed: "auto" } },
  },
  {
    key: "comparison",
    label: "Сравнение и выбор",
    description: "«Какой выбрать», «X или Y»: исследование, обязательная таблица сравнения, видео не ищем.",
    match: (b) => intentIs(b, "which", "comparison"),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" } },
    outlineHint: "This is a choice/comparison article: include one comparison_table section and a clear 'which one to pick' rule.",
  },
  {
    key: "explainer",
    label: "Объяснение",
    description: "«Почему», «что это»: исследование, причины и факты, без видео и ИИ-картинок.",
    match: (b) => intentIs(b, "why", "what_is"),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" } },
  },
  {
    key: "list",
    label: "Подборка",
    description: "Списки и идеи: исследование, без видео.",
    match: (b) => intentIs(b, "list"),
    overrides: { source: "research", video: { embed: "off" }, aiImages: { mode: "off" } },
  },
  {
    key: "general",
    label: "Общая статья",
    description: "Всё остальное: исследование, видео — если найдётся хорошее.",
    match: () => true,
    overrides: { source: "research", video: { embed: "auto" } },
  },
];

export const SCENARIO_BY_KEY = new Map(SCENARIOS.map((s) => [s.key, s]));

export type AppliedScenario = { key: string; label: string; reason: string; auto: boolean; outlineHint?: string };

/** Выбор сценария: закреплённый в рецепте или первый подходящий по брифу. null — «manual» (параметры рецепта как есть). */
export function pickScenario(setting: string | undefined, brief: BlogBrief, keyword: string): { scenario: Scenario; auto: boolean } | null {
  if (setting === "manual") return null;
  const fixed = setting && setting !== "auto" ? SCENARIO_BY_KEY.get(setting) : undefined;
  if (fixed) return { scenario: fixed, auto: false };
  const found = SCENARIOS.find((s) => s.match(brief, keyword)) ?? SCENARIOS[SCENARIOS.length - 1];
  return { scenario: found, auto: true };
}

/** Параметры рецепта с наложенным сценарием (ИИ-картинки: сценарий может только выключить, включает их рецепт). */
export function applyScenario(params: BlogRecipeParams, s: Scenario): BlogRecipeParams {
  const o = s.overrides;
  return {
    ...params,
    ...(o.source ? { source: o.source } : {}),
    ...(o.video ? { video: { ...params.video, ...o.video } } : {}),
    aiImages: o.aiImages?.mode === "off" ? { ...params.aiImages, mode: "off" } : params.aiImages,
    blocks: { ...params.blocks, ...(o.blocks ?? {}) },
  };
}

export function scenarioReason(s: Scenario, brief: BlogBrief, auto: boolean): string {
  if (!auto) return "закреплён в рецепте";
  return `интент «${brief.intent}»${brief.ymyl ? ", тема здоровья/денег/безопасности" : ""}${brief.topicDomain ? `, тема ${brief.topicDomain}` : ""}`;
}
