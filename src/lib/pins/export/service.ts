import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { canAccessPinSite, pinSiteWhere } from "@/lib/sites/access";
import { buildDayFiles } from "./day";
import { siteSlug, type ExportItem } from "./pinterest";
import { startOfDay, addDays, todayKey, dayKey } from "../schedule/math";
import { zip } from "@/lib/xlsx";
import type { Prisma } from "@prisma/client";
import { TZ } from "../runs/stats";
import { publicUrl } from "../storage";

const READY_WHERE = { status: "READY" as const, moderation: "APPROVED" as const, title: { not: "" } };
type Row = Prisma.PinRunItemGetPayload<{ include: { page: { select: { keyword: true } } } }>;
const toExportItem = (r: Row): ExportItem => ({
  id: r.id,
  title: r.title,
  description: r.description,
  altText: r.altText,
  imageUrl: r.wpMediaUrl || (r.imagePath ? publicUrl(r.imagePath) : r.sourceImageUrl),
  link: r.targetLink,
  boardName: r.boardName,
  scheduledAt: r.scheduledAt,
  keywords: r.page.keyword,
});

/** Пины сайта на день (в рабочем поясе), готовые к выгрузке: одобрены, с текстом и картинкой в WP. */
export async function dayItems(siteId: string, day: string): Promise<ExportItem[]> {
  const from = startOfDay(day, TZ);
  const to = startOfDay(addDays(day, 1), TZ);
  const rows = await prisma.pinRunItem.findMany({
    where: { siteId, scheduledAt: { gte: from, lt: to }, ...READY_WHERE },
    orderBy: { scheduledAt: "asc" },
    include: { page: { select: { keyword: true } } },
  });
  return rows.map(toExportItem);
}

/** Сколько готовых пинов с датами (сегодня и позже) у каждого сайта и на сколько дней — для кнопки «Выгрузить всё». */
export async function futureReadyBySite(siteIds: string[]): Promise<Map<string, { pins: number; days: number; lastDay: string }>> {
  const out = new Map<string, { pins: number; days: number; lastDay: string }>();
  if (!siteIds.length) return out;
  const rows = await prisma.pinRunItem.findMany({
    where: { siteId: { in: siteIds }, scheduledAt: { gte: startOfDay(todayKey(new Date(), TZ), TZ) }, ...READY_WHERE },
    select: { siteId: true, scheduledAt: true },
  });
  const daysBySite = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.siteId || !r.scheduledAt) continue;
    const set = daysBySite.get(r.siteId) ?? new Set<string>();
    set.add(dayKey(r.scheduledAt, TZ));
    daysBySite.set(r.siteId, set);
    const cur = out.get(r.siteId) ?? { pins: 0, days: 0, lastDay: "" };
    cur.pins++;
    out.set(r.siteId, cur);
  }
  for (const [id, set] of daysBySite) { const cur = out.get(id)!; cur.days = set.size; cur.lastDay = [...set].sort().at(-1) ?? ""; }
  return out;
}

/**
 * Все сформированные пины сайта одним архивом: по CSV на каждый день с сегодняшнего (Pinterest не принимает прошедшие даты).
 * Имя каждого файла заканчивается числом пинов в дне. Сегодняшний файл пересчитывает пропущенные слоты, как при обычной выгрузке.
 */
export async function siteAllZip(me: CurrentUser, siteId: string): Promise<{ fileName: string; zip: Buffer; days: number; pins: number } | null> {
  const site = await prisma.pinSite.findUnique({ where: { id: siteId }, select: { id: true, name: true, teamId: true, wpConnectionId: true } });
  if (!site || !(await canAccessPinSite(me, site))) return null;
  const now = new Date();
  const today = todayKey(now, TZ);
  const rows = await prisma.pinRunItem.findMany({
    where: { siteId, scheduledAt: { gte: startOfDay(today, TZ) }, ...READY_WHERE },
    orderBy: { scheduledAt: "asc" },
    include: { page: { select: { keyword: true } } },
  });
  if (!rows.length) return null;
  const byDay = new Map<string, ExportItem[]>();
  for (const r of rows) { const k = dayKey(r.scheduledAt as Date, TZ); byDay.set(k, [...(byDay.get(k) ?? []), toExportItem(r)]); }
  const files: Array<{ name: string; data: string }> = [];
  const logs: Array<{ day: string; fileName: string; rows: number }> = [];
  let pins = 0;
  for (const day of [...byDay.keys()].sort()) {
    const f = buildDayFiles({ items: byDay.get(day)!, day, siteName: site.name, tz: TZ, now, isToday: day === today });
    if (!f.count) continue;
    for (const [id, at] of f.retimedAt) await prisma.pinRunItem.update({ where: { id }, data: { scheduledAt: at, scheduleFixed: true } });
    files.push({ name: f.fileName, data: "\uFEFF" + f.csv });
    logs.push({ day, fileName: f.fileName, rows: f.count });
    pins += f.count;
  }
  if (!files.length) return null;
  await prisma.pinExportLog.createMany({ data: logs.map((l) => ({ teamId: site.teamId, siteId, day: l.day, fileName: l.fileName, rows: l.rows, userId: me.id })) });
  const pad = (k: string) => { const [y, m, d] = k.split("-"); return `${d}_${m}_${y}`; };
  const first = logs[0].day, last = logs[logs.length - 1].day;
  return { fileName: `ALL_${siteSlug(site.name)}_${pad(first)}-${pad(last)}_${files.length}d_${pins}.zip`, zip: zip(files), days: files.length, pins };
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

/** Файлы на сегодня по всем доступным сайтам одним архивом: по одному CSV на сайт (все прогоны сайта вместе). */
export async function todayAllZip(me: CurrentUser): Promise<{ fileName: string; zip: Buffer; sites: number; pins: number } | null> {
  const today = todayKey(new Date(), TZ);
  const sites = await prisma.pinSite.findMany({ where: { ...(await pinSiteWhere(me)), isActive: true }, orderBy: { name: "asc" }, select: { id: true } });
  const files: Array<{ name: string; data: string }> = [];
  let pins = 0;
  for (const s of sites) {
    const f = await dayCsv(me, s.id, today);
    if (!f) continue;
    files.push({ name: f.fileName, data: f.csv });
    pins += f.count;
  }
  if (!files.length) return null;
  const [y, m, d] = today.split("-");
  return { fileName: `TODAY_${d}_${m}_${y}_${files.length}sites_${pins}.zip`, zip: zip(files), sites: files.length, pins };
}
