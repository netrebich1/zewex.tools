/**
 * Этап `scenario` (сразу после research, без ИИ): определяет тип статьи по брифу (src/lib/blog/scenarios.ts) и
 * записывает итоговые параметры в снимок сценария поста — их видят все следующие этапы (раннер перечитывает пост).
 * Идемпотентен: тип уже определён — пропуск.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyScenario, pickScenario, scenarioReason, type AppliedScenario } from "@/lib/blog/scenarios";
import type { StageHandler } from "./index";

export const scenarioStage: StageHandler = async (ctx) => {
  const { post, recipe, brief } = ctx;
  if (!brief) return { next: "research", summary: "Нет брифа — возврат к исследованию" };
  const already = (recipe as { scenario?: AppliedScenario }).scenario;
  if (already?.key) return { summary: `Тип статьи уже определён: ${already.label}`, details: { skipped: true } };
  const picked = pickScenario(recipe.params.scenario, brief, post.keyword);
  if (!picked) {
    const applied: AppliedScenario = { key: "manual", label: "Вручную (параметры сценария)", reason: "определение типа статьи выключено в сценарии", auto: false };
    await prisma.blogPost.update({ where: { id: post.id }, data: { recipe: { ...recipe, scenario: applied } as unknown as Prisma.InputJsonValue } });
    return { summary: "Тип статьи не определяется: вручную — параметры сценария как есть" };
  }
  const { scenario, auto } = picked;
  const params = applyScenario(recipe.params, scenario);
  const applied: AppliedScenario = { key: scenario.key, label: scenario.label, reason: scenarioReason(scenario, brief, auto), auto, outlineHint: scenario.outlineHint };
  await prisma.blogPost.update({ where: { id: post.id }, data: { recipe: { ...recipe, params, scenario: applied } as unknown as Prisma.InputJsonValue } });
  const what = [`основа: ${params.source === "video" ? "лучшее видео" : "исследование"}`, `видео: ${params.video.embed === "auto" ? "если найдётся" : "нет"}`, `ИИ-картинки: ${params.aiImages.mode === "steps" ? "да" : "нет"}`];
  return { summary: `Тип статьи «${scenario.label}» (${applied.reason}) · ${what.join(", ")}`, details: { scenario: scenario.key, auto, reason: applied.reason, params: { source: params.source, video: params.video, aiImages: params.aiImages.mode } } };
};
