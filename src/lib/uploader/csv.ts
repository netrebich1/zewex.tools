/**
 * CSV для агента: тот же файл дня, что скачивает человек в «Выгрузке» (dayItems + buildDayFiles),
 * но без события «выгрузка скачана» — событие заливки придёт, когда агент закончит.
 */
import { prisma } from "@/lib/db";
import { buildDayFiles } from "@/lib/pins/export/day";
import { dayItems } from "@/lib/pins/export/service";
import { TZ } from "@/lib/pins/runs/stats";
import { todayKey } from "@/lib/pins/schedule/math";

export type DayPreview = { fileName: string; count: number; issues: number };

/** Сколько пинов попадёт в файл сайта на день и как он будет называться (без записи в базу). */
export async function previewDay(siteId: string, siteName: string, day: string, now = new Date()): Promise<DayPreview | null> {
  const items = await dayItems(siteId, day);
  if (!items.length) return null;
  const f = buildDayFiles({ items, day, siteName, tz: TZ, now, isToday: day === todayKey(now, TZ) });
  return f.count ? { fileName: f.fileName, count: f.count, issues: f.issues.length } : null;
}

/** Готовый CSV для задания: сегодняшние пропущенные слоты пересчитываются и сохраняются, как при ручной выгрузке; пишется PinExportLog без пользователя. */
export async function buildTaskCsv(siteId: string, day: string): Promise<{ fileName: string; csv: string; count: number } | null> {
  const site = await prisma.pinSite.findUnique({ where: { id: siteId }, select: { id: true, name: true, teamId: true } });
  if (!site) return null;
  const items = await dayItems(siteId, day);
  if (!items.length) return null;
  const now = new Date();
  const f = buildDayFiles({ items, day, siteName: site.name, tz: TZ, now, isToday: day === todayKey(now, TZ) });
  if (!f.count) return null;
  for (const [id, at] of f.retimedAt) await prisma.pinRunItem.update({ where: { id }, data: { scheduledAt: at, scheduleFixed: true } });
  await prisma.pinExportLog.create({ data: { teamId: site.teamId, siteId, day, fileName: f.fileName, rows: f.count, userId: null } });
  return { fileName: f.fileName, csv: "﻿" + f.csv, count: f.count };
}
