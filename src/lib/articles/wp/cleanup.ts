/**
 * Очистка после публикации. Порт supabase/functions/_shared/cleanupPublishedPhotos.ts и cleanup-published-photos/index.ts
 * без chain/бюджетов. Вызовы — из этапа publish (точечно) и из cron воркера (пакетно). Строки статей не удаляются (см. ниже).
 *
 * Отличия от оригинала (08-plan, отчёт 04 §11): отпечатки фото (ArtPhotoFingerprint) НЕ удаляются — иначе через сутки
 * фото снова могло попасть на другой сайт; журнал расходов (UsageLog по refId) тоже остаётся.
 */
import { prisma } from "@/lib/db";
import { purgeArticleFilesKeepThumbs } from "@/lib/articles/storage";

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

  // Миниатюры фото статьи и добавленных ИИ кандидатов остаются для экрана решений ИИ-модерации (аудит 2026-10-14).
  const aiResults = await prisma.artAiModerationResult.findMany({ where: { articleId }, select: { added: true } });
  const keepCand = new Set(aiResults.flatMap((r) => ((r.added as Array<{ candidateId?: string }> | null) ?? []).map((x) => String(x?.candidateId || ""))).filter(Boolean));
  await purgeArticleFilesKeepThumbs(articleId, keepCand);
  await prisma.$transaction([
    ...article.photos.map((p) => prisma.artPhoto.update({ where: { id: p.id }, data: { publicUrl: p.wpUrl ?? "", path: "" } })),
    prisma.artPhotoCandidate.updateMany({ where: { articleId, id: { notIn: [...keepCand] } }, data: { path: "", thumbPath: "" } }),
    prisma.artPhotoCandidate.updateMany({ where: { articleId, id: { in: [...keepCand] } }, data: { path: "" } }),
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

/*
 * Удаление строк опубликованных статей (бывший purgeOldArticles, перенос cleanup-published-articles оригинала: строка
 * Article удалялась через сутки после публикации) убрано по аудиту 2026-10-14 (stability.md §0). Вместе со строкой
 * каскадом пропадали журнал этапов, ошибки, события модерации, решения ИИ-модерации, расходы на экранах, защита от
 * повторного ключа и от пересжатых копий фото, досылка отчёта в Google Таблицу. Строки весят килобайты — храним всё.
 * Место освобождают только файлы: purgePublishedPhotos (сразу после публикации) и purgePublishedBacklog (cron).
 * Файлы статей, у которых не все фото загрузились в медиатеку, не трогаем: запись на сайте ссылается на наше хранилище.
 */
