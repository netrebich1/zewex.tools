import { prisma } from "@/lib/db";
import type { PinJob } from "@prisma/client";
import { JOB_STAGES, PIN_STAGES, type JobStage, type PinStage } from "@/lib/pins/types";
import { enqueueJob, JobConflict } from "@/lib/pins/jobs";
import { nextStageAfter } from "@/lib/pins/runs/stages";
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import { autoModerate } from "@/lib/pins/runs/moderation";
import { finishJob, releaseJob, renewLease, MAX_ATTEMPTS } from "./queue";
import { STAGES, StopRequested, type StageCtx } from "./stages";
import { log } from "./log";

const TRANSIENT = /timeout|timed out|fetch failed|econnreset|econnrefused|socket hang up|lock wait|deadlock|too many connections|ETIMEDOUT|EAI_AGAIN/i;

/** Временная ошибка: сеть/БД по тексту или ошибка ИИ, классифицированная как transient (429, 5xx). */
function isTransient(err: Error): boolean {
  if (err instanceof AiError) return err.cls.kind === "transient";
  return TRANSIENT.test(err.message);
}

/** Пересчитать расход прогона по журналу портала (UsageLog.refId = id прогона). */
async function refreshRunCost(runId: string): Promise<void> {
  const agg = await prisma.usageLog.aggregate({ _sum: { costUsd: true }, where: { refId: runId } });
  await prisma.pinRun.update({ where: { id: runId }, data: { costUsd: agg._sum.costUsd ?? 0 } }).catch(() => {});
}

function asPinStage(s: string): PinStage {
  return (PIN_STAGES as readonly string[]).includes(s) ? (s as PinStage) : "pages";
}

export async function processJob(job: PinJob, shuttingDown: () => boolean): Promise<void> {
  const handler = STAGES[job.stage as JobStage];
  const ac = new AbortController();
  let stopping = false;
  let lastPatch: { done?: number; total?: number; label?: string } = {};
  const heartbeat = setInterval(async () => {
    try {
      const r = await renewLease(job.id, lastPatch);
      lastPatch = {};
      if (r.stopping && !stopping) {
        stopping = true;
        ac.abort(new StopRequested());
      }
      if (shuttingDown() && !ac.signal.aborted) ac.abort(new Error("worker shutting down"));
    } catch (e) {
      log.warn(`heartbeat failed for job ${job.id}`, e);
    }
  }, 20_000);

  const run = await prisma.pinRun.findUnique({ where: { id: job.runId } });
  try {
    if (!run) {
      await finishJob(job.id, "ERROR", "Прогон не найден");
      return;
    }
    if (!handler) {
      const known = (JOB_STAGES as readonly string[]).includes(job.stage);
      const why = known
        ? `Этап «${job.stage}» ещё не реализован в этой версии сервиса (появится в следующей фазе). Прогон остановлен на нём, всё сделанное сохранено.`
        : `Неизвестный этап «${job.stage}»`;
      await finishJob(job.id, "ERROR", why);
      await prisma.pinRun.update({ where: { id: run.id }, data: { status: "BLOCKED", blockedReason: why } });
      return;
    }
    await prisma.pinRun.update({ where: { id: run.id }, data: { status: "RUNNING", blockedReason: null } });
    log.info(`job ${job.id} start stage=${job.stage} run=${run.id} attempt=${job.attempts}`);

    const ctx: StageCtx = {
      job,
      run,
      signal: ac.signal,
      tick: async (patch) => {
        if (patch) lastPatch = { ...lastPatch, ...patch };
        if (ac.signal.aborted) throw ac.signal.reason instanceof StopRequested ? ac.signal.reason : new Error("aborted");
        if (patch && (patch.done !== undefined || patch.total !== undefined || patch.label !== undefined)) {
          const r = await renewLease(job.id, patch);
          lastPatch = {};
          if (r.stopping && !stopping) {
            stopping = true;
            ac.abort(new StopRequested());
            throw new StopRequested();
          }
        }
      },
      log: (msg, extra) => log.info(`[${job.stage} ${run.id.slice(0, 8)}] ${msg}`, extra),
    };

    const result = await handler(ctx);

    if (result.fatal) {
      await finishJob(job.id, "ERROR", result.fatal);
      await prisma.pinRun.update({ where: { id: run.id }, data: { status: "BLOCKED", blockedReason: result.fatal } });
      log.warn(`job ${job.id} blocked: ${result.fatal}`);
      return;
    }
    if (result.retryLater && result.retryLater > 0 && job.attempts < MAX_ATTEMPTS) {
      const delay = backoffMs(job.attempts);
      await releaseJob(job.id, delay);
      log.info(`job ${job.id} retry later (${result.retryLater} items) in ${Math.round(delay / 1000)}s`);
      return;
    }
    await finishJob(job.id, "DONE");
    const stageDone = job.stage as JobStage;
    const next = nextStageAfter(stageDone, run.settings as Record<string, unknown>);
    const stepByStep = run.stepByStep;
    if (next === "moderation") {
      const mode = (run.settings as { schedule?: { moderationMode?: string } }).schedule?.moderationMode;
      if (mode === "auto") {
        // автоодобрение: без паузы, пины без картинки отклоняются, дальше — тексты
        const m = await autoModerate(run.id);
        log.info(`job ${job.id} auto-moderation: approved ${m.approved}, rejected ${m.rejected}`);
        await prisma.pinRun.update({ where: { id: run.id }, data: { stage: "moderation", moderatedAt: new Date() } });
        if (stepByStep) await prisma.pinRun.update({ where: { id: run.id }, data: { status: "STOPPED" } });
        else {
          try {
            await enqueueJob(run.id, "texts");
          } catch (e) {
            if (!(e instanceof JobConflict)) throw e;
          }
        }
      } else {
        await prisma.pinRun.update({ where: { id: run.id }, data: { stage: "moderation", status: "WAITING_MODERATION" } });
      }
    } else if (next === "ready") {
      await prisma.pinRun.update({ where: { id: run.id }, data: { stage: "ready", status: "DONE" } });
    } else if (next && !stepByStep) {
      await prisma.pinRun.update({ where: { id: run.id }, data: { stage: asPinStage(stageDone) } });
      try {
        await enqueueJob(run.id, next);
      } catch (e) {
        if (!(e instanceof JobConflict)) throw e;
      }
    } else {
      await prisma.pinRun.update({ where: { id: run.id }, data: { stage: asPinStage(stageDone), status: next ? "STOPPED" : "DONE" } });
    }
    log.info(`job ${job.id} done${result.summary ? ": " + result.summary : ""}; next=${next ?? "-"}`);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err instanceof StopRequested || (ac.signal.aborted && ac.signal.reason instanceof StopRequested)) {
      await finishJob(job.id, "STOPPED");
      await prisma.pinRun.update({ where: { id: job.runId }, data: { status: "STOPPED", stopRequested: false } });
      log.info(`job ${job.id} stopped by user`);
      return;
    }
    if (shuttingDown()) {
      await releaseJob(job.id, 0);
      log.info(`job ${job.id} released for restart`);
      return;
    }
    if (isTransient(err) && job.attempts < MAX_ATTEMPTS) {
      const delay = backoffMs(job.attempts);
      await releaseJob(job.id, delay);
      log.warn(`job ${job.id} transient error, retry in ${Math.round(delay / 1000)}s: ${err.message}`);
      return;
    }
    await finishJob(job.id, "ERROR", err.message);
    await prisma.pinRun.update({ where: { id: job.runId }, data: { status: "BLOCKED", blockedReason: `Этап «${job.stage}»: ${err.message.slice(0, 500)}` } });
    log.error(`job ${job.id} failed`, err);
  } finally {
    clearInterval(heartbeat);
    await refreshRunCost(job.runId).catch((e) => log.warn(`cost refresh failed for run ${job.runId}`, e));
  }
}
