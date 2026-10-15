/**
 * Цикл ИИ-модерации фото в воркере (замена sleep-then-chain цепочек `process` и `watchdog` оригинала
 * ai-photo-moderate/index.ts:37-58, 281-334). Подключается в worker/index.ts рядом с articlesLoop:
 *   const aiLoop = aiModerationLoop(WORKER_ID, () => shuttingDown);  …  await Promise.allSettled([...aiModerationInflight()]).
 *
 * Каждые 20 с для всех запусков status=running: heartbeat; сторож (processing старше 6 мин удаляется — статья снова в пуле,
 * applying без движения 3 мин → proposed); в режиме auto с autoApply сайта — применение proposed (op по уверенности);
 * пул статей размером concurrency (атомарная вставка результата processing); запуск done, когда нет непроверенных
 * статей и нет processing/applying (и proposed для авто). Каждый проход (20 с) перед этим — aiAutostartTick: новые статьи
 * на проверке фото сразу уходят ИИ (новый запуск сайта или добавление к идущему).
 * Вся логика — в src/lib/articles/aiModeration.ts; здесь только планирование и учёт параллельности.
 */
import { prisma } from "@/lib/db";
import {
  aiAutostartTick,
  autoApplyProposed,
  claimNextForRun,
  finishRunIfIdle,
  heartbeatRun,
  refreshRun,
  reviewArticle,
  runAutoApplies,
  runningRuns,
  watchdogRun,
  type AiRunRecord,
} from "@/lib/articles/aiModeration";
import { log } from "../log";

const TICK_MS = 20_000;
/** Автозапуск ИИ-проверки — каждый проход: статья ждёт ИИ не дольше ~20 с (раньше — минута и пачки). */
const AUTOSTART_EVERY_MS = TICK_MS;

/** Все задачи ИИ-модерации в полёте (для graceful shutdown воркера). */
const inflight = new Set<Promise<void>>();
/** Статьи, которые этот процесс сейчас проверяет — чтобы сторож, удалив зависший processing, не выдал статью второй раз. */
const busyArticles = new Set<string>();
/** Решения, которые этот процесс сейчас применяет. */
const busyResults = new Set<string>();
/** Сколько задач бежит по каждому запуску. */
const perRun = new Map<string, number>();

export function aiModerationInflight(): Set<Promise<void>> {
  return inflight;
}

/** Снимок загрузки для диагностики (/pinterest/articles/moderation/ai показывает heartbeat из базы, это — для логов). */
export function aiModerationStats(): { inflight: number; runs: Record<string, number> } {
  return { inflight: inflight.size, runs: Object.fromEntries(perRun) };
}

function spawn(runId: string, task: () => Promise<void>): void {
  perRun.set(runId, (perRun.get(runId) ?? 0) + 1);
  const p = task()
    .catch((e) => log.error(`ai-moderation: task crashed (run ${runId})`, e))
    .finally(() => {
      inflight.delete(p);
      perRun.set(runId, Math.max(0, (perRun.get(runId) ?? 1) - 1));
    });
  inflight.add(p);
}

/** Проверка одной статьи; сбой моделей reviewArticle записывает сам (failed + стоимость), сюда долетают только поломки кода. */
async function processOne(run: AiRunRecord, articleId: string): Promise<void> {
  busyArticles.add(articleId);
  try {
    const status = await reviewArticle(run, articleId);
    log.info(`ai-moderation [${run.site.name}] ${articleId}: ${status}`);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    log.error(`ai-moderation [${run.site.name}] ${articleId} failed`, e);
    await prisma.artAiModerationResult.updateMany({ where: { runId: run.id, articleId, status: "processing" }, data: { status: "failed", error: msg } }).catch(() => {});
    await prisma.article.updateMany({ where: { id: articleId, aiRunId: run.id }, data: { aiRunId: null } }).catch(() => {});
  } finally {
    busyArticles.delete(articleId);
    await refreshRun(run.id).catch(() => {});
  }
}

async function applyOne(run: AiRunRecord, resultId: string): Promise<void> {
  busyResults.add(resultId);
  try {
    const ok = await autoApplyProposed(run, resultId);
    if (ok) log.info(`ai-moderation [${run.site.name}] applied ${resultId}`);
  } finally {
    busyResults.delete(resultId);
    await refreshRun(run.id).catch(() => {});
  }
}

/** Один проход по одному запуску. */
async function tickRun(run: AiRunRecord): Promise<void> {
  await heartbeatRun(run.id);
  const w = await watchdogRun(run.id);
  if (w.droppedProcessing || w.revertedApplying) log.warn(`ai-moderation [${run.site.name}]: сторож снял ${w.droppedProcessing} зависших проверок, вернул ${w.revertedApplying} применений`);

  const busy = () => perRun.get(run.id) ?? 0;
  // «Авто»: применение — отдельными задачами в том же пуле (оригинал :286-297 делал по одному за шаг).
  if (runAutoApplies(run) && busy() < run.concurrency) {
    const props = await prisma.artAiModerationResult.findMany({
      where: { runId: run.id, status: "proposed", ...(busyResults.size ? { id: { notIn: [...busyResults] } } : {}) },
      orderBy: { createdAt: "asc" },
      take: run.concurrency - busy(),
      select: { id: true },
    });
    for (const p of props) spawn(run.id, () => applyOne(run, p.id));
  }
  const slots = run.concurrency - busy();
  if (slots > 0) {
    const next = await claimNextForRun(run.id, slots, busyArticles);
    for (const id of next) spawn(run.id, () => processOne(run, id));
  }
  if (busy() === 0) {
    const done = await finishRunIfIdle(run);
    if (done) log.info(`ai-moderation [${run.site.name}]: запуск ${run.id} завершён`);
  }
}

async function tick(): Promise<void> {
  const runs = await runningRuns();
  for (const run of runs) {
    try {
      await tickRun(run);
    } catch (e) {
      log.warn(`ai-moderation: tick failed for run ${run.id}`, e);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Пауза, которую можно прервать остановкой воркера. */
async function pause(ms: number, shouldStop: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !shouldStop()) await sleep(Math.min(1_000, until - Date.now()));
}

/**
 * Главный цикл: раз в 20 с — автозапуск по сайтам (новые статьи → ИИ), затем проход по запускам.
 * При остановке воркера текущие проверки доводятся (inflight ждёт worker/index.ts), новые не берутся;
 * недоведённые processing подберёт сторож после рестарта (6 мин) — статьи вернутся в пул того же запуска.
 */
export async function aiModerationLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  log.info(`ai-moderation loop started (${workerId})`);
  let lastAutostart = 0;
  while (!shouldStop()) {
    try {
      if (Date.now() - lastAutostart >= AUTOSTART_EVERY_MS) {
        lastAutostart = Date.now();
        const r = await aiAutostartTick();
        if (r.started || r.attached) log.info(`ai-moderation autostart: новых запусков ${r.started}, добавлено статей к идущим ${r.attached}`);
      }
      await tick();
    } catch (e) {
      log.warn("ai-moderation: tick failed", e);
    }
    await pause(TICK_MS, shouldStop);
  }
  log.info("ai-moderation loop stopped");
}
