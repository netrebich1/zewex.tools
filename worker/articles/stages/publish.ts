/**
 * Этап `publish` (78): публикация статьи в WordPress. Поток — src/lib/articles/wp/publish.ts; здесь только
 * классификация ошибок и расписание повторов (оригинал publish-worker/index.ts:8-24, 258-320 — очередь у нас своя).
 *
 *  - качество / нет доступа WordPress / 401, 403, 4xx (rest_*) → fatal (оригинал classify: permanent);
 *  - 5xx, 429, 408, таймаут, сеть → повтор через 1/3/5/10/15 мин по Article.publishAttempts, после 6 попыток → fatal;
 *  - медиатека сайта сломана (WP_MEDIA_DOWN) → повтор через 20 мин, попытка не тратится (оригинал :284-294).
 * После успеха — purgePublishedPhotos (файлы статьи больше не нужны, фото уже на сайте); статус COMPLETED ставит раннер.
 * Статье из Google Таблицы после успеха пишется отчёт в её строку (lib/articles/sheets.writeArticleResult).
 */
import { WpError } from "@/lib/pins/wp/client";
import { AiError } from "@/lib/pins/ai/errors";
import { prisma } from "@/lib/db";
import { MediaDownError, QualityError, publishArticle, type PublishOutcome } from "@/lib/articles/wp/publish";
import { purgePublishedPhotos } from "@/lib/articles/wp/cleanup";
import { writeArticleResult } from "@/lib/articles/sheets";
import type { ArtStageHandler } from "./index";

/** оригинал publish-worker/index.ts:8 */
export const MAX_PUBLISH_ATTEMPTS = 6;
/** Минуты между попытками (оригинал :12) */
export const PUBLISH_BACKOFF_MIN = [1, 3, 5, 10, 15] as const;
/** Медиатека на хостинге сломана — проверяем раз в 20 минут (оригинал :289) */
const MEDIA_DOWN_RETRY_MS = 20 * 60_000;

const TRANSIENT_RE = /\b(408|429|500|502|503|504|52\d)\b|timeout|timed out|нет ответа|fetch failed|abort|connection|network|temporarily|econnreset|eai_again|origin unreachable|origin error/i;

type Verdict = { kind: "fatal"; message: string } | { kind: "transient"; message: string };

/** Классификация (оригинал classify :17-24): 401/403/404/rest_* и качество — permanent, остальное — transient. */
function classify(e: unknown): Verdict {
  if (e instanceof QualityError) return { kind: "fatal", message: `${e.message}. Исправьте статью (перепишите секции / пересоберите) и запустите публикацию снова.` };
  if (e instanceof WpError) {
    if (e.status === 401 || e.status === 403) {
      return { kind: "fatal", message: `WordPress отклонил доступ (HTTP ${e.status}): проверьте логин, Application Password и роль пользователя в разделе «Сайты». ${e.message}` };
    }
    if (e.status === 413) return { kind: "fatal", message: `Сайт не принимает файл такого размера (HTTP 413): увеличьте upload_max_filesize / client_max_body_size на хостинге. ${e.message}` };
    if (e.status >= 500 || e.status === 429 || e.status === 408 || e.status === 0) return { kind: "transient", message: e.message };
    if (e.status >= 400) return { kind: "fatal", message: `WordPress отказал (HTTP ${e.status}${e.code ? `, ${e.code}` : ""}): ${e.message}` };
    return { kind: "transient", message: e.message };
  }
  if (e instanceof AiError) return { kind: e.cls.kind === "transient" ? "transient" : "fatal", message: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  if (/нет доступа WordPress|Application Password/i.test(msg)) return { kind: "fatal", message: msg };
  if (/Недопустимый|Некорректный адрес|приватную сеть|Хост не найден/i.test(msg)) return { kind: "fatal", message: `Адрес сайта: ${msg}` };
  if (TRANSIENT_RE.test(msg)) return { kind: "transient", message: msg };
  // оригинал: неизвестное — transient
  return { kind: "transient", message: msg };
}

export const publish: ArtStageHandler = async (ctx) => {
  const { article } = ctx;
  let outcome: PublishOutcome;
  try {
    outcome = await publishArticle(ctx);
  } catch (e) {
    // Остановка пользователем / потеря lease — отдаём раннеру (без импорта класса из ./index: он импортирует этот файл)
    if (ctx.signal.aborted || (e instanceof Error && e.name === "StopRequested")) throw e;
    if (e instanceof MediaDownError) {
      return { retryInMs: MEDIA_DOWN_RETRY_MS, summary: e.message, details: { code: e.code, publishAttempts: article.publishAttempts } };
    }
    const v = classify(e);
    if (v.kind === "fatal") return { fatal: v.message, details: e instanceof QualityError ? { problems: e.problems } : undefined };

    const attempt = article.publishAttempts + 1;
    await prisma.article.update({ where: { id: article.id }, data: { publishAttempts: attempt } });
    if (attempt >= MAX_PUBLISH_ATTEMPTS) {
      return { fatal: `Публикация не удалась после ${attempt} попыток: ${v.message}`, details: { publishAttempts: attempt } };
    }
    const minutes = PUBLISH_BACKOFF_MIN[Math.min(attempt - 1, PUBLISH_BACKOFF_MIN.length - 1)];
    return {
      retryInMs: minutes * 60_000,
      summary: `Попытка ${attempt} из ${MAX_PUBLISH_ATTEMPTS} не удалась, повтор через ${minutes} мин: ${v.message.slice(0, 300)}`,
      details: { publishAttempts: attempt, error: v.message },
    };
  }

  // Исходники фото больше не нужны — они уже на сайте (оригинал :444 cleanupProjectPhotos после approve).
  let purged = false;
  if (outcome.failedUploads === 0) {
    const r = await purgePublishedPhotos(article.id, { force: true }).catch((e) => {
      ctx.log(`очистка файлов не удалась: ${e instanceof Error ? e.message : String(e)}`);
      return { purged: false, reason: "ошибка", photos: 0 };
    });
    purged = r.purged;
    if (!r.purged && r.reason) ctx.log(`файлы статьи оставлены: ${r.reason}`);
  }

  // Отчёт в Google Таблицу, если статья пришла оттуда: ссылка, дата и статус в её строку (оригинал stage7 :452-481).
  // На публикацию не влияет; несохранённое дошлёт resyncSheets из worker/cron.ts.
  let sheet: string | undefined;
  if (article.sheetRow) {
    const r = await writeArticleResult(article.id, outcome.status === "draft" ? "draft" : "publish", outcome.url);
    sheet = r.ok ? "записано" : r.error;
    if (!r.ok) ctx.log(`отчёт в Google Таблицу не записан: ${r.error}`);
  }

  const photosNote = outcome.failedUploads ? `, ${outcome.failedUploads} фото остались по публичной ссылке` : "";
  const summary = `${outcome.created ? "Создана" : "Обновлена"} запись ${outcome.status === "draft" ? "(черновик)" : ""} ${outcome.url} — фото на сайте ${outcome.photosTotal - outcome.failedUploads}/${outcome.photosTotal}${photosNote}`.replace(/\s+/g, " ");
  return {
    summary,
    details: {
      wpPostId: outcome.postId,
      wpUrl: outcome.url,
      wpStatus: outcome.status,
      created: outcome.created,
      uploaded: outcome.uploaded,
      reused: outcome.reused,
      failedUploads: outcome.failedUploads,
      category: outcome.category ? { id: outcome.category.id, name: outcome.category.name, source: outcome.category.source } : { id: article.wpCategoryId, source: "saved" },
      fixed: outcome.fixed,
      purged,
      ...(sheet ? { sheet } : {}),
    },
  };
};
