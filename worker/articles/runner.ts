/**
 * Раннер статьи: ведёт захваченную статью по этапам реестра подряд, пока не дойдёт до состояния ожидания
 * (модерация фото / модерация статьи / не хватило фото), конца или ошибки. После каждого этапа транзакционно
 * сохраняет stage/cursor и пишет ArtStageLog; расход пересчитывается из UsageLog (refId = id статьи).
 *
 * Переходы между этапами по умолчанию — по реестру (src/lib/articles/stages.ts) с двумя развилками:
 *  - после `select`: если включена модерация фото до текста (article.photoReview) → PHOTO_REVIEW;
 *  - после `assemble`: если модерации фото не было (photoReview=false) → REVIEW_PENDING (модерация статьи), иначе → publish.
 * Это перенос режимов 1/2 оригинала (отчёт 04, §1).
 */
import { prisma } from "@/lib/db";
import type { Article, ArtStatus } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import { articleCost } from "@/lib/articles/ai";
import type { ArticleCursor, ArticleFacts, ArticlePlan, ArticleRecipeSnapshot } from "@/lib/articles/types";
import { nextStage, stageLabel, type StageKey } from "@/lib/articles/stages";
import { STAGES, StopRequested, type ArtStageCtx, type ArtStageResult } from "./stages";
import { finishLog, recordError } from "./journal";
import { MAX_ATTEMPTS, releaseArticle, renewLease } from "./queue";
import { log } from "../log";

const TRANSIENT = /timeout|timed out|fetch failed|econnreset|econnrefused|socket hang up|lock wait|deadlock|too many connections|ETIMEDOUT|EAI_AGAIN/i;

function isTransient(err: Error): boolean {
  if (err instanceof AiError) return err.cls.kind === "transient";
  return TRANSIENT.test(err.message);
}

function isFatalRun(err: Error): boolean {
  return err instanceof AiError && err.cls.kind === "fatal_run";
}

export async function processArticle(article: Article, workerId: string, shuttingDown: () => boolean): Promise<void> {
  const ac = new AbortController();
  let stopping = false;
  const heartbeat = setInterval(async () => {
    try {
      const r = await renewLease(article.id, workerId);
      if (r.lost && !ac.signal.aborted) {
        log.warn(`article ${article.id}: lease lost; aborting local execution`);
        ac.abort(new Error("lease lost"));
      } else if (r.stopping && !stopping) {
        stopping = true;
        ac.abort(new StopRequested());
      }
      if (shuttingDown() && !ac.signal.aborted) ac.abort(new Error("worker shutting down"));
    } catch (e) {
      log.warn(`heartbeat failed for article ${article.id}`, e);
    }
  }, 20_000);

  let current: Article = article;
  let logId: string | null = null;
  try {
    const site = await prisma.artSite.findUnique({ where: { id: current.siteId } });
    if (!site) {
      await fail(current, "Сайт статьи не найден");
      return;
    }
    const access = site.accessId ? await prisma.siteAccess.findUnique({ where: { id: site.accessId } }) : null;
    const userId = current.createdById ?? "";
    if (!userId) {
      await fail(current, "У статьи не указан пользователь: некому выбрать ключи ИИ");
      return;
    }

    // Цикл этапов: подряд, пока не ожидание/конец/ошибка.
    for (let guard = 0; guard < 40; guard++) {
      const stage = current.stage as StageKey;
      const handler = STAGES[stage];
      if (!handler) {
        await fail(current, `Этап «${stageLabel(stage)}» ещё не реализован в этой версии сервиса. Всё сделанное сохранено.`);
        return;
      }
      const started = await prisma.artStageLog.create({ data: { articleId: current.id, stage, status: "running" } });
      logId = started.id;
      const costBefore = await articleCost(current.id);
      log.info(`article ${current.id.slice(0, 8)} stage=${stage} attempt=${current.attempts}`);

      const recipe = current.recipe as unknown as ArticleRecipeSnapshot;
      let cursor = (current.cursor ?? {}) as ArticleCursor;
      let facts = (current.facts ?? {}) as ArticleFacts;
      let plan = (current.plan ?? null) as ArticlePlan | null;
      let lastLabel = "";

      const ctx: ArtStageCtx = {
        article: current,
        site,
        access,
        creds: () => {
          if (!access || !access.username || !access.appPasswordEnc) throw new Error("У сайта нет доступа WordPress: укажите логин и Application Password в разделе «Сайты».");
          return { baseUrl: access.baseUrl, username: access.username, appPassword: decryptSecret(access.appPasswordEnc) };
        },
        recipe,
        cursor,
        facts,
        plan,
        ai: { userId, teamId: current.teamId, articleId: current.id, siteId: site.id, signal: ac.signal },
        signal: ac.signal,
        tick: async (label) => {
          if (ac.signal.aborted) throw ac.signal.reason instanceof StopRequested ? ac.signal.reason : new Error("aborted");
          const r = await renewLease(current.id, workerId);
          if (r.lost) {
            ac.abort(new Error("lease lost"));
            throw new Error("lease lost");
          }
          if (r.stopping) {
            stopping = true;
            ac.abort(new StopRequested());
            throw new StopRequested();
          }
          if (label && label !== lastLabel) {
            lastLabel = label;
            await prisma.artStageLog.update({ where: { id: started.id }, data: { summary: label } }).catch(() => {});
          }
        },
        log: (msg, extra) => log.info(`[${stage} ${current.id.slice(0, 8)}] ${msg}`, extra),
        save: async (patch) => {
          if (patch.cursor) cursor = patch.cursor;
          if (patch.facts) facts = patch.facts;
          if (patch.plan !== undefined) plan = patch.plan;
          ctx.cursor = cursor;
          ctx.facts = facts;
          ctx.plan = plan;
          await prisma.article.update({
            where: { id: current.id },
            data: {
              ...(patch.cursor ? { cursor: cursor as object } : {}),
              ...(patch.facts ? { facts: facts as object } : {}),
              ...(patch.plan !== undefined ? { plan: (plan ?? undefined) as object | undefined } : {}),
              ...(patch.note !== undefined ? { note: patch.note } : {}),
            },
          });
        },
      };

      let result: ArtStageResult;
      try {
        result = await handler(ctx);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (err instanceof StopRequested || (ac.signal.aborted && ac.signal.reason instanceof StopRequested)) {
          await finishLog(started.id, "skipped", "Остановлено пользователем");
          await prisma.article.update({ where: { id: current.id }, data: { status: "STOPPED", workerId: null, leaseUntil: null, stopRequested: false } });
          log.info(`article ${current.id} stopped by user`);
          return;
        }
        if (shuttingDown() || /lease lost/.test(err.message)) {
          await finishLog(started.id, "skipped", "Воркер перезапускается");
          if (!/lease lost/.test(err.message)) await releaseArticle(current.id, 0);
          return;
        }
        if (isTransient(err) && current.attempts < MAX_ATTEMPTS) {
          const delay = backoffMs(current.attempts);
          await finishLog(started.id, "error", undefined, `Временная ошибка, повтор через ${Math.round(delay / 1000)} с: ${err.message}`);
          await releaseArticle(current.id, delay, `Повтор этапа «${stageLabel(stage)}»: ${err.message.slice(0, 300)}`);
          return;
        }
        const reason = isFatalRun(err) ? `Нет рабочего ключа ИИ: ${err.message}` : err.message;
        await finishLog(started.id, "error", undefined, reason);
        await fail(current, reason, stage);
        return;
      }

      const cost = (await articleCost(current.id)) - costBefore;
      if (result.fatal) {
        await finishLog(started.id, "error", result.summary, result.fatal, result.details, cost);
        await fail(current, result.fatal, stage);
        return;
      }
      if (result.retryInMs && result.retryInMs > 0) {
        await finishLog(started.id, "skipped", result.summary ?? "Повтор позже", undefined, result.details, cost);
        await releaseArticle(current.id, result.retryInMs, result.summary ?? null);
        return;
      }
      await finishLog(started.id, "done", result.summary, undefined, result.details, cost);

      // Куда дальше
      let next: StageKey | null;
      let wait: { wait: ArtStatus; note?: string } | null = null;
      if (result.next && typeof result.next === "object") {
        wait = result.next;
        next = null;
      } else if (typeof result.next === "string") {
        next = result.next;
      } else {
        next = nextStage(current.format, stage);
        if (stage === "select" && current.photoReview) wait = { wait: "PHOTO_REVIEW", note: "Фото отобраны, ждут модерации" };
        if (stage === "assemble" && !current.photoReview) wait = { wait: "REVIEW_PENDING", note: "Статья собрана, ждёт модерации" };
      }

      if (wait) {
        const after = next ?? nextStage(current.format, stage) ?? stage;
        await prisma.article.update({ where: { id: current.id }, data: { status: wait.wait, stage: after, workerId: null, leaseUntil: null, attempts: 0, note: wait.note ?? null, costUsd: await articleCost(current.id) } });
        log.info(`article ${current.id} waits in ${wait.wait} (next stage ${after})`);
        return;
      }
      if (!next) {
        await prisma.article.update({ where: { id: current.id }, data: { status: "COMPLETED", stage: "done", workerId: null, leaseUntil: null, attempts: 0, finishedAt: new Date(), note: null, costUsd: await articleCost(current.id) } });
        log.info(`article ${current.id} completed`);
        return;
      }
      current = await prisma.article.update({ where: { id: current.id }, data: { stage: next, attempts: 0, note: null, costUsd: await articleCost(current.id) } });
      if (ac.signal.aborted) {
        await releaseArticle(current.id, 0);
        return;
      }
    }
    await fail(current, "Слишком много переходов между этапами за один проход — проверьте журнал статьи");
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    log.error(`article ${current.id} crashed`, err);
    if (logId) await finishLog(logId, "error", undefined, err.message).catch(() => {});
    await fail(current, err.message).catch(() => {});
  } finally {
    clearInterval(heartbeat);
  }
}

async function fail(a: Article, reason: string, stage?: string) {
  const text = reason.slice(0, 4000);
  await prisma.article.update({ where: { id: a.id }, data: { status: "FAILED", workerId: null, leaseUntil: null, error: text, errorStage: stage ?? a.stage, costUsd: await articleCost(a.id).catch(() => a.costUsd) } });
  await recordError({ teamId: a.teamId, siteId: a.siteId, articleId: a.id, stage: stage ?? a.stage, message: text });
  log.warn(`article ${a.id} failed at ${stage ?? a.stage}: ${text.slice(0, 200)}`);
}
