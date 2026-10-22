/**
 * Этап `scenario` (сразу после research, без ИИ): выбирает сценарий статьи по брифу (src/lib/blog/scenarios.ts) и
 * записывает итоговые параметры в снимок рецепта поста — их видят все следующие этапы (раннер перечитывает пост).
 * Идемпотентен: сценарий уже выбран — пропуск.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyScenario, pickScenario, scenarioReason, type AppliedScenario } from "@/lib/blog/scenarios";
import type { StageHandler } from "./index";

export const scenarioStage: StageHandler = async (ctx) => {
  const { post, recipe, brief } = ctx;
  if (!brief) return { next: "research", summary: "Нет брифа — возврат к исследованию" };
  const already = (recipe as { scenario?: AppliedScenario }).scenario;
  if (already?.key) return { summary: `Сценарий уже выбран: ${already.label}`, details: { skipped: true } };
  const picked = pickScenario(recipe.params.scenario, brief, post.keyword);
  if (!picked) {
    const applied: AppliedScenario = { key: "manual", label: "Вручную (параметры рецепта)", reason: "выбор сценария выключен в рецепте", auto: false };
    await prisma.blogPost.update({ where: { id: post.id }, data: { recipe: { ...recipe, scenario: applied } as unknown as Prisma.InputJsonValue } });
    return { summary: "Сценарий: вручную — параметры рецепта как есть" };
  }
  const { scenario, auto } = picked;
  const params = applyScenario(recipe.params, scenario);
  const applied: AppliedScenario = { key: scenario.key, label: scenario.label, reason: scenarioReason(scenario, brief, auto), auto, outlineHint: scenario.outlineHint };
  await prisma.blogPost.update({ where: { id: post.id }, data: { recipe: { ...recipe, params, scenario: applied } as unknown as Prisma.InputJsonValue } });
  const what = [`основа: ${params.source === "video" ? "лучшее видео" : "исследование"}`, `видео: ${params.video.embed === "auto" ? "если найдётся" : "нет"}`, `ИИ-картинки: ${params.aiImages.mode === "steps" ? "да" : "нет"}`];
  return { summary: `Сценарий «${scenario.label}» (${applied.reason}) · ${what.join(", ")}`, details: { scenario: scenario.key, auto, reason: applied.reason, params: { source: params.source, video: params.video, aiImages: params.aiImages.mode } } };
};
