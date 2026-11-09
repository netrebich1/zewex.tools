import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addDays, toUtc, weekdayIndex, type Grain, type Range } from "./period";
import type { DimKind } from "./types";

/**
 * Выборки для кабинета: всё считается из своих таблиц (GaDaily / GaHourly / GaPageDaily / GaDimDaily), к Google не ходим.
 * Все функции принимают список id свойств (уже отфильтрованный по доступу) и диапазон дат "YYYY-MM-DD".
 */

export type Totals = { sessions: number; users: number; newUsers: number; pageviews: number; engaged: number; engagementSec: number; keyEvents: number; events: number };
export const ZERO: Totals = { sessions: 0, users: 0, newUsers: 0, pageviews: 0, engaged: 0, engagementSec: 0, keyEvents: 0, events: 0 };

const n = (v: unknown) => Number(v) || 0;
const inIds = (ids: string[]) => Prisma.sql`propertyId IN (${Prisma.join(ids)})`;

/** Производные показатели: отказы, среднее время визита, глубина. */
export function derive(t: Totals) {
  return {
    bounce: t.sessions ? 1 - t.engaged / t.sessions : null,
    duration: t.sessions ? t.engagementSec / t.sessions : null,
    depth: t.sessions ? t.pageviews / t.sessions : null,
    newShare: t.users ? t.newUsers / t.users : null,
  };
}

export async function totals(ids: string[], from: string, to: string): Promise<Totals> {
  if (!ids.length) return ZERO;
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT CAST(SUM(sessions) AS DOUBLE) sessions, CAST(SUM(users) AS DOUBLE) users, CAST(SUM(newUsers) AS DOUBLE) newUsers, CAST(SUM(pageviews) AS DOUBLE) pageviews,
           CAST(SUM(engaged) AS DOUBLE) engaged, CAST(SUM(engagementSec) AS DOUBLE) engagementSec, CAST(SUM(keyEvents) AS DOUBLE) keyEvents, CAST(SUM(events) AS DOUBLE) events
    FROM GaDaily WHERE ${inIds(ids)} AND date BETWEEN ${from} AND ${to}`);
  return rowTotals(rows[0]);
}
const rowTotals = (r: Record<string, unknown> | undefined): Totals => ({ sessions: n(r?.sessions), users: n(r?.users), newUsers: n(r?.newUsers), pageviews: n(r?.pageviews), engaged: n(r?.engaged), engagementSec: n(r?.engagementSec), keyEvents: n(r?.keyEvents), events: n(r?.events) });

/* ---------- Ряды для графика ---------- */

export type Point = { key: string; sessions: number; users: number; pageviews: number };

const keyExpr = (grain: Grain) =>
  grain === "hour" ? Prisma.sql`CONCAT(DATE_FORMAT(date, '%Y-%m-%d'), ' ', LPAD(hour, 2, '0'))`
  : grain === "week" ? Prisma.sql`DATE_FORMAT(DATE_SUB(date, INTERVAL WEEKDAY(date) DAY), '%Y-%m-%d')`
  : grain === "month" ? Prisma.sql`DATE_FORMAT(date, '%Y-%m-01')`
  : Prisma.sql`DATE_FORMAT(date, '%Y-%m-%d')`;

/** Все ключи диапазона по детализации (чтобы дни без данных были нулями, а не дырками). */
export function bucketKeys(from: string, to: string, grain: Grain): string[] {
  const keys: string[] = [];
  if (grain === "hour") {
    for (let d = from; d <= to; d = addDays(d, 1)) for (let h = 0; h < 24; h++) keys.push(`${d} ${String(h).padStart(2, "0")}`);
    return keys;
  }
  if (grain === "day") {
    for (let d = from; d <= to; d = addDays(d, 1)) keys.push(d);
    return keys;
  }
  if (grain === "week") {
    for (let d = addDays(from, -weekdayIndex(from)); d <= to; d = addDays(d, 7)) keys.push(d);
    return keys;
  }
  const a = toUtc(from);
  const b = toUtc(to);
  for (let y = a.getUTCFullYear(), m = a.getUTCMonth(); y < b.getUTCFullYear() || (y === b.getUTCFullYear() && m <= b.getUTCMonth()); m++) {
    if (m > 11) { m = 0; y++; }
    keys.push(`${y}-${String(m + 1).padStart(2, "0")}-01`);
  }
  return keys;
}

async function seriesRaw(ids: string[], from: string, to: string, grain: Grain): Promise<Point[]> {
  const keys = bucketKeys(from, to, grain);
  const map = new Map(keys.map((k) => [k, { key: k, sessions: 0, users: 0, pageviews: 0 }]));
  if (ids.length) {
    const table = grain === "hour" ? Prisma.sql`GaHourly` : Prisma.sql`GaDaily`;
    const rows = await prisma.$queryRaw<Array<{ k: string; s: unknown; u: unknown; p: unknown }>>(Prisma.sql`
      SELECT ${keyExpr(grain)} k, CAST(SUM(sessions) AS DOUBLE) s, CAST(SUM(users) AS DOUBLE) u, CAST(SUM(pageviews) AS DOUBLE) p
      FROM ${table} WHERE ${inIds(ids)} AND date BETWEEN ${from} AND ${to} GROUP BY k`);
    for (const r of rows) {
      const pt = map.get(r.k);
      if (pt) { pt.sessions = n(r.s); pt.users = n(r.u); pt.pageviews = n(r.p); }
    }
  }
  return [...map.values()];
}

/** Текущий ряд и ряд сравнения (выровнен по длине текущего). */
export async function series(ids: string[], r: Range): Promise<{ cur: Point[]; prev: Point[] | null }> {
  const [cur, prev] = await Promise.all([seriesRaw(ids, r.from, r.to, r.grain), r.prev ? seriesRaw(ids, r.prev.from, r.prev.to, r.grain) : null]);
  if (prev) {
    while (prev.length < cur.length) prev.push({ key: "", sessions: 0, users: 0, pageviews: 0 });
    prev.length = cur.length;
  }
  return { cur, prev };
}

/* ---------- По сайтам ---------- */

export type SiteStats = { cur: Totals; prev: Totals | null; spark: number[] };

export async function perSite(ids: string[], r: Range): Promise<Map<string, SiteStats>> {
  const out = new Map<string, SiteStats>();
  if (!ids.length) return out;
  const agg = (from: string, to: string) => prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT propertyId, CAST(SUM(sessions) AS DOUBLE) sessions, CAST(SUM(users) AS DOUBLE) users, CAST(SUM(newUsers) AS DOUBLE) newUsers, CAST(SUM(pageviews) AS DOUBLE) pageviews,
           CAST(SUM(engaged) AS DOUBLE) engaged, CAST(SUM(engagementSec) AS DOUBLE) engagementSec, CAST(SUM(keyEvents) AS DOUBLE) keyEvents, CAST(SUM(events) AS DOUBLE) events
    FROM GaDaily WHERE ${inIds(ids)} AND date BETWEEN ${from} AND ${to} GROUP BY propertyId`);
  const sparkGrain: Grain = r.days <= 2 ? "hour" : r.days <= 120 ? "day" : "week";
  const keys = bucketKeys(r.from, r.to, sparkGrain);
  const [cur, prev, spark] = await Promise.all([
    agg(r.from, r.to),
    r.prev ? agg(r.prev.from, r.prev.to) : null,
    prisma.$queryRaw<Array<{ propertyId: string; k: string; s: unknown }>>(Prisma.sql`
      SELECT propertyId, ${keyExpr(sparkGrain)} k, CAST(SUM(sessions) AS DOUBLE) s FROM ${sparkGrain === "hour" ? Prisma.sql`GaHourly` : Prisma.sql`GaDaily`}
      WHERE ${inIds(ids)} AND date BETWEEN ${r.from} AND ${r.to} GROUP BY propertyId, k`),
  ]);
  for (const id of ids) out.set(id, { cur: ZERO, prev: r.prev ? ZERO : null, spark: keys.map(() => 0) });
  for (const row of cur) out.get(String(row.propertyId))!.cur = rowTotals(row);
  for (const row of prev ?? []) out.get(String(row.propertyId))!.prev = rowTotals(row);
  const idx = new Map(keys.map((k, i) => [k, i]));
  for (const row of spark) {
    const i = idx.get(row.k);
    if (i != null) out.get(row.propertyId)!.spark[i] = n(row.s);
  }
  return out;
}

/* ---------- Страницы ---------- */

export type PageRow = { propertyId: string; pathHash: string; path: string; title: string; pageviews: number; users: number; sessions: number; engagementSec: number; prevViews: number | null; prevUsers: number | null };
export type PageSort = "views" | "users" | "growth" | "decline" | "growthPct" | "declinePct" | "duration";
export const PAGE_SORTS: Array<{ key: PageSort; label: string }> = [
  { key: "views", label: "Просмотры" },
  { key: "users", label: "Посетители" },
  { key: "growth", label: "Рост" },
  { key: "decline", label: "Падение" },
];
const PAGES_SCAN = 5000;

/** Страницы за период с данными прошлого периода; поиск по адресу и заголовку, сортировка в том числе по росту/падению. */
export async function pages(ids: string[], r: Range, opts: { q?: string; sort?: PageSort; limit: number; offset: number }): Promise<{ rows: PageRow[]; total: number }> {
  if (!ids.length) return { rows: [], total: 0 };
  const q = opts.q?.trim();
  const like = q ? Prisma.sql`AND (path LIKE ${`%${q}%`} OR title LIKE ${`%${q}%`})` : Prisma.empty;
  const agg = (from: string, to: string) => prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT propertyId, pathHash, MAX(path) path, SUBSTRING(MAX(CONCAT(DATE_FORMAT(date, '%Y%m%d'), title)), 9) title,
           CAST(SUM(pageviews) AS DOUBLE) pageviews, CAST(SUM(users) AS DOUBLE) users, CAST(SUM(sessions) AS DOUBLE) sessions, CAST(SUM(engagementSec) AS DOUBLE) engagementSec
    FROM GaPageDaily WHERE ${inIds(ids)} AND date BETWEEN ${from} AND ${to} ${like}
    GROUP BY propertyId, pathHash ORDER BY pageviews DESC LIMIT ${PAGES_SCAN}`);
  const [cur, prev] = await Promise.all([agg(r.from, r.to), r.prev ? agg(r.prev.from, r.prev.to) : null]);
  const key = (x: Record<string, unknown>) => `${x.propertyId}|${x.pathHash}`;
  const map = new Map<string, PageRow>();
  for (const x of cur) map.set(key(x), { propertyId: String(x.propertyId), pathHash: String(x.pathHash), path: String(x.path), title: String(x.title ?? ""), pageviews: n(x.pageviews), users: n(x.users), sessions: n(x.sessions), engagementSec: n(x.engagementSec), prevViews: prev ? 0 : null, prevUsers: prev ? 0 : null });
  for (const x of prev ?? []) {
    const k = key(x);
    const row = map.get(k);
    if (row) { row.prevViews = n(x.pageviews); row.prevUsers = n(x.users); }
    else map.set(k, { propertyId: String(x.propertyId), pathHash: String(x.pathHash), path: String(x.path), title: String(x.title ?? ""), pageviews: 0, users: 0, sessions: 0, engagementSec: 0, prevViews: n(x.pageviews), prevUsers: n(x.users) });
  }
  let rows = [...map.values()];
  const sort = opts.sort ?? "views";
  // Страницы без просмотров в текущем периоде нужны только в сортировке «падение».
  if (sort !== "decline" && sort !== "declinePct") rows = rows.filter((x) => x.pageviews > 0);
  const diff = (x: PageRow) => x.pageviews - (x.prevViews ?? 0);
  const pct = (x: PageRow) => (x.prevViews ? diff(x) / x.prevViews : x.pageviews ? 10 : 0);
  const cmp: Record<PageSort, (a: PageRow, b: PageRow) => number> = {
    views: (a, b) => b.pageviews - a.pageviews,
    users: (a, b) => b.users - a.users,
    growth: (a, b) => diff(b) - diff(a),
    decline: (a, b) => diff(a) - diff(b),
    growthPct: (a, b) => pct(b) - pct(a),
    declinePct: (a, b) => pct(a) - pct(b),
    duration: (a, b) => (b.sessions ? b.engagementSec / b.sessions : 0) - (a.sessions ? a.engagementSec / a.sessions : 0),
  };
  rows.sort(cmp[sort]);
  return { rows: rows.slice(opts.offset, opts.offset + opts.limit), total: rows.length };
}

/** Ряд одной страницы (для раскрытия строки / карточки страницы). */
export async function pageSeries(propertyId: string, pathHash: string, r: Range): Promise<Point[]> {
  const grain: Grain = r.grain === "hour" ? "day" : r.grain;
  const keys = bucketKeys(r.from, r.to, grain);
  const map = new Map(keys.map((k) => [k, { key: k, sessions: 0, users: 0, pageviews: 0 }]));
  const rows = await prisma.$queryRaw<Array<{ k: string; s: unknown; u: unknown; p: unknown }>>(Prisma.sql`
    SELECT ${keyExpr(grain)} k, CAST(SUM(sessions) AS DOUBLE) s, CAST(SUM(users) AS DOUBLE) u, CAST(SUM(pageviews) AS DOUBLE) p
    FROM GaPageDaily WHERE propertyId = ${propertyId} AND pathHash = ${pathHash} AND date BETWEEN ${r.from} AND ${r.to} GROUP BY k`);
  for (const x of rows) {
    const pt = map.get(x.k);
    if (pt) { pt.sessions = n(x.s); pt.users = n(x.u); pt.pageviews = n(x.p); }
  }
  return [...map.values()];
}

/* ---------- Разрезы ---------- */

export type DimRow = { value: string; sessions: number; users: number; prevSessions: number | null };

export async function dims(ids: string[], r: Range, kind: DimKind, limit = 12): Promise<DimRow[]> {
  if (!ids.length) return [];
  const cur = await prisma.$queryRaw<Array<{ value: string; s: unknown; u: unknown }>>(Prisma.sql`
    SELECT value, CAST(SUM(sessions) AS DOUBLE) s, CAST(SUM(users) AS DOUBLE) u FROM GaDimDaily
    WHERE ${inIds(ids)} AND kind = ${kind} AND date BETWEEN ${r.from} AND ${r.to} GROUP BY value ORDER BY s DESC LIMIT ${limit}`);
  const rows: DimRow[] = cur.map((x) => ({ value: x.value, sessions: n(x.s), users: n(x.u), prevSessions: r.prev ? 0 : null }));
  if (r.prev && rows.length) {
    const prev = await prisma.$queryRaw<Array<{ value: string; s: unknown }>>(Prisma.sql`
      SELECT value, CAST(SUM(sessions) AS DOUBLE) s FROM GaDimDaily
      WHERE ${inIds(ids)} AND kind = ${kind} AND date BETWEEN ${r.prev.from} AND ${r.prev.to} AND value IN (${Prisma.join(rows.map((x) => x.value))}) GROUP BY value`);
    const m = new Map(prev.map((x) => [x.value, n(x.s)]));
    for (const row of rows) row.prevSessions = m.get(row.value) ?? 0;
  }
  return rows;
}

/* ---------- Часы × дни недели ---------- */

/** Матрица 7×24 (пн..вс × 0..23): средние визиты в час за период. */
export async function hourHeatmap(ids: string[], from: string, to: string): Promise<number[][]> {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  if (!ids.length) return grid;
  const rows = await prisma.$queryRaw<Array<{ wd: unknown; h: unknown; s: unknown }>>(Prisma.sql`
    SELECT WEEKDAY(date) wd, hour h, CAST(SUM(sessions) AS DOUBLE) s FROM GaHourly WHERE ${inIds(ids)} AND date BETWEEN ${from} AND ${to} GROUP BY wd, h`);
  // Сколько раз каждый день недели встречается в периоде — чтобы показать среднее, а не сумму.
  const count = Array.from({ length: 7 }, () => 0);
  for (let d = from; d <= to; d = addDays(d, 1)) count[weekdayIndex(d)]++;
  for (const x of rows) {
    const wd = n(x.wd);
    const h = n(x.h);
    if (wd >= 0 && wd < 7 && h >= 0 && h < 24) grid[wd][h] = count[wd] ? n(x.s) / count[wd] : 0;
  }
  return grid;
}

/** Есть ли вообще данные (чтобы отличить «ещё грузится» от «нет трафика»). */
export async function hasData(ids: string[]): Promise<boolean> {
  if (!ids.length) return false;
  const r = await prisma.gaDaily.findFirst({ where: { propertyId: { in: ids } }, select: { propertyId: true } });
  return !!r;
}

