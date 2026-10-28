import { prisma } from "@/lib/db";
import { parseSettings } from "./types";

/**
 * Очередь прогонов: один прогон на проект одновременно. Плановые ставит воркер по nextRunAt,
 * ручные — кнопка «Прогнать сейчас». Ручной прогон сдвигает следующий плановый: nextRunAt считается от его окончания.
 */

const ACTIVE = ["queued", "running"];

export async function activeRun(projectId: string) {
  return prisma.newsRun.findFirst({ where: { projectId, status: { in: ACTIVE }, kind: { in: ["scheduled", "manual"] } }, orderBy: { createdAt: "desc" } });
}

/** Ручной прогон. Сотрудник — не чаще раза в 5 минут, админ и лидер — без ограничения. */
export async function requestRun(projectId: string, userId: string, scope: string, unlimited: boolean): Promise<{ ok: true; id: string } | { ok: false; error: string; id?: string }> {
  const busy = await activeRun(projectId);
  if (busy) return { ok: false, error: busy.status === "running" ? "Прогон уже идёт — новые карточки появятся в ленте сами" : "Прогон уже в очереди", id: busy.id };
  if (!unlimited) {
    const last = await prisma.newsRun.findFirst({ where: { projectId, kind: "manual", userId }, orderBy: { createdAt: "desc" } });
    if (last && Date.now() - last.createdAt.getTime() < 5 * 60_000) {
      const wait = Math.ceil((5 * 60_000 - (Date.now() - last.createdAt.getTime())) / 60_000);
      return { ok: false, error: `Ручной прогон — не чаще раза в 5 минут. Попробуйте через ${wait} мин.` };
    }
  }
  const run = await prisma.newsRun.create({ data: { projectId, kind: "manual", scope, userId } });
  return { ok: true, id: run.id };
}

/** Плановые прогоны: активным проектам, у которых подошло время и нет идущего прогона. */
export async function scheduleDue(): Promise<number> {
  const due = await prisma.newsProject.findMany({ where: { isActive: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: new Date() } }] }, select: { id: true, settings: true } });
  let n = 0;
  for (const p of due) {
    if (await activeRun(p.id)) continue;
    await prisma.newsRun.create({ data: { projectId: p.id, kind: "scheduled", scope: "all" } });
    // Защита от повторной постановки, пока прогон не закончился: следующий срок пересчитает сам прогон.
    await prisma.newsProject.update({ where: { id: p.id }, data: { nextRunAt: new Date(Date.now() + parseSettings(p.settings).intervalMin * 60_000) } });
    n++;
  }
  return n;
}

/** Захват прогона воркером: queued → running (атомарно по статусу). */
export async function claimRun(workerId: string) {
  const next = await prisma.newsRun.findFirst({ where: { status: "queued" }, orderBy: [{ kind: "asc" }, { createdAt: "asc" }] });
  if (!next) return null;
  const r = await prisma.newsRun.updateMany({ where: { id: next.id, status: "queued" }, data: { status: "running", workerId, startedAt: new Date() } });
  return r.count ? next : null;
}

/** Прогон, зависший больше 40 минут (воркер перезапустился), — завершаем с ошибкой, чтобы не держал очередь. */
export async function failStaleRuns(hostPrefix?: string): Promise<number> {
  const where = hostPrefix
    ? { status: "running", workerId: { startsWith: hostPrefix } }
    : { status: "running", startedAt: { lt: new Date(Date.now() - 40 * 60_000) } };
  const r = await prisma.newsRun.updateMany({ where, data: { status: "failed", finishedAt: new Date(), error: "прогон прерван (перезапуск воркера) — следующий плановый пойдёт по расписанию" } });
  return r.count;
}

/** Уборка: отсечённые и дубли старше 14 дней, эмбеддинги старше 30 дней, тренды старше 30 дней. Кластеры и материалы в них — бессрочно. */
export async function purgeOld(): Promise<{ items: number; vectors: number; trends: number }> {
  const d14 = new Date(Date.now() - 14 * 86_400_000);
  const d30 = new Date(Date.now() - 30 * 86_400_000);
  const items = await prisma.newsItem.deleteMany({ where: { foundAt: { lt: d14 }, status: { in: ["cut", "dup", "error"] }, clusterId: null } });
  const vectors = await prisma.newsItem.updateMany({ where: { foundAt: { lt: d30 }, embedding: { not: null } }, data: { embedding: null } });
  const trends = await prisma.newsTrend.deleteMany({ where: { lastSeenAt: { lt: d30 } } });
  return { items: items.count, vectors: vectors.count, trends: trends.count };
}

const dayStartUtc = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const monthStartUtc = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

/** Сколько потрачено проектом за месяц и за сутки (по журналу прогонов, UTC). */
export async function projectSpend(projectId: string): Promise<{ month: number; day: number }> {
  const [m, d] = await Promise.all([
    prisma.newsRun.aggregate({ _sum: { costUsd: true }, where: { projectId, createdAt: { gte: monthStartUtc() } } }),
    prisma.newsRun.aggregate({ _sum: { costUsd: true }, where: { projectId, createdAt: { gte: dayStartUtc() } } }),
  ]);
  return { month: m._sum.costUsd ?? 0, day: d._sum.costUsd ?? 0 };
}
