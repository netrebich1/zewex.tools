import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const TZ = process.env.PINS_TZ || "Europe/Berlin";

/** День YYYY-MM-DD в рабочем часовом поясе. */
const dayFormats = new Map<string, Intl.DateTimeFormat>();
export function dayKey(d: Date, tz = TZ): string {
  // форматтер создаём один раз на пояс: new Intl.DateTimeFormat на каждый вызов стоил секунды на сводном календаре
  let f = dayFormats.get(tz);
  if (!f) dayFormats.set(tz, (f = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(d);
}

/**
 * Пины по часам (UTC) одним GROUP BY: siteId, час → сколько. Часы потом раскладываем по дням в рабочем поясе
 * (смещения поясов кратны часу). Раньше тянули каждую строку — у сводного календаря ~200 тыс. строк, 30+ с.
 */
async function hourCounts(cond: Prisma.Sql): Promise<Array<{ siteId: string; hour: Date; n: number }>> {
  const rows = await prisma.$queryRaw<Array<{ siteId: string; h: string; n: bigint | number }>>`
    SELECT siteId, DATE_FORMAT(scheduledAt, '%Y-%m-%dT%H:00:00Z') AS h, COUNT(*) AS n
    FROM PinRunItem
    WHERE ${cond} AND scheduledAt IS NOT NULL AND moderation <> 'REJECTED' AND status NOT IN ('POOL','REMOVED')
    GROUP BY siteId, h`;
  return rows.map((r) => ({ siteId: r.siteId, hour: new Date(r.h), n: Number(r.n) }));
}

/** Запас пинов сайта по дням, начиная с сегодня: по всем прогонам сайта, кроме отклонённых. */
export async function siteStock(siteId: string, days = 35): Promise<Array<{ day: string; count: number }>> {
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - 1);
  const counts = new Map<string, number>();
  for (const r of await hourCounts(Prisma.sql`siteId = ${siteId} AND scheduledAt >= ${from}`)) counts.set(dayKey(r.hour), (counts.get(dayKey(r.hour)) ?? 0) + r.n);
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
  const m = new Map<string, number>();
  const cond = excludeRunId ? Prisma.sql`siteId = ${siteId} AND runId <> ${excludeRunId}` : Prisma.sql`siteId = ${siteId}`;
  for (const r of await hourCounts(cond)) m.set(dayKey(r.hour), (m.get(dayKey(r.hour)) ?? 0) + r.n);
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
  for (const r of await hourCounts(Prisma.sql`siteId IN (${Prisma.join(siteIds)}) AND scheduledAt >= ${from} AND scheduledAt <= ${to}`)) {
    const i = index.get(dayKey(r.hour));
    const arr = bySite.get(r.siteId);
    if (i !== undefined && arr) arr[i] += r.n;
  }
  return { start: keys[0], days: keys, bySite };
}
