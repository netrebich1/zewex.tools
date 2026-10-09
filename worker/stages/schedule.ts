import { prisma } from "@/lib/db";
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
      startFrom: rc.recipe.schedule.startFrom,
      now: new Date(),
      seed: rc.settings.seed,
      tz: TZ,
    });
    for (const [id, at] of res.assignments) await tx.pinRunItem.update({ where: { id }, data: { scheduledAt: at } });
    return res;
  }, { timeout: 120_000 });
  const done = out.assignments.size;
  await ctx.tick({ done, total: need, label: `Расписание ${done}/${need}` });
  const note = out.unscheduled.length ? `; не поместились в 30 дней: ${out.unscheduled.length} (получат даты позже, когда освободятся дни)` : "";
  return { summary: `даты: ${done} (${out.firstDay} … ${out.lastDay})${note}` };
};
