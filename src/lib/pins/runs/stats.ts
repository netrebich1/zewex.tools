import { prisma } from "@/lib/db";

export const TZ = process.env.PINS_TZ || "Europe/Berlin";

/** День YYYY-MM-DD в рабочем часовом поясе. */
export function dayKey(d: Date, tz = TZ): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Запас пинов сайта по дням, начиная с сегодня: по всем прогонам сайта, кроме отклонённых. */
export async function siteStock(siteId: string, days = 35): Promise<Array<{ day: string; count: number }>> {
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - 1);
  const rows = await prisma.pinRunItem.findMany({
    where: { siteId, scheduledAt: { gte: from }, moderation: { not: "REJECTED" }, status: { notIn: ["POOL", "REMOVED"] } },
    select: { scheduledAt: true },
  });
  const counts = new Map<string, number>();
  for (const r of rows) if (r.scheduledAt) counts.set(dayKey(r.scheduledAt), (counts.get(dayKey(r.scheduledAt)) ?? 0) + 1);
  const out: Array<{ day: string; count: number }> = [];
  const start = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const k = dayKey(d);
    out.push({ day: k, count: counts.get(k) ?? 0 });
  }
  return out;
}

/** Занятость по дням для планировщика: сколько пинов уже назначено на каждый день у сайта. */
export async function existingLoad(siteId: string, excludeRunId?: string): Promise<Map<string, number>> {
  const rows = await prisma.pinRunItem.findMany({
    where: { siteId, scheduledAt: { not: null }, moderation: { not: "REJECTED" }, status: { notIn: ["POOL", "REMOVED"] }, ...(excludeRunId ? { runId: { not: excludeRunId } } : {}) },
    select: { scheduledAt: true },
  });
  const m = new Map<string, number>();
  for (const r of rows) if (r.scheduledAt) m.set(dayKey(r.scheduledAt), (m.get(dayKey(r.scheduledAt)) ?? 0) + 1);
  return m;
}

/** Запас по дням сразу для всех сайтов (сводный календарь): siteId → счётчики на `days` дней от сегодня. */
export async function sitesStock(siteIds: string[], days = 92): Promise<{ start: string; days: string[]; bySite: Map<string, number[]> }> {
  const start = new Date();
  const keys: string[] = [];
  for (let i = 0; i < days; i++) keys.push(dayKey(new Date(start.getTime() + i * 86400000)));
  const index = new Map(keys.map((k, i) => [k, i]));
  const bySite = new Map<string, number[]>(siteIds.map((id) => [id, new Array(days).fill(0)]));
  if (!siteIds.length) return { start: keys[0], days: keys, bySite };
  const from = new Date(start.getTime() - 86400000);
  const to = new Date(start.getTime() + (days + 1) * 86400000);
  const rows = await prisma.pinRunItem.findMany({
    where: { siteId: { in: siteIds }, scheduledAt: { gte: from, lte: to }, moderation: { not: "REJECTED" }, status: { notIn: ["POOL", "REMOVED"] } },
    select: { siteId: true, scheduledAt: true },
  });
  for (const r of rows) {
    if (!r.scheduledAt || !r.siteId) continue;
    const i = index.get(dayKey(r.scheduledAt));
    const arr = bySite.get(r.siteId);
    if (i !== undefined && arr) arr[i]++;
  }
  return { start: keys[0], days: keys, bySite };
}
