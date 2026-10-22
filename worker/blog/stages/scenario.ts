/**
 * Этап `scenario` (сразу после research, без ИИ): определяет тип статьи по брифу (src/lib/blog/scenarios.ts) и
 * записывает итоговые параметры в снимок сценария поста — их видят все следующие этапы (раннер перечитывает пост).
 * Идемпотентен: тип уже определён — пропуск.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { YMYL_HINT, applyScenario, deferredFormatOf, pickScenario, scenarioReason, type AppliedScenario } from "@/lib/blog/scenarios";
import type { StageHandler } from "./index";

export const scenarioStage: StageHandler = async (ctx) => {
  const { post, recipe, brief } = ctx;
  if (!brief) return { next: "research", summary: "Нет брифа — возврат к исследованию" };
  const already = (recipe as { scenario?: AppliedScenario }).scenario;
  if (already?.key) return { summary: `Тип статьи уже определён: ${already.label}`, details: { skipped: true } };
  const topic = (post.topic ?? "").trim();
  const deferred = deferredFormatOf(topic);
  if (deferred && (recipe.params.scenario ?? "auto") === "auto") return { fatal: `Формат «${deferred.label}» пока не делаем (тема «${topic}»). Статья остановлена до расходов на фото и текст.` };
  const picked = pickScenario(recipe.params.scenario, brief, post.keyword, topic);
  if (!picked) {
    const applied: AppliedScenario = { key: "manual", label: "Вручную (параметры сценария)", reason: "определение типа статьи выключено в сценарии", auto: false };
    await prisma.blogPost.update({ where: { id: post.id }, data: { recipe: { ...recipe, scenario: applied } as unknown as Prisma.InputJsonValue } });
    return { summary: "Тип статьи не определяется: вручную — параметры сценария как есть" };
  }
  const { scenario, auto, n } = picked;
  const ymyl = brief.ymyl === true;
  const params = applyScenario(recipe.params, scenario, ymyl);
  const hint = [scenario.outlineHint, ymyl ? YMYL_HINT : ""].filter(Boolean).join(" ");
  const applied: AppliedScenario = { key: scenario.key, label: `${scenario.label}${ymyl ? " · здоровье" : ""}`, reason: scenarioReason(scenario, brief, auto, topic), auto, outlineHint: hint || undefined, structure: scenario.structure, n, ymyl };
  await prisma.blogPost.update({ where: { id: post.id }, data: { recipe: { ...recipe, params, scenario: applied } as unknown as Prisma.InputJsonValue } });
  const what = [`основа: ${params.source === "video" ? "лучшее видео" : "исследование"}`, `видео: ${params.video.embed === "auto" ? "если найдётся" : "нет"}`, `ИИ-картинки: ${params.aiImages.mode === "steps" ? "да" : "нет"}`];
  if (n) what.unshift(`пунктов: ${n}`);
  return { summary: `Тип статьи «${applied.label}» (${applied.reason}) · ${what.join(", ")}`, details: { scenario: scenario.key, structure: scenario.structure, n, ymyl, auto, reason: applied.reason, params: { source: params.source, video: params.video, aiImages: params.aiImages.mode } } };
};
