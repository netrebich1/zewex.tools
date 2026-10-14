/**
 * Очистка после публикации. Порт supabase/functions/_shared/cleanupPublishedPhotos.ts, cleanup-published-photos/index.ts
 * и cleanup-published-articles/index.ts без chain/бюджетов. Вызовы — из этапа publish (точечно) и из cron воркера (пакетно).
 *
 * Отличия от оригинала (08-plan, отчёт 04 §11): отпечатки фото (ArtPhotoFingerprint) НЕ удаляются — иначе через сутки
 * фото снова могло попасть на другой сайт; журнал расходов (UsageLog по refId) тоже остаётся.
 */
import { prisma } from "@/lib/db";
import { purgeArticleFiles } from "@/lib/articles/storage";

export type PurgeResult = { purged: boolean; reason?: string; photos: number };

/**
 * Удалить файлы статьи из хранилища после того, как все фото уже на сайте: ArtPhoto.publicUrl → wpUrl, пути пустые,
 * Article.purgedAt. Условия оригинала (cleanupProjectPhotos :35-46): очередь completed, у фото есть wp_url.
 * `force` — вызов из этапа publish, когда статус COMPLETED раннер поставит сразу после этапа.
 */
export async function purgePublishedPhotos(articleId: string, opts: { force?: boolean } = {}): Promise<PurgeResult> {
  const article = await prisma.article.findUnique({ where: { id: articleId }, include: { photos: true } });
  if (!article) return { purged: false, reason: "статья не найдена", photos: 0 };
  if (article.purgedAt) return { purged: false, reason: "уже очищена", photos: 0 };
  if (!opts.force && article.status !== "COMPLETED") return { purged: false, reason: `статус ${article.status}`, photos: 0 };
  if (!article.wpUrl) return { purged: false, reason: "записи на сайте нет", photos: 0 };
  const live = article.photos.filter((p) => !p.excluded);
  const notOnSite = live.filter((p) => !p.wpUrl);
  if (notOnSite.length) return { purged: false, reason: `не на сайте фото: ${notOnSite.map((p) => p.position).join(", ")}`, photos: 0 };

  await purgeArticleFiles(articleId);
  await prisma.$transaction([
    ...article.photos.map((p) => prisma.artPhoto.update({ where: { id: p.id }, data: { publicUrl: p.wpUrl ?? "", path: "", thumbPath: "" } })),
    prisma.artPhotoCandidate.updateMany({ where: { articleId }, data: { path: "", thumbPath: "" } }),
    prisma.article.update({ where: { id: articleId }, data: { purgedAt: new Date() } }),
  ]);
  return { purged: true, photos: article.photos.length };
}

/**
 * Пакетная очистка накопившихся опубликованных статей (оригинал cleanupBacklog :49-63) — для cron воркера.
 * Берём завершённые статьи с записью на сайте, ещё не очищенные, не моложе 5 минут (этап publish мог ещё не успеть сам).
 */
export async function purgePublishedBacklog(limit = 100): Promise<{ checked: number; purged: number }> {
  const rows = await prisma.article.findMany({
    where: { status: "COMPLETED", purgedAt: null, wpUrl: { not: null }, updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(limit, 1000)),
  });
  let purged = 0;
  for (const r of rows) {
    try {
      if ((await purgePublishedPhotos(r.id)).purged) purged++;
    } catch (e) {
      console.warn(`[articles cleanup] purge ${r.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked: rows.length, purged };
}

/**
 * Удаление из базы полностью опубликованных статей старше `days` суток (оригинал cleanup-published-articles:
 * cutoff 24 ч, критерии isFinalPublication :19-34). У нас «окончательная публикация» = COMPLETED, запись на сайте
 * в статусе publish, есть wpPostId/wpUrl, ошибок нет. Черновики на сайте (moderate_first без одобрения) не трогаем.
 * Записи и медиа на сайте остаются; каскадом удаляются фото, секции, кандидаты, журнал этапов, события, ошибки статьи.
 * ArtPhotoFingerprint и UsageLog не удаляются.
 */
export async function purgeOldArticles(days = 1, limit = 200): Promise<{ deleted: number; failed: number }> {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60_000);
  const rows = await prisma.article.findMany({
    where: { status: "COMPLETED", wpStatus: "publish", wpPostId: { not: null }, wpUrl: { not: null }, error: null, publishedAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { publishedAt: "asc" },
    take: Math.max(1, Math.min(limit, 1000)),
  });
  let deleted = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await purgeArticleFiles(r.id).catch((e) => console.warn(`[articles cleanup] files ${r.id}: ${e instanceof Error ? e.message : String(e)}`));
      await prisma.article.delete({ where: { id: r.id } });
      deleted++;
    } catch (e) {
      failed++;
      console.warn(`[articles cleanup] delete ${r.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { deleted, failed };
}
