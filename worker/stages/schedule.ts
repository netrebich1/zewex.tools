import { prisma } from "@/lib/db";
import { scheduleItems, type ScheduleItem } from "@/lib/pins/schedule/plan";
import { existingLoad, TZ } from "@/lib/pins/runs/stats";
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
  const load = await existingLoad(rc.site.id, rc.run.id);
  const out = scheduleItems({
    itemsByPage: byPage,
    existingLoad: load,
    pinsPerDay: rc.recipe.schedule.pinsPerDay,
    startFrom: rc.recipe.schedule.startFrom,
    now: new Date(),
    seed: rc.settings.seed,
    tz: TZ,
  });
  let done = 0;
  for (const [id, at] of out.assignments) {
    await prisma.pinRunItem.update({ where: { id }, data: { scheduledAt: at } });
    done++;
    if (done % 50 === 0) await ctx.tick({ done, total: need, label: `Расписание ${done}/${need}` });
  }
  await ctx.tick({ done, total: need, label: `Расписание ${done}/${need}` });
  const note = out.unscheduled.length ? `; не поместились в 30 дней: ${out.unscheduled.length} (получат даты позже, когда освободятся дни)` : "";
  return { summary: `даты: ${done} (${out.firstDay} … ${out.lastDay})${note}` };
};
