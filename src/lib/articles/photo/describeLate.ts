/**
 * Позднее описание фото (cost-fixes-b, 2026-10-16, п.1): факты и описание 30–60 слов пишутся только фото, которые
 * остались в статье после модерации (PHOTO_REVIEW / ИИ-модерация), а не всем 110 оценённым. Вызывается в начале
 * этапа plan (первый текстовый этап) — расход попадает в окно этапа plan (UsageLog refId = статья, costs.ts → «Текст»).
 *
 * Кого описываем (`needsLateDescription` в rateSlim.ts):
 *  - rateMode = slim: все активные ArtPhoto без описания (тонкая оценка описание не сохраняет, `slimJudgement`);
 *  - rateMode = full (по умолчанию): только фото совсем без фактов и описания — это же делал этап sections по одному
 *    фото (`describePhoto`), теперь раньше и пачками; при полных фактах ничего не делаем.
 * Результат пишется в ArtPhoto.facts / ArtPhoto.description — ровно туда, откуда их читают plan (`buildPromptVars`,
 * `uniqueHeading`) и sections (`factsLine`, `photo_description`). Тонкие факты сливаются с полными: поле из тонкой
 * оценки остаётся, если полное описание его не дало. Идемпотентно: при повторе этапа описанные фото пропускаются.
 */
import { prisma } from "@/lib/db";
import type { ArtPhoto } from "@prisma/client";
import type { AiCtx } from "@/lib/articles/ai";
import type { ArticleRecipeSnapshot } from "@/lib/articles/types";
import { stageModel } from "@/lib/articles/prompts";
import { describePhoto, describePhotosBatch } from "@/lib/articles/text/photoDescribe";
import { sanitizeFacts } from "./factSanitize";
import type { NicheProfile } from "./profile";
import { needsLateDescription } from "./rateSlim";

export type LateDescribeCtx = {
  ai: AiCtx;
  recipe: ArticleRecipeSnapshot;
  signal?: AbortSignal;
  tick?: (label: string) => Promise<void>;
  log?: (msg: string) => void;
};

export type LateDescribeResult = { needed: number; described: number; failed: number; costUsd: number; calls: number };

const hasFacts = (facts: unknown) => !!sanitizeFacts(facts);

/** Фото статьи, которым ещё нужно описание. */
export function photosNeedingDescription(photos: ArtPhoto[], recipe: ArticleRecipeSnapshot): ArtPhoto[] {
  const mode = recipe.photoSearch?.rateMode;
  return photos.filter((p) => !p.excluded && needsLateDescription(p, mode, hasFacts(p.facts)));
}

/**
 * Описать недостающее и записать в ArtPhoto. Модель — как у оценки фото в рецепте (`rp_photo_rate`, обычно flash-lite),
 * иначе модель правила слота vision. Возвращает счётчики для сводки этапа («описаны N фото»).
 */
export async function describeLatePhotos(ctx: LateDescribeCtx, photos: ArtPhoto[], profile: NicheProfile, keyword: string): Promise<LateDescribeResult> {
  const todo = photosNeedingDescription(photos, ctx.recipe);
  const res: LateDescribeResult = { needed: todo.length, described: 0, failed: 0, costUsd: 0, calls: 0 };
  if (!todo.length) return res;
  const model = stageModel(ctx.recipe, "rp_photo_rate");
  await ctx.tick?.(`Описание фото: ${todo.length}`);
  const batch = await describePhotosBatch(ctx.ai, profile, keyword, todo, { model, signal: ctx.signal });
  res.costUsd += batch.costUsd;
  res.calls += batch.calls;

  const byId = new Map(todo.map((p) => [p.id, p]));
  const save = async (p: ArtPhoto, d: { facts: Record<string, unknown>; description: string }) => {
    // Тонкие факты оценки дополняют полные там, где модель описания оставила поле пустым.
    const prev = (sanitizeFacts(p.facts) ?? {}) as Record<string, string>;
    const facts: Record<string, unknown> = { ...prev, ...d.facts };
    await prisma.artPhoto.update({ where: { id: p.id }, data: { facts: facts as object, description: d.description } });
    res.described++;
  };
  for (const [id, d] of batch.described) {
    const p = byId.get(id);
    if (p) await save(p, d);
  }
  // Пропущенные пачкой — по одному (прежний фолбэк sections).
  for (const id of batch.failed) {
    const p = byId.get(id);
    if (!p) continue;
    await ctx.tick?.(`Описание фото ${p.position}`);
    const d = await describePhoto(ctx.ai, profile, keyword, p, model);
    res.calls++;
    if (d) await save(p, d);
    else {
      res.failed++;
      ctx.log?.(`фото ${p.position}: модель не дала описания — секцию опишет этап sections или она будет отложена`);
    }
  }
  return res;
}
