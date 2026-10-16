import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { scheduleItems, type ScheduleItem } from "@/lib/pins/schedule/plan";
import { TZ, dayKey } from "@/lib/pins/runs/stats";
import type { StageHandler } from "./index";
import { loadRunCtx } from "./_shared";

/** Этап schedule: даты публикации для загруженных и одобренных пинов с учётом других прогонов сайта. */
export const schedule: StageHandler = async (ctx) => {
  const rc = await loadRunCtx(ctx);
  const rows = await prisma.pinRunItem.findMany({
    where: { runId: rc.run.id, status: "READY", moderation: "APPROVED", wpMediaUrl: { not: "" }, title: { not: "" } },
    select: { id: true, pageId: true, scheduledAt: true, scheduleFixed: true },
    orderBy: { sortOrder: "asc" },
  });
  const need = rows.filter((r) => !r.scheduledAt).length;
  await ctx.tick({ done: 0, total: need, label: "Расписание" });
  if (!need) return { summary: "все пины уже с датами" };

  const byPage = new Map<string, ScheduleItem[]>();
  for (const r of rows) byPage.set(r.pageId, [...(byPage.get(r.pageId) ?? []), { id: r.id, scheduledAt: r.scheduledAt, scheduleFixed: r.scheduleFixed }]);
  // Нагрузка сайта читается и даты пишутся под блокировкой строки сайта: два прогона одного сайта
  // не могут одновременно заполнить один день до лимита дважды.
  const out = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM PinSite WHERE id = ${rc.site.id} FOR UPDATE`;
    const loadRows = await tx.pinRunItem.findMany({
      where: { siteId: rc.site.id, scheduledAt: { not: null }, moderation: { not: "REJECTED" }, status: { notIn: ["POOL", "REMOVED"] }, runId: { not: rc.run.id } },
      select: { scheduledAt: true },
    });
    const load = new Map<string, number>();
    for (const r of loadRows) if (r.scheduledAt) load.set(dayKey(r.scheduledAt), (load.get(dayKey(r.scheduledAt)) ?? 0) + 1);
    const res = scheduleItems({
      itemsByPage: byPage,
      existingLoad: load,
      pinsPerDay: rc.recipe.schedule.pinsPerDay,
      mode: rc.recipe.schedule.dailyMode,
      lastDate: rc.recipe.schedule.lastDate || undefined,
      windowDays: rc.recipe.schedule.windowDays,
      perPagePerDay: rc.recipe.schedule.perPagePerDay,
      firstPinWindowDays: rc.recipe.schedule.firstPinWindowDays,
      stepMinDays: rc.recipe.schedule.stepMinDays,
      stepMaxDays: rc.recipe.schedule.stepMaxDays,
      startFrom: rc.recipe.schedule.startFrom,
      now: new Date(),
      seed: rc.settings.seed,
      tz: TZ,
    });
    // Даты пишем пачками по 500 одним UPDATE … CASE: прогон до 3000 статей даёт десятки тысяч пинов.
    const entries = [...res.assignments.entries()];
    for (let i = 0; i < entries.length; i += 500) {
      const part = entries.slice(i, i + 500);
      await tx.$executeRaw`UPDATE PinRunItem SET scheduledAt = CASE id ${Prisma.join(part.map(([id, at]) => Prisma.sql`WHEN ${id} THEN ${at}`), " ")} END WHERE id IN (${Prisma.join(part.map(([id]) => id))})`;
    }
    return res;
  }, { timeout: 600_000, maxWait: 30_000 });
  const done = out.assignments.size;
  // Что пришлось изменить из-за общего лимита сайта — сохраняем в настройках прогона, интерфейс покажет это рядом с прогоном.
  const fresh = await prisma.pinRun.findUnique({ where: { id: rc.run.id }, select: { settings: true } });
  const report = out.limitReport || out.unscheduled.length
    ? { moved: out.limitReport?.moved ?? 0, days: out.limitReport?.days ?? [], limit: out.limitReport?.limit ?? 100, unscheduled: out.unscheduled.length, lastDay: out.lastDay, at: new Date().toISOString() }
    : null;
  await prisma.pinRun.update({ where: { id: rc.run.id }, data: { settings: { ...((fresh?.settings as object) ?? {}), scheduleReport: report } as object } });
  await ctx.tick({ done, total: need, label: `Расписание ${done}/${need}` });
  const note = (out.limitReport ? `; лимит ${out.limitReport.limit}/день: перенесено ${out.limitReport.moved}` : "") + (out.unscheduled.length ? `; без даты: ${out.unscheduled.length}` : "");
  return { summary: `даты: ${done} (${out.firstDay} … ${out.lastDay})${note}` };
};
