/**
 * Этап `publish`: публикация в WordPress (src/lib/blog/wp/publish.ts) + классификация ошибок и расписание повторов —
 * как у статей: 401/403/4xx — fatal; 5xx/429/сеть — повтор 1/3/5/10/15 мин (окно ~1 ч); медиатека сломана — раз в 20 мин;
 * часть фото не загрузилась — догрузка с растущей паузой. Окончательная ошибка — PUBLISH_ERROR (раннер).
 */
import { WpError } from "@/lib/pins/wp/client";
import { AiError } from "@/lib/pins/ai/errors";
import { prisma } from "@/lib/db";
import { MediaDownError, PartialUploadError, publishPost, type PublishOutcome } from "@/lib/blog/wp/publish";
import type { StageHandler } from "./index";

const PUBLISH_BACKOFF_MIN = [1, 3, 5, 10, 15] as const;
const MEDIA_DOWN_RETRY_MS = 20 * 60_000;
const PARTIAL_UPLOAD_BACKOFF_MIN = [5, 10, 20, 30, 60];
const TRANSIENT_RE = /\b(408|429|500|502|503|504|52\d)\b|timeout|timed out|нет ответа|fetch failed|abort|connection|network|temporarily|econnreset|eai_again|origin unreachable|origin error/i;

type Verdict = { kind: "fatal"; message: string } | { kind: "transient"; message: string };

function classify(e: unknown): Verdict {
  if (e instanceof WpError) {
    if (e.status === 401 || e.status === 403) return { kind: "fatal", message: `WordPress отклонил доступ (HTTP ${e.status}): проверьте логин, Application Password и роль пользователя в разделе «Сайты». ${e.message}` };
    if (e.status === 413) return { kind: "fatal", message: `Сайт не принимает файл такого размера (HTTP 413). ${e.message}` };
    if (e.status >= 500 || e.status === 429 || e.status === 408 || e.status === 0) return { kind: "transient", message: e.message };
    if (e.status >= 400) return { kind: "fatal", message: `WordPress отказал (HTTP ${e.status}${e.code ? `, ${e.code}` : ""}): ${e.message}` };
    return { kind: "transient", message: e.message };
  }
  if (e instanceof AiError) return { kind: e.cls.kind === "transient" ? "transient" : "fatal", message: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  if (/нет доступа WordPress|Application Password|HTML статьи пуст/i.test(msg)) return { kind: "fatal", message: msg };
  if (/Недопустимый|Некорректный адрес|приватную сеть|Хост не найден/i.test(msg)) return { kind: "fatal", message: `Адрес сайта: ${msg}` };
  if (TRANSIENT_RE.test(msg)) return { kind: "transient", message: msg };
  return { kind: "transient", message: msg };
}

export const publish: StageHandler = async (ctx) => {
  const { post } = ctx;
  let outcome: PublishOutcome;
  try {
    outcome = await publishPost(ctx);
  } catch (e) {
    if (ctx.signal.aborted || (e instanceof Error && e.name === "StopRequested")) throw e;
    if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
    if (e instanceof PartialUploadError) {
      const minutes = PARTIAL_UPLOAD_BACKOFF_MIN[Math.min(ctx.retries.planned, PARTIAL_UPLOAD_BACKOFF_MIN.length - 1)];
      return { retryInMs: minutes * 60_000, retryKind: "planned", summary: `${e.message}; повтор через ${minutes} мин`, giveUp: `WordPress так и не принял все фото (не хватает ${e.failed} из ${e.total}). Проверьте хостинг и нажмите «Повторить публикацию».`, details: { failedUploads: e.failed, photosTotal: e.total, onSite: e.onSite } };
    }
    if (e instanceof MediaDownError) {
      return { retryInMs: MEDIA_DOWN_RETRY_MS, retryKind: "planned", summary: e.message, giveUp: "Медиатека WordPress не принимает фото уже около суток. Исправьте на хостинге и нажмите «Повторить публикацию».", details: { code: e.code, publishAttempts: post.publishAttempts } };
    }
    const v = classify(e);
    if (v.kind === "fatal") return { fatal: v.message };
    const attempt = post.publishAttempts + 1;
    await prisma.blogPost.update({ where: { id: post.id }, data: { publishAttempts: attempt } });
    const minutes = PUBLISH_BACKOFF_MIN[Math.min(ctx.retries.transient, PUBLISH_BACKOFF_MIN.length - 1)];
    return { retryInMs: minutes * 60_000, retryKind: "transient", summary: `Попытка публикации ${attempt} не удалась, повтор через ${minutes} мин: ${v.message.slice(0, 300)}`, giveUp: `Публикация не удалась после ${attempt} попыток примерно за час: ${v.message}`, details: { publishAttempts: attempt, error: v.message } };
  }
  const summary = `${outcome.created ? "Создана" : "Обновлена"} запись ${outcome.status === "draft" ? "(черновик)" : ""} ${outcome.url} — фото на сайте ${outcome.photosTotal - outcome.failedUploads}/${outcome.photosTotal}`.replace(/\s+/g, " ");
  return {
    summary,
    details: { wpPostId: outcome.postId, wpUrl: outcome.url, wpStatus: outcome.status, created: outcome.created, uploaded: outcome.uploaded, reused: outcome.reused, failedUploads: outcome.failedUploads, category: outcome.category ? { id: outcome.category.id, name: outcome.category.name, source: outcome.category.source } : { id: post.wpCategoryId, source: "saved" } },
  };
};
