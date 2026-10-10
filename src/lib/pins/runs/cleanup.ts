/**
 * Автоуборка прогонов: прогон удаляется (вместе с пинами, картинками и журналом) через N дней
 * после даты последнего запланированного пина. Прогоны без расписания — через N дней после последнего изменения.
 * Выполняющиеся прогоны и служебный `__system__` не трогаются.
 */
import { prisma } from "@/lib/db";
import { removePath, runDir } from "../storage";

export const RUN_RETENTION_DAYS = 90;

export async function purgeOldRuns(days = RUN_RETENTION_DAYS, now = new Date()): Promise<{ deleted: string[] }> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const candidates = await prisma.pinRun.findMany({
    where: { status: { notIn: ["QUEUED", "RUNNING"] }, NOT: { name: { startsWith: "__" } } },
    select: { id: true, updatedAt: true },
  });
  const deleted: string[] = [];
  for (const { id, updatedAt } of candidates) {
    const last = await prisma.pinRunItem.aggregate({ _max: { scheduledAt: true }, where: { runId: id, status: { notIn: ["REMOVED"] } } });
    const lastPin = last._max.scheduledAt;
    if ((lastPin ?? updatedAt) >= cutoff) continue;
    await prisma.pinRun.delete({ where: { id } });
    await removePath(runDir(id)).catch(() => {});
    deleted.push(id);
  }
  return { deleted };
}
