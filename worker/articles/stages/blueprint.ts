/**
 * Этап `blueprint` (шаг 65 оригинала, stage65-build-blueprint/index.ts) — без ИИ.
 * В оригинале собирал большой JSON-блюпринт в workflow_stages; для real_photo из него нужны были только
 * main_image/photo_facts секций — у нас это ArtSection.photoId + ArtPhoto. Поэтому этап стал проверкой целостности:
 * у каждой секции есть фото и заголовок, у каждого активного фото — ровно одна секция, plan.sections синхронизирован
 * с базой. При расхождении — возврат к `plan` (до двух раз, как bp65_retry в direct-pipeline:1021-1037).
 */
import type { ArticlePlan } from "@/lib/articles/types";
import type { ArtStageHandler } from "./index";
import { briefOf, loadActivePhotos, loadPhotoSections, MAX_PHOTO_POS } from "./plan";

export const blueprint: ArtStageHandler = async (ctx) => {
  const { article } = ctx;
  const photos = await loadActivePhotos(article.id);
  const sections = await loadPhotoSections(article.id);
  const photoIds = new Set(photos.map((p) => p.id));

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    if (!s.photoId || !photoIds.has(s.photoId)) problems.push(`секция ${s.position} без активного фото`);
    else if (seen.has(s.photoId)) problems.push(`фото секции ${s.position} уже занято другой секцией`);
    else seen.add(s.photoId);
    if (!s.heading.trim()) problems.push(`секция ${s.position} без заголовка`);
    if (s.position < 1 || s.position >= MAX_PHOTO_POS) problems.push(`секция с недопустимой позицией ${s.position}`);
  }
  const orphanPhotos = photos.filter((p) => !seen.has(p.id));
  if (orphanPhotos.length) problems.push(`фото без секции: ${orphanPhotos.map((p) => p.position).join(", ")}`);
  if (!sections.length) problems.push("нет секций");

  if (problems.length) {
    const retries = Number(ctx.cursor.blueprintRetries ?? 0);
    // Написанные секции есть — пересборка плана их стёрла бы; останавливаемся с понятной ошибкой.
    const written = sections.filter((s) => s.status === "written" && s.html?.trim());
    if (retries >= 2 || written.length) {
      return { fatal: `Структура статьи не сходится: ${problems.join("; ")}. ${written.length ? "Есть написанные секции — " : ""}проверьте фото и секции статьи и повторите с этапа «План по фото».` };
    }
    await ctx.save({ cursor: { ...ctx.cursor, blueprintRetries: retries + 1 } });
    ctx.log(`структура не сходится (${problems.join("; ")}) — возврат к плану (${retries + 1}/2)`);
    return { next: "plan", summary: `Возврат к плану: ${problems.join("; ")}` };
  }

  const planNow: ArticlePlan = ctx.plan ?? { h1: article.h1, title: article.metaTitle, metaDescription: article.metaDescription, slug: article.slug };
  const synced: ArticlePlan = {
    ...planNow,
    order: sections.map((s) => s.photoId!),
    sections: sections.map((s) => ({ position: s.position, photoId: s.photoId, heading: s.heading, brief: briefOf(s) })),
    // Как в оригинале (stage65:548): год сборки — справочно; в мета год берётся только из ключа (stage77).
    blueprintYear: new Date().getFullYear(),
    totalSections: sections.length,
  };
  const cursor = { ...ctx.cursor };
  delete cursor.blueprintRetries;
  await ctx.save({ plan: synced, cursor });

  return { summary: `Структура проверена: ${sections.length} секций, ${photos.length} фото`, details: { sections: sections.length, photos: photos.length } };
};
