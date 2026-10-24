/**
 * Раннер статьи: ведёт захваченную статью по этапам реестра подряд, пока не дойдёт до состояния ожидания
 * (модерация фото / модерация статьи / не хватило фото), конца или ошибки. После каждого этапа транзакционно
 * сохраняет stage/cursor и пишет ArtStageLog; расход пересчитывается из UsageLog (refId = id статьи).
 *
 * Переходы между этапами по умолчанию — по реестру (src/lib/articles/stages.ts) с двумя развилками:
 *  - после `select`: если включена модерация фото до текста (article.photoReview) или на сайте действует ИИ-модерация
 *    фото (aiModerationOn: настройка сайта + мастер-выключатель) → PHOTO_REVIEW;
 *  - после `assemble`: если модерации фото не было (photoReview=false) → REVIEW_PENDING (модерация статьи), иначе → publish.
 * Это перенос режимов 1/2 оригинала (отчёт 04, §1).
 *
 * Сбои (src/lib/articles/errors.ts, аудит устойчивости 2026-10-14):
 *  - временные (429/5xx/сеть/база) — повтор с растущей паузой, 8 повторов ≈ 1 ч, затем FAILED;
 *  - ответ модели не в том формате — до 3 отложенных повторов этапа;
 *  - нет средств / ключ отклонён / нет правила — статья ждёт в очереди и продолжает сама, когда ключ заработает;
 *  - повторы, которые просит этап (retryInMs), — с потолком по этапу;
 *  - окончательная ошибка: FAILED, на этапе publish — PUBLISH_ERROR (вкладка «Ошибки» публикаций и её кнопки повтора).
 * Серия повторов считается по журналу этапов (journal.ts retryStreak), поэтому плановые повторы не тратят счётчик
 * attempts — он остаётся счётчиком прерываний воркера (queue.ts MAX_ATTEMPTS).
 * Каждая окончательная ошибка и первое ожидание ключа пишутся в ArtError; временные повторы видны в заметке статьи.
 */
import { eventText, logEventByArtSite } from "@/lib/projects/events";
import { prisma } from "@/lib/db";
import type { Article, ArtStatus } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";
import { articleCost } from "@/lib/articles/ai";
import { aiModerationOn, type ArticleCursor, type ArticleFacts, type ArticlePlan, type ArticleRecipeSnapshot } from "@/lib/articles/types";
import { nextStage, stageLabel, type StageKey } from "@/lib/articles/stages";
import { markArticleStatus } from "@/lib/articles/sheets";
import { classifyFailure, inWords, isTransientError, retryPlan, TRANSIENT_DELAYS_MS, type Classified, type RetryKind } from "@/lib/articles/errors";
import { STAGES, StopRequested, type ArtStageCtx, type ArtStageResult } from "./stages";
import { finishLog, markDetails, recordError, retryStreak, type RetryStreak } from "./journal";
import { MAX_ATTEMPTS, releaseArticle, renewLease } from "./queue";
import { log } from "../log";

/** Пауза после короткого сбоя вне этапа (переход между этапами, запись в базу). */
const OUTER_RETRY_MS = 30_000;

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
  /** Открытая запись журнала текущего этапа (закрытую не трогаем — иначе сбой перехода перезапишет «done» прошлого этапа). */
  let openLogId: string | null = null;
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
      openLogId = started.id;
      const streak = await retryStreak(current.id, stage, started.id);
      const costBefore = await articleCost(current.id);
      log.info(`article ${current.id.slice(0, 8)} stage=${stage} attempt=${current.attempts}${streakText(streak)}`);

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
        retries: streak.counts,
      };

      let result: ArtStageResult;
      try {
        result = await handler(ctx);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (err instanceof StopRequested || (ac.signal.aborted && ac.signal.reason instanceof StopRequested)) {
          await finishLog(started.id, "skipped", "Остановлено пользователем", undefined, markDetails(undefined, { boundary: true }));
          openLogId = null;
          await prisma.article.update({ where: { id: current.id }, data: { status: "STOPPED", workerId: null, leaseUntil: null, stopRequested: false } });
          log.info(`article ${current.id} stopped by user`);
          return;
        }
        const leaseLost = /lease lost/.test(err.message) || (ac.signal.aborted && /lease lost/.test(String((ac.signal.reason as Error | undefined)?.message ?? "")));
        if (shuttingDown() || leaseLost) {
          await finishLog(started.id, "skipped", "Воркер перезапускается");
          openLogId = null;
          // Плановая остановка воркера — не прерывание: попытку возвращаем (attempts считает только падения процесса).
          if (!leaseLost) await releaseArticle(current.id, 0, undefined, { refund: current.attempts > 0, workerId });
          return;
        }
        const cost = (await articleCost(current.id).catch(() => costBefore)) - costBefore;
        const c = classifyFailure(err);
        if (c.kind === "fatal") {
          await finishLog(started.id, "error", undefined, err.message, markDetails(undefined, { final: true }), cost);
          openLogId = null;
          await fail(current, err.message, stage, c);
          return;
        }
        await retryOrFail(current, workerId, stage, started.id, streak, c.kind, c, { cost });
        openLogId = null;
        return;
      }

      const cost = (await articleCost(current.id)) - costBefore;
      if (result.fatal) {
        await finishLog(started.id, "error", result.summary, result.fatal, markDetails(result.details, { final: true }), cost);
        openLogId = null;
        await fail(current, result.fatal, stage, { code: "stage", human: result.fatal });
        return;
      }
      if (result.retryInMs && result.retryInMs > 0) {
        const kind: RetryKind = result.retryKind ?? "planned";
        const text = result.summary ?? "Повтор позже";
        const c: Classified = { kind, code: kind, human: text, detail: text };
        await retryOrFail(current, workerId, stage, started.id, streak, kind, c, { cost, stageDelayMs: result.retryInMs, details: result.details, giveUp: result.giveUp, summary: result.summary });
        openLogId = null;
        return;
      }
      await finishLog(started.id, "done", result.summary, undefined, result.details, cost);
      openLogId = null;

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
        if (stage === "select") {
          // ИИ-модерация сайта читается свежей: её могли включить после запуска статьи.
          if (current.photoReview) wait = { wait: "PHOTO_REVIEW", note: "Фото отобраны, ждут модерации" };
          else if (await aiModerationActive(site.id)) wait = { wait: "PHOTO_REVIEW", note: "Фото отобраны, ждут ИИ-проверки фото" };
        }
        // После одобрения в модерации статьи (снятые фото → пересборка) второй раз на модерацию не ставим: cursor.reviewApproved.
        if (stage === "assemble" && !current.photoReview && !cursor.reviewApproved) wait = { wait: "REVIEW_PENDING", note: "Статья собрана, ждёт модерации" };
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
        // История проекта (раздел «Проекты»): статья опубликована.
        void prisma.article.findUnique({ where: { id: current.id }, select: { siteId: true, keyword: true, wpUrl: true, costUsd: true } }).then((a) => a && logEventByArtSite(a.siteId, { kind: "article_published", refId: current.id, summary: eventText.articlePublished(a.keyword, a.wpUrl), payload: { costUsd: a.costUsd } })).catch(() => {});
        return;
      }
      current = await prisma.article.update({ where: { id: current.id }, data: { stage: next, attempts: 0, note: null, costUsd: await articleCost(current.id) } });
      if (ac.signal.aborted) {
        await releaseArticle(current.id, 0, undefined, { workerId });
        return;
      }
    }
    await fail(current, "Слишком много переходов между этапами за один проход — проверьте журнал статьи");
  } catch (e) {
    // Сбой вне обработчика этапа: запись в базу на переходе, журнал, расчёт расхода.
    const err = e instanceof Error ? e : new Error(String(e));
    log.error(`article ${current.id} crashed`, err);
    if (isTransientError(err) && current.attempts < MAX_ATTEMPTS && !ac.signal.aborted) {
      // Короткий сбой базы/сети — повтор этапа через 30 с вместо FAILED. Попытка не возвращается: если сбой
      // повторяется раз за разом, через MAX_ATTEMPTS статья всё же станет ошибкой, а не будет крутиться вечно.
      if (openLogId) await finishLog(openLogId, "skipped", "Короткий сбой — повтор через 30 с", err.message).catch(() => {});
      await releaseArticle(current.id, OUTER_RETRY_MS, `Повтор через 30 с: короткий сбой (${err.message.slice(0, 200)})`, { workerId }).catch((e2) =>
        // База недоступна и для этой записи — статью вернёт в очередь сторож просроченной аренды.
        log.warn(`article ${current.id}: release after crash failed`, e2),
      );
      return;
    }
    if (openLogId) await finishLog(openLogId, "error", undefined, err.message, markDetails(undefined, { final: true })).catch(() => {});
    await fail(current, err.message).catch((e2) => log.warn(`article ${current.id}: не удалось записать ошибку`, e2));
  } finally {
    clearInterval(heartbeat);
  }
}

/** Повторить этап позже по политике вида сбоя или, если повторы исчерпаны, завершить ошибкой. */
async function retryOrFail(
  a: Article,
  workerId: string,
  stage: StageKey,
  logId: string,
  streak: RetryStreak,
  kind: RetryKind,
  c: Classified,
  opts: { cost?: number; stageDelayMs?: number; details?: unknown; giveUp?: string; summary?: string },
): Promise<void> {
  const n = streak.counts[kind] + 1;
  const plan = retryPlan(kind, n, streak.firstAt[kind] ?? new Date(), stage, opts.stageDelayMs);
  const label = stageLabel(stage);
  if (!plan.retry) {
    const reason = opts.giveUp ?? giveUpText(kind, label, n - 1, c);
    await finishLog(logId, "error", opts.summary, reason, markDetails(opts.details, { final: true }), opts.cost);
    await fail(a, reason, stage, { code: kind === "planned" ? "planned" : c.code, human: giveUpHuman(kind, c) });
    return;
  }
  const delay = plan.delayMs;
  const counter = plan.max ? `${n}/${plan.max}` : `${n}`;
  const extra = c.detail && c.detail !== c.human ? ` — ${short(c.detail)}` : "";
  const note =
    kind === "key"
      ? `${c.human} — статья ждёт и продолжит автоматически, когда ключ снова заработает (следующая проверка через ${inWords(delay)}).${extra ? ` ${short(c.detail)}` : ""}`
      : kind === "malformed"
        ? `Повтор ${counter} через ${inWords(delay)}: ${c.human} на этапе «${label}»${extra}`
        : kind === "transient" && plan.max === null
          ? `Провайдер не отвечает (${c.human}) — статья ждёт и продолжит сама, следующая проверка через ${inWords(delay)}; ошибкой станет только через сутки без ответа.${extra}`
        : kind === "transient"
          ? `Повтор ${counter} через ${inWords(delay)}: ${c.human}${extra}`
          : `Повтор ${counter} через ${inWords(delay)}: ${short(opts.summary ?? c.human)}`;
  const mark = { kind, n, max: plan.max, delayMs: delay, code: c.code };
  // Текст «Временная ошибка, повтор через N с: …» — его ищет разбор временных сбоев (src/lib/articles/errorsView.ts).
  const logError =
    kind === "planned" ? undefined
    : kind === "key" ? `Ожидание ключа: ${c.human}. ${c.detail}`
    : `Временная ошибка, повтор через ${Math.round(delay / 1000)} с: ${c.human}${extra}`;
  await finishLog(logId, kind === "planned" ? "skipped" : "error", opts.summary ?? (kind === "planned" ? "Повтор позже" : undefined), logError, markDetails(opts.details, { retry: mark }), opts.cost);
  await releaseArticle(a.id, delay, note.slice(0, 1000), { refund: a.attempts > 0, workerId });
  // Ожидание ключа — в журнал ошибок один раз за серию: видно, почему стоит очередь, без сотни одинаковых строк.
  if (kind === "key" && n === 1) {
    await recordError({ teamId: a.teamId, siteId: a.siteId, articleId: a.id, stage, message: `${c.human}: статья ждёт рабочий ключ и продолжит сама. ${c.detail}`, code: c.code, human: c.human });
  }
  // Переход к ожиданию провайдера — тоже один раз за серию.
  if (kind === "transient" && plan.max === null && n === TRANSIENT_DELAYS_MS.length + 1) {
    await recordError({ teamId: a.teamId, siteId: a.siteId, articleId: a.id, stage, message: `${c.human}: провайдер не отвечает час, статья ждёт (проверка раз в 30 мин, до суток) и продолжит сама. ${c.detail}`, code: c.code, human: c.human });
  }
  log.info(`article ${a.id.slice(0, 8)} ${kind} retry ${counter} at ${stage} in ${Math.round(delay / 1000)}s: ${c.human.slice(0, 160)}`);
}

function giveUpText(kind: RetryKind, label: string, tries: number, c: Classified): string {
  switch (kind) {
    case "transient":
      return `Этап «${label}» не удался: провайдер не отвечал сутки (${tries} повторов): ${c.human}. ${c.detail}`.trim();
    case "malformed":
      return `Модель ${tries + 1} раз подряд вернула ответ не в том формате на этапе «${label}»: ${c.detail}. Проверьте промт и модель сценария, затем нажмите «Повторить».`;
    case "key":
      return `${c.human}: ключ не заработал за 7 дней ожидания. Пополните баланс или назначьте рабочий ключ, затем нажмите «Повторить». ${c.detail}`.trim();
    case "planned":
      return `Этап «${label}» откладывался ${tries} раз подряд и не завершился: ${c.detail}`;
  }
}

function giveUpHuman(kind: RetryKind, c: Classified): string {
  if (kind === "malformed") return "ответ модели не в том формате";
  if (kind === "planned") return "повторы этапа исчерпаны";
  return c.human;
}

/** ИИ-модерация фото действует на сайте статьи сейчас (настройка сайта + мастер-выключатель). */
async function aiModerationActive(siteId: string): Promise<boolean> {
  const [s, g] = await Promise.all([
    prisma.artSite.findUnique({ where: { id: siteId }, select: { settings: true } }),
    prisma.artSettings.findUnique({ where: { id: "main" }, select: { aiModMaster: true } }),
  ]);
  return aiModerationOn(s?.settings, g ?? undefined);
}

function streakText(s: RetryStreak): string {
  const parts = (Object.keys(s.counts) as RetryKind[]).filter((k) => s.counts[k] > 0).map((k) => `${k}=${s.counts[k]}`);
  return parts.length ? ` retries(${parts.join(",")})` : "";
}

const short = (t: string, n = 200) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/**
 * Окончательная ошибка статьи. Этап публикации — PUBLISH_ERROR (вкладка «Ошибки» на «Публикациях», «Повторить публикацию»),
 * остальное — FAILED. Запись в ArtError: этап, сигнатура по виду сбоя, короткая причина.
 */
async function fail(a: Article, reason: string, stage?: string, c?: { code: string; human: string }) {
  const text = reason.slice(0, 4000);
  const st = stage ?? a.stage;
  const status: ArtStatus = st === "publish" ? "PUBLISH_ERROR" : "FAILED";
  await prisma.article.update({ where: { id: a.id }, data: { status, workerId: null, leaseUntil: null, error: text, errorStage: st, note: null, costUsd: await articleCost(a.id).catch(() => a.costUsd) } });
  await recordError({ teamId: a.teamId, siteId: a.siteId, articleId: a.id, stage: st, message: text, code: c?.code, human: c?.human });
  // Строка в Google Таблице получает статус «ошибка», чтобы падение было видно там же (оригинал direct-pipeline :1328).
  if (a.sheetRow) {
    void markArticleStatus(a.id, "error")
      .then((r) => { if (!r.ok) log.warn(`article ${a.id}: статус «ошибка» в Google Таблицу не записан: ${r.error}`); })
      .catch((e) => log.warn(`article ${a.id}: статус «ошибка» в Google Таблицу не записан`, e));
  }
  log.warn(`article ${a.id} ${status === "PUBLISH_ERROR" ? "publish error" : "failed"} at ${st}: ${text.slice(0, 200)}`);
}
