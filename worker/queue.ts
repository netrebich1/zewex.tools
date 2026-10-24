import { prisma } from "@/lib/db";
import type { PinJob } from "@prisma/client";
import { log } from "./log";

/**
 * Очередь задач в MariaDB. Захват атомарный: кандидаты блокируются FOR UPDATE SKIP LOCKED,
 * лимит одновременных задач на команду считается в той же транзакции, затем
 * UPDATE … WHERE status='PENDING' гарантирует, что задачу взял ровно один воркер.
 */

export const LEASE_SECONDS = 90;
export const TEAM_CAP = Number(process.env.PINS_TEAM_CAP || 2);
export const MAX_ATTEMPTS = 5;

/**
 * `skipStages` — этапы, которые сейчас брать нельзя (у воркера заняты все места для тяжёлых этапов):
 * такие задачи пропускаются, и место достаётся следующей лёгкой задаче очереди.
 */
export async function claimNextJob(workerId: string, opts: { skipStages?: readonly string[] } = {}): Promise<PinJob | null> {
  const skip = new Set(opts.skipStages ?? []);
  return prisma.$transaction(
    async (tx) => {
      const cand = await tx.$queryRaw<Array<{ id: string; teamId: string; stage: string }>>`
        SELECT id, teamId, stage FROM PinJob
        WHERE status = 'PENDING' AND (nextRunAt IS NULL OR nextRunAt <= NOW(3))
        ORDER BY priority DESC, createdAt ASC
        LIMIT 50 FOR UPDATE SKIP LOCKED`;
      for (const j of cand) {
        if (skip.has(j.stage)) continue;
        const running = await tx.pinJob.count({ where: { teamId: j.teamId, status: { in: ["RUNNING", "STOPPING"] }, leaseUntil: { gt: new Date() } } });
        if (running >= TEAM_CAP) continue;
        const r = await tx.$executeRaw`
          UPDATE PinJob SET status = 'RUNNING', workerId = ${workerId}, startedAt = NOW(3),
                 leaseUntil = DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND), attempts = attempts + 1
          WHERE id = ${j.id} AND status = 'PENDING'`;
        if (r === 1) return tx.pinJob.findUniqueOrThrow({ where: { id: j.id } });
      }
      return null;
    },
    { isolationLevel: "ReadCommitted", timeout: 15_000 },
  );
}

export async function renewLease(jobId: string, patch: { done?: number; total?: number; label?: string } = {}, workerId?: string): Promise<{ stopping: boolean; lost?: boolean }> {
  const rows = await prisma.$queryRaw<Array<{ status: string; workerId: string | null }>>`SELECT status, workerId FROM PinJob WHERE id = ${jobId}`;
  const status = rows[0]?.status;
  // Аренду продлевает только тот воркер, который держит задачу: после истечения lease её мог забрать другой.
  if (workerId && rows[0] && rows[0].workerId !== workerId) return { stopping: true, lost: true };
  await prisma.$executeRaw`UPDATE PinJob SET leaseUntil = DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND) WHERE id = ${jobId}`;
  if (Object.keys(patch).length) await prisma.pinJob.update({ where: { id: jobId }, data: patch });
  return { stopping: status === "STOPPING" };
}

export async function finishJob(jobId: string, status: "DONE" | "ERROR" | "STOPPED", error?: string) {
  await prisma.pinJob.update({ where: { id: jobId }, data: { status, error: error?.slice(0, 4000) ?? null, finishedAt: new Date(), leaseUntil: null, workerId: null } });
}

/**
 * Вернуть задачу в очередь (graceful stop воркера или временный сбой).
 * `resetAttempts` — плановое ожидание отложенных пинов, а не сбой: счётчик попыток задачи не растёт,
 * иначе 10 кругов ожидания лимита провайдера упёрлись бы в MAX_ATTEMPTS.
 * `refund` — мягкая остановка воркера (деплой, перезапуск службы): вернуть попытку, потраченную захватом.
 * Попытки считают только сбои — временные ошибки провайдера и падения процесса, а не наши перезапуски
 * (2026-10-22: четыре перезапуска за вечер довели этап Canvas прогона до 4 попыток из 5).
 */
export async function releaseJob(jobId: string, delayMs = 0, opts: { resetAttempts?: boolean; refund?: boolean } = {}) {
  const data = { status: "PENDING" as const, workerId: null, leaseUntil: null, nextRunAt: new Date(Date.now() + delayMs) };
  if (opts.resetAttempts) {
    await prisma.pinJob.update({ where: { id: jobId }, data: { ...data, attempts: 0 } });
  } else if (opts.refund) {
    // Ниже нуля не опускаем: захват всегда прибавляет попытку, но запись могли поправить вручную.
    const n = await prisma.pinJob.updateMany({ where: { id: jobId, attempts: { gt: 0 } }, data: { ...data, attempts: { decrement: 1 } } });
    if (!n.count) await prisma.pinJob.update({ where: { id: jobId }, data });
  } else {
    await prisma.pinJob.update({ where: { id: jobId }, data });
  }
}

/** Задачи, чей воркер умер: lease истёк, статус всё ещё RUNNING. */
export async function requeueStale(): Promise<number> {
  const stale = await prisma.pinJob.findMany({ where: { status: { in: ["RUNNING", "STOPPING"] }, leaseUntil: { lt: new Date() } }, select: { id: true, attempts: true, runId: true, stage: true, status: true } });
  let n = 0;
  for (const j of stale) {
    if (j.status === "STOPPING") {
      // Пользователь просил остановить, а воркер умер: считаем остановленной, а не перезапускаем.
      await finishJob(j.id, "STOPPED");
      await prisma.pinRun.update({ where: { id: j.runId }, data: { status: "STOPPED", stopRequested: false } });
      continue;
    }
    if (j.attempts >= MAX_ATTEMPTS) {
      await finishJob(j.id, "ERROR", `Воркер несколько раз прерывался на этапе «${j.stage}»`);
      await prisma.pinRun.update({ where: { id: j.runId }, data: { status: "BLOCKED", blockedReason: `Этап «${j.stage}» прерывался ${j.attempts} раз подряд. Нажмите «Продолжить» после проверки логов.` } });
      log.warn(`job ${j.id} given up after ${j.attempts} attempts`);
    } else {
      await prisma.pinJob.update({ where: { id: j.id }, data: { status: "PENDING", workerId: null, leaseUntil: null, nextRunAt: new Date() } });
      n++;
    }
  }
  if (n) log.info(`requeued ${n} stale job(s)`);
  return n;
}

/**
 * На старте воркера: задачи, которые держал воркер с этого же хоста, осиротели
 * (на хосте один процесс воркера), их lease ждать не нужно.
 */
export async function requeueOrphans(hostPrefix: string): Promise<number> {
  const r = await prisma.$executeRaw`
    UPDATE PinJob SET status = 'PENDING', workerId = NULL, leaseUntil = NULL, nextRunAt = NOW(3)
    WHERE status IN ('RUNNING','STOPPING') AND workerId LIKE ${hostPrefix + "-%"}`;
  if (r) log.info(`requeued ${r} orphaned job(s) from previous worker process`);
  return r;
}
