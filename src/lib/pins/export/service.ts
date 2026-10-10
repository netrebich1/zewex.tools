import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { canAccessPinSite, pinSiteWhere } from "@/lib/sites/access";
import { buildDayFiles } from "./day";
import type { ExportItem } from "./pinterest";
import { startOfDay, addDays, todayKey } from "../schedule/math";
import { TZ } from "../runs/stats";
import { publicUrl } from "../storage";

/** Пины сайта на день (в рабочем поясе), готовые к выгрузке: одобрены, с текстом и картинкой в WP. */
export async function dayItems(siteId: string, day: string): Promise<ExportItem[]> {
  const from = startOfDay(day, TZ);
  const to = startOfDay(addDays(day, 1), TZ);
  const rows = await prisma.pinRunItem.findMany({
    where: { siteId, scheduledAt: { gte: from, lt: to }, status: "READY", moderation: "APPROVED", title: { not: "" } },
    orderBy: { scheduledAt: "asc" },
    include: { page: { select: { keyword: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    altText: r.altText,
    imageUrl: r.wpMediaUrl || (r.imagePath ? publicUrl(r.imagePath) : r.sourceImageUrl),
    link: r.targetLink,
    boardName: r.boardName,
    scheduledAt: r.scheduledAt,
    keywords: r.page.keyword,
  }));
}

export type DayFile = { siteId: string; siteName: string; day: string; fileName: string; count: number; issues: number; retimed: number; linksReplaced: number; downloadedAt: Date | null; downloadedBy: string | null };

/** Сводка по дням и сайтам без построения CSV целиком (CSV собирается при скачивании). */
export async function exportOverview(me: CurrentUser, siteIds: string[], days: string[]): Promise<DayFile[]> {
  const sites = await prisma.pinSite.findMany({ where: { id: { in: siteIds }, ...(await pinSiteWhere(me)) }, select: { id: true, name: true, teamId: true } });
  const allowed = sites;
  const logs = await prisma.pinExportLog.findMany({ where: { siteId: { in: allowed.map((s) => s.id) }, day: { in: days } }, orderBy: { createdAt: "desc" } });
  const out: DayFile[] = [];
  const now = new Date();
  for (const s of allowed) {
    for (const day of days) {
      const items = await dayItems(s.id, day);
      if (!items.length) continue;
      const f = buildDayFiles({ items, day, siteName: s.name, tz: TZ, now, isToday: day === todayKey(now, TZ) });
      const log = logs.find((l) => l.siteId === s.id && l.day === day);
      out.push({ siteId: s.id, siteName: s.name, day, fileName: f.fileName, count: f.count, issues: f.issues.length, retimed: f.fixes.retimed, linksReplaced: f.fixes.linksReplaced, downloadedAt: log?.createdAt ?? null, downloadedBy: log?.userId ?? null });
    }
  }
  return out;
}

/** Готовый CSV на день: сегодняшние пропущенные слоты пересчитываются и сохраняются; скачивание логируется. */
export async function dayCsv(me: CurrentUser, siteId: string, day: string): Promise<{ fileName: string; csv: string; count: number } | null> {
  const site = await prisma.pinSite.findUnique({ where: { id: siteId }, select: { id: true, name: true, teamId: true, wpConnectionId: true } });
  if (!site || !(await canAccessPinSite(me, site))) return null;
  const items = await dayItems(siteId, day);
  if (!items.length) return null;
  const now = new Date();
  const f = buildDayFiles({ items, day, siteName: site.name, tz: TZ, now, isToday: day === todayKey(now, TZ) });
  for (const [id, at] of f.retimedAt) await prisma.pinRunItem.update({ where: { id }, data: { scheduledAt: at, scheduleFixed: true } });
  await prisma.pinExportLog.create({ data: { teamId: site.teamId, siteId, day, fileName: f.fileName, rows: f.count, userId: me.id } });
  return { fileName: f.fileName, csv: "﻿" + f.csv, count: f.count };
}
