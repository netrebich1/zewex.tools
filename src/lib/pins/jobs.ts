import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { JobStage } from "./types";

/**
 * Постановка задач воркеру. Одна активная задача на прогон: enqueue блокирует строку
 * прогона и отказывает, если задача уже в очереди или выполняется.
 */

export class JobConflict extends Error {}

export async function enqueueJob(runId: string, stage: JobStage, options: Record<string, unknown> = {}, priority = 0) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; teamId: string }>>`SELECT id, teamId FROM PinRun WHERE id = ${runId} FOR UPDATE`;
    const run = rows[0];
    if (!run) throw new JobConflict("Прогон не найден");
    const active = await tx.pinJob.findFirst({ where: { runId, status: { in: ["PENDING", "RUNNING", "STOPPING"] } }, select: { id: true, stage: true, status: true } });
    if (active) throw new JobConflict(`У прогона уже есть задача «${active.stage}» (${active.status.toLowerCase()})`);
    const job = await tx.pinJob.create({ data: { runId, teamId: run.teamId, stage, options: options as Prisma.InputJsonValue, priority } });
    await tx.pinRun.update({ where: { id: runId }, data: { status: "QUEUED", stopRequested: false } });
    return job;
  });
}

export async function requestStop(runId: string): Promise<boolean> {
  const active = await prisma.pinJob.findFirst({ where: { runId, status: { in: ["PENDING", "RUNNING"] } } });
  if (!active) return false;
  if (active.status === "PENDING") {
    await prisma.pinJob.update({ where: { id: active.id }, data: { status: "STOPPED", finishedAt: new Date() } });
    await prisma.pinRun.update({ where: { id: runId }, data: { status: "STOPPED" } });
    return true;
  }
  await prisma.pinJob.update({ where: { id: active.id }, data: { status: "STOPPING" } });
  await prisma.pinRun.update({ where: { id: runId }, data: { stopRequested: true } });
  return true;
}

export async function activeJob(runId: string) {
  return prisma.pinJob.findFirst({ where: { runId, status: { in: ["PENDING", "RUNNING", "STOPPING"] } }, orderBy: { createdAt: "desc" } });
}
