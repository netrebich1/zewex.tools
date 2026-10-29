/**
 * Перераспределение графика сайта (вкладка «Обзор» сайта и «вклинивание» прогона).
 * Подвижные пины — с датой от выбранного дня (и без даты, но готовые к выгрузке), кроме закреплённых вручную
 * и пинов дней, чей файл уже залит в Pinterest (`PrjUpload`): те остаются и занимают место в дне.
 */

import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { TZ } from "./stats";
import { addDays, compareKeys, dayKey, minuteOfDay, startOfDay, todayKey } from "@/lib/pins/schedule/math";
import { growthQuota, type GrowthStep } from "@/lib/pins/schedule/growth";
import { redistribute, overDays, type DayOver, type MovablePin } from "@/lib/pins/schedule/redistribute";
import { MAX_DAY_PINS, SCHEDULE } from "@/lib/pins/types";
import { hash32 } from "@/lib/pins/plan/seed";

type Db = Prisma.TransactionClient | typeof prisma;

export type ReschedulePlan = { mode: "flat"; perDay: number } | { mode: "growth"; steps: GrowthStep[] };

export type RescheduleOptions = {
  siteId: string;
  /** Первый день перераспределения (`YYYY-MM-DD`), не раньше сегодня. */
  from: string;
  plan: ReschedulePlan;
  /** Пины этого прогона не двигать (при «вклинивании» — свежие пины прогона). */
  keepRunId?: string;
  /** Брать ли готовые пины без даты (по умолчанию да). */
  withUndated?: boolean;
  now?: Date;
};

export type ReschedulePreview = {
  from: string;
  movable: number;
  undated: number;
  kept: number;
  uploadedDays: string[];
  before: Array<{ day: string; count: number }>;
  after: Array<{ day: string; count: number }>;
  over: DayOver[];
  unscheduled: number;
  lastBefore: string;
  lastAfter: string;
  changed: number;
};

const ITEM_WHERE = { moderation: { not: "REJECTED" as const }, status: { notIn: ["POOL" as const, "REMOVED" as const] } };
const UNDATED_WHERE = { scheduledAt: null, status: "READY" as const, moderation: "APPROVED" as const, wpMediaUrl: { not: "" }, title: { not: "" } };

export const quotaOf = (plan: ReschedulePlan) => (off: number): number =>
  plan.mode === "flat" ? Math.min(MAX_DAY_PINS, plan.perDay) : growthQuota(plan.steps, off);

async function compute(db: Db, o: RescheduleOptions) {
  const now = o.now ?? new Date();
  const today = todayKey(now, TZ);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(o.from) && compareKeys(o.from, today) > 0 ? o.from : today;
  const fromAt = startOfDay(from, TZ);
  const [dated, undated, uploads] = await Promise.all([
    db.pinRunItem.findMany({ where: { siteId: o.siteId, scheduledAt: { gte: fromAt }, ...ITEM_WHERE }, select: { id: true, pageId: true, runId: true, scheduledAt: true, scheduleFixed: true } }),
    o.withUndated === false ? Promise.resolve([]) : db.pinRunItem.findMany({ where: { siteId: o.siteId, ...UNDATED_WHERE, ...(o.keepRunId ? { runId: { not: o.keepRunId } } : {}) }, select: { id: true, pageId: true, runId: true, scheduledAt: true, scheduleFixed: true } }),
    db.prjUpload.findMany({ where: { pinSiteId: o.siteId, day: { gte: from } }, select: { day: true } }),
  ]);
  const uploaded = new Set(uploads.map((u) => u.day));
  const fixedLoad = new Map<string, number>();
  const fixedMinutes = new Map<string, Set<number>>();
  const movable: MovablePin[] = [];
  const before = new Map<string, number>();
  for (const r of dated) {
    const day = dayKey(r.scheduledAt!, TZ);
    before.set(day, (before.get(day) ?? 0) + 1);
    if (r.scheduleFixed || uploaded.has(day) || (o.keepRunId && r.runId === o.keepRunId)) {
      fixedLoad.set(day, (fixedLoad.get(day) ?? 0) + 1);
      const set = fixedMinutes.get(day) ?? new Set<number>();
      set.add(minuteOfDay(r.scheduledAt!, TZ));
      fixedMinutes.set(day, set);
    } else movable.push({ id: r.id, pageId: r.pageId, scheduledAt: r.scheduledAt });
  }
  for (const r of undated) movable.push({ id: r.id, pageId: r.pageId, scheduledAt: null });
  const res = redistribute({
    items: movable, fixedLoad, fixedMinutes, start: from, quotaAt: quotaOf(o.plan), blockedDays: uploaded,
    perPagePerDay: SCHEDULE.perPagePerDay, now, tz: TZ, seed: hash32(`${o.siteId}|${from}`),
  });
  const prev = new Map(movable.map((m) => [m.id, m.scheduledAt?.getTime() ?? null] as const));
  let changed = 0;
  for (const [id, at] of res.assignments) if (prev.get(id) !== at.getTime()) changed++;
  const lastOf = (m: Map<string, number>) => [...m.entries()].filter(([, n]) => n > 0).map(([d]) => d).sort(compareKeys).at(-1) ?? "";
  const span = (m: Map<string, number>, last: string) => {
    const out: Array<{ day: string; count: number }> = [];
    for (let d = from; last && compareKeys(d, last) <= 0 && out.length < 400; d = addDays(d, 1)) out.push({ day: d, count: m.get(d) ?? 0 });
    return out;
  };
  const lastBefore = lastOf(before), lastAfter = lastOf(res.perDay);
  const lastAll = [lastBefore, lastAfter].sort(compareKeys).at(-1) ?? "";
  const preview: ReschedulePreview = {
    from, movable: movable.length - undated.length, undated: undated.length, kept: dated.length - (movable.length - undated.length),
    uploadedDays: [...uploaded].sort(compareKeys),
    before: span(before, lastAll), after: span(res.perDay, lastAll), over: res.over, unscheduled: res.unscheduled.length,
    lastBefore, lastAfter, changed,
  };
  return { preview, assignments: res.assignments };
}

/** Что получится — без записи в базу. */
export async function previewReschedule(o: RescheduleOptions): Promise<ReschedulePreview> {
  return (await compute(prisma, o)).preview;
}

/** Записать новые даты пачками по 500 (под блокировкой строки сайта — как этап расписания). */
export async function writeDates(db: Db, assignments: ReadonlyMap<string, Date>): Promise<void> {
  const entries = [...assignments.entries()];
  for (let i = 0; i < entries.length; i += 500) {
    const part = entries.slice(i, i + 500);
    await db.$executeRaw`UPDATE PinRunItem SET scheduledAt = CASE id ${Prisma.join(part.map(([id, at]) => Prisma.sql`WHEN ${id} THEN ${at}`), " ")} END WHERE id IN (${Prisma.join(part.map(([id]) => id))})`;
  }
}

/** Пересчитать и записать. Внутри уже открытой транзакции (этап расписания) — передайте её `tx`. */
export async function applyReschedule(o: RescheduleOptions, tx?: Prisma.TransactionClient): Promise<ReschedulePreview> {
  const run = async (db: Prisma.TransactionClient) => {
    await db.$queryRaw`SELECT id FROM PinSite WHERE id = ${o.siteId} FOR UPDATE`;
    const { preview, assignments } = await compute(db, o);
    await writeDates(db, assignments);
    return preview;
  };
  return tx ? run(tx) : prisma.$transaction(run, { timeout: 600_000, maxWait: 30_000 });
}

/** Дни сайта (с сегодняшнего), где больше 100 пинов — для плашки на странице сайта. */
export async function siteOverDays(siteId: string, now = new Date()): Promise<DayOver[]> {
  const today = todayKey(now, TZ);
  const rows = await prisma.pinRunItem.findMany({ where: { siteId, scheduledAt: { gte: startOfDay(today, TZ) }, ...ITEM_WHERE }, select: { scheduledAt: true } });
  const m = new Map<string, number>();
  for (const r of rows) { const d = dayKey(r.scheduledAt!, TZ); m.set(d, (m.get(d) ?? 0) + 1); }
  return overDays(m, today);
}
