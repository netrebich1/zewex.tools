import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { GaError, listProperties, runReport, sha1, type GaAccountRow, type ReportRow } from "./google";
import { addDays, todayIn } from "./period";
import { BACKFILL_DAYS, DIM_KINDS, DIMS_ROWS_LIMIT, KEEP_DIMS_DAYS, KEEP_HOURLY_DAYS, KEEP_PAGES_DAYS, PAGES_BACKFILL_STEP, PAGES_FETCH_ROWS, PAGES_PER_DAY, RESYNC_DAYS, SYNC_INTERVAL_MIN, type DimKind, type SyncState } from "./types";

/**
 * Синхронизация GA4 → своя база. Один проход (`syncProperty`): перечитать последние RESYNC_DAYS дней (GA досчитывает данные
 * до двух суток) и, пока история не загружена, докачать порцию назад. Дневные итоги, часы и разрезы грузятся одним запросом
 * на весь срок; страницы — по дню (топ PAGES_PER_DAY), порциями по PAGES_BACKFILL_STEP дней за проход.
 */

type PropertyRow = { id: string; propertyId: string; timezone: string; syncState: unknown; account: GaAccountRow & { status: string } };

const state = (p: PropertyRow): SyncState => ((p.syncState ?? {}) as SyncState);

export type SyncResult = { kind: "ok" | "auth" | "quota" | "error"; message?: string; done: boolean; requests: number };

export async function syncProperty(p: PropertyRow): Promise<SyncResult> {
  const today = todayIn(p.timezone);
  const st = { ...state(p) };
  let requests = 0;
  const first = !st.dailyFrom;
  const targets = {
    daily: addDays(today, -(BACKFILL_DAYS.daily - 1)),
    hourly: addDays(today, -(BACKFILL_DAYS.hourly - 1)),
    dims: addDays(today, -(BACKFILL_DAYS.dims - 1)),
    pages: addDays(today, -(BACKFILL_DAYS.pages - 1)),
  };
  const save = async (extra: Record<string, unknown> = {}) => {
    const done = !!st.dailyFrom && st.dailyFrom <= targets.daily && !!st.hourlyFrom && st.hourlyFrom <= targets.hourly && !!st.dimsFrom && st.dimsFrom <= targets.dims && !!st.pagesFrom && st.pagesFrom <= targets.pages;
    await prisma.gaProperty.update({ where: { id: p.id }, data: { syncState: { ...st, done } as Prisma.InputJsonValue, ...extra } });
    return done;
  };
  try {
    // 1. Свежие дни (кроме самого первого прохода: его покрывает загрузка истории).
    if (!first) {
      const from = addDays(today, -(RESYNC_DAYS - 1));
      await loadDaily(p, from, today);
      await loadHourly(p, from, today);
      await loadDims(p, from, today);
      requests += 2 + DIM_KINDS.length;
      for (let d = from; d <= today; d = addDays(d, 1)) {
        await loadPagesDay(p, d);
        requests++;
      }
    }
    // 2. История назад: итоги/часы/разрезы — сразу целиком, страницы — порцией.
    if (!st.dailyFrom || st.dailyFrom > targets.daily) {
      const to = st.dailyFrom ? addDays(st.dailyFrom, -1) : today;
      await loadDaily(p, targets.daily, to);
      st.dailyFrom = targets.daily;
      requests++;
    }
    if (!st.hourlyFrom || st.hourlyFrom > targets.hourly) {
      const to = st.hourlyFrom ? addDays(st.hourlyFrom, -1) : today;
      await loadHourly(p, targets.hourly, to);
      st.hourlyFrom = targets.hourly;
      requests++;
    }
    if (!st.dimsFrom || st.dimsFrom > targets.dims) {
      const to = st.dimsFrom ? addDays(st.dimsFrom, -1) : today;
      await loadDims(p, targets.dims, to);
      st.dimsFrom = targets.dims;
      requests += DIM_KINDS.length;
    }
    if (!st.pagesFrom || st.pagesFrom > targets.pages) {
      const to = st.pagesFrom ? addDays(st.pagesFrom, -1) : today;
      const step = addDays(to, -(PAGES_BACKFILL_STEP - 1));
      const from = step < targets.pages ? targets.pages : step;
      for (let d = to; d >= from; d = addDays(d, -1)) {
        await loadPagesDay(p, d);
        requests++;
      }
      st.pagesFrom = from;
    }
    const done = await save({ lastSyncAt: new Date(), lastSyncError: null });
    // Пока история грузится — следующий проход сразу (с короткой паузой), иначе по расписанию.
    await prisma.gaProperty.update({ where: { id: p.id }, data: { nextSyncAt: new Date(Date.now() + (done ? SYNC_INTERVAL_MIN * 60_000 : 5_000)) } });
    return { kind: "ok", done, requests };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const ga = e instanceof GaError ? e : null;
    const retryMin = ga?.auth ? 6 * 60 : ga?.quota ? 60 : 15;
    await save({ lastSyncError: msg, nextSyncAt: new Date(Date.now() + retryMin * 60_000) }).catch(() => {});
    if (ga?.auth) {
      await prisma.gaAccount.update({ where: { id: p.account.id }, data: { status: "ERROR", lastError: msg } }).catch(() => {});
      return { kind: "auth", message: msg, done: false, requests };
    }
    return { kind: ga?.quota ? "quota" : "error", message: msg, done: false, requests };
  }
}

/* ---------- Загрузчики ---------- */

const gaDate = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

async function loadDaily(p: PropertyRow, from: string, to: string) {
  const rows = await runReport(p.account, p.propertyId, {
    dimensions: ["date"],
    metrics: ["sessions", "totalUsers", "newUsers", "screenPageViews", "engagedSessions", "userEngagementDuration", "keyEvents", "eventCount"],
    from, to, limit: 1000, orderByDimension: "date",
  });
  const values = rows.filter((r) => /^\d{8}$/.test(r.dims[0])).map((r) => Prisma.sql`(${p.id}, ${gaDate(r.dims[0])}, ${r.metrics[0]}, ${r.metrics[1]}, ${r.metrics[2]}, ${r.metrics[3]}, ${r.metrics[4]}, ${r.metrics[5]}, ${r.metrics[6]}, ${r.metrics[7]})`);
  // Дни без данных тоже нужны: иначе на графике останутся старые значения после пересчёта GA.
  await prisma.$executeRaw`DELETE FROM GaDaily WHERE propertyId = ${p.id} AND date BETWEEN ${from} AND ${to}`;
  for (const chunk of chunks(values, 500)) {
    await prisma.$executeRaw`INSERT INTO GaDaily (propertyId, date, sessions, users, newUsers, pageviews, engaged, engagementSec, keyEvents, events) VALUES ${Prisma.join(chunk)}`;
  }
}

async function loadHourly(p: PropertyRow, from: string, to: string) {
  const rows = await runReport(p.account, p.propertyId, { dimensions: ["dateHour"], metrics: ["sessions", "totalUsers", "screenPageViews"], from, to, limit: 20_000, orderByDimension: "dateHour" });
  const values = rows.filter((r) => /^\d{10}$/.test(r.dims[0])).map((r) => Prisma.sql`(${p.id}, ${gaDate(r.dims[0])}, ${Number(r.dims[0].slice(8, 10))}, ${r.metrics[0]}, ${r.metrics[1]}, ${r.metrics[2]})`);
  await prisma.$executeRaw`DELETE FROM GaHourly WHERE propertyId = ${p.id} AND date BETWEEN ${from} AND ${to}`;
  for (const chunk of chunks(values, 500)) {
    await prisma.$executeRaw`INSERT INTO GaHourly (propertyId, date, hour, sessions, users, pageviews) VALUES ${Prisma.join(chunk)}`;
  }
}

const DIM_SOURCE: Record<DimKind, { dimension: string; filter?: unknown }> = {
  channel: { dimension: "sessionDefaultChannelGroup" },
  source: { dimension: "sessionSource" },
  country: { dimension: "country" },
  device: { dimension: "deviceCategory" },
  referrer: { dimension: "sessionSource", filter: { filter: { fieldName: "sessionMedium", stringFilter: { matchType: "EXACT", value: "referral" } } } },
};

async function loadDims(p: PropertyRow, from: string, to: string) {
  for (const kind of DIM_KINDS) {
    const src = DIM_SOURCE[kind];
    const rows = await runReport(p.account, p.propertyId, { dimensions: ["date", src.dimension], metrics: ["sessions", "totalUsers"], from, to, limit: DIMS_ROWS_LIMIT, orderByMetricDesc: "sessions", dimensionFilter: src.filter });
    const values = rows.filter((r) => /^\d{8}$/.test(r.dims[0])).map((r) => Prisma.sql`(${p.id}, ${gaDate(r.dims[0])}, ${kind}, ${(r.dims[1] || "(not set)").slice(0, 190)}, ${r.metrics[0]}, ${r.metrics[1]})`);
    await prisma.$executeRaw`DELETE FROM GaDimDaily WHERE propertyId = ${p.id} AND kind = ${kind} AND date BETWEEN ${from} AND ${to}`;
    for (const chunk of chunks(values, 500)) {
      await prisma.$executeRaw`INSERT INTO GaDimDaily (propertyId, date, kind, value, sessions, users) VALUES ${Prisma.join(chunk)} ON DUPLICATE KEY UPDATE sessions = sessions + VALUES(sessions), users = users + VALUES(users)`;
    }
  }
}

/** Страницы за день: путь + заголовок → сливаем по пути (заголовок — у самого просматриваемого варианта), оставляем топ PAGES_PER_DAY. */
async function loadPagesDay(p: PropertyRow, day: string) {
  const rows = await runReport(p.account, p.propertyId, { dimensions: ["pagePath", "pageTitle"], metrics: ["screenPageViews", "totalUsers", "sessions", "userEngagementDuration"], from: day, to: day, limit: PAGES_FETCH_ROWS, orderByMetricDesc: "screenPageViews" });
  const merged = mergePages(rows).slice(0, PAGES_PER_DAY);
  const values = merged.map((r) => Prisma.sql`(${p.id}, ${day}, ${sha1(r.path)}, ${r.path.slice(0, 1000)}, ${r.title.slice(0, 500)}, ${r.pageviews}, ${r.users}, ${r.sessions}, ${r.engagementSec})`);
  await prisma.$executeRaw`DELETE FROM GaPageDaily WHERE propertyId = ${p.id} AND date = ${day}`;
  for (const chunk of chunks(values, 500)) {
    await prisma.$executeRaw`INSERT INTO GaPageDaily (propertyId, date, pathHash, path, title, pageviews, users, sessions, engagementSec) VALUES ${Prisma.join(chunk)}`;
  }
}

export type PageAgg = { path: string; title: string; pageviews: number; users: number; sessions: number; engagementSec: number };

/** Чистая функция: строки (path, title) → по пути; заголовок берём у варианта с наибольшими просмотрами. */
export function mergePages(rows: ReportRow[]): PageAgg[] {
  const map = new Map<string, PageAgg & { bestViews: number }>();
  for (const r of rows) {
    const path = normalizePath(r.dims[0] || "/");
    const title = (r.dims[1] || "").trim();
    const [pageviews, users, sessions, engagementSec] = r.metrics;
    const cur = map.get(path);
    if (!cur) {
      map.set(path, { path, title, pageviews, users, sessions, engagementSec, bestViews: pageviews });
      continue;
    }
    cur.pageviews += pageviews;
    cur.users += users;
    cur.sessions += sessions;
    cur.engagementSec += engagementSec;
    if (pageviews > cur.bestViews || (!cur.title && title)) {
      cur.title = title || cur.title;
      cur.bestViews = pageviews;
    }
  }
  return [...map.values()].sort((a, b) => b.pageviews - a.pageviews).map(({ bestViews: _b, ...rest }) => rest);
}

/** Убираем хвостовой слэш у всех путей, кроме корня: «/post/» и «/post» — одна страница. */
export function normalizePath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
}

function* chunks<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

/* ---------- Список свойств аккаунта ---------- */

/** Обновить список GA4-свойств аккаунта: новые добавить (выключенными), пропавшие пометить removed. */
export async function refreshAccountProperties(accountId: string): Promise<{ added: number; total: number }> {
  const acc = await prisma.gaAccount.findUniqueOrThrow({ where: { id: accountId } });
  try {
    const list = await listProperties(acc);
    const existing = await prisma.gaProperty.findMany({ where: { accountId }, select: { id: true, propertyId: true } });
    const seen = new Set<string>();
    let added = 0;
    for (const [i, p] of list.entries()) {
      seen.add(p.propertyId);
      const data = { name: p.name, gaAccountName: p.gaAccountName, gaAccountId: p.gaAccountId, url: p.url, host: p.host, timezone: p.timezone, currency: p.currency, removed: false };
      const ex = existing.find((e) => e.propertyId === p.propertyId);
      if (ex) await prisma.gaProperty.update({ where: { id: ex.id }, data });
      else {
        await prisma.gaProperty.create({ data: { ...data, accountId, propertyId: p.propertyId, order: i } });
        added++;
      }
    }
    const gone = existing.filter((e) => !seen.has(e.propertyId)).map((e) => e.id);
    if (gone.length) await prisma.gaProperty.updateMany({ where: { id: { in: gone } }, data: { removed: true } });
    await prisma.gaAccount.update({ where: { id: accountId }, data: { status: "OK", lastError: null, propertiesSyncedAt: new Date() } });
    return { added, total: list.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.gaAccount.update({ where: { id: accountId }, data: { lastError: msg, ...(e instanceof GaError && e.auth ? { status: "ERROR" } : {}) } });
    throw e;
  }
}

/* ---------- Очередь для воркера ---------- */

export type ClaimedProperty = PropertyRow & { name: string };

/** Забрать один сайт на синхронизацию (аренда 15 минут). */
export async function claimProperty(workerId: string): Promise<ClaimedProperty | null> {
  const now = new Date();
  const stale = new Date(now.getTime() - 15 * 60_000);
  const cand = await prisma.gaProperty.findFirst({
    where: { enabled: true, removed: false, account: { status: "OK" }, OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }], AND: [{ OR: [{ syncLockedAt: null }, { syncLockedAt: { lt: stale } }] }] },
    orderBy: [{ nextSyncAt: "asc" }],
    include: { account: true },
  });
  if (!cand) return null;
  const r = await prisma.gaProperty.updateMany({ where: { id: cand.id, syncLockedAt: cand.syncLockedAt }, data: { syncLockedAt: now, syncLockedBy: workerId } });
  if (r.count !== 1) return null;
  return cand;
}

export async function releaseProperty(id: string) {
  await prisma.gaProperty.update({ where: { id }, data: { syncLockedAt: null, syncLockedBy: null } }).catch(() => {});
}

/** Старые часы, страницы и разрезы не нужны: дневные итоги остаются навсегда. */
export async function purgeOldAnalytics(): Promise<{ hourly: number; pages: number; dims: number }> {
  const cut = (days: number) => addDays(todayIn("UTC"), -days);
  const [h, pg, d] = await Promise.all([
    prisma.$executeRaw`DELETE FROM GaHourly WHERE date < ${cut(KEEP_HOURLY_DAYS)}`,
    prisma.$executeRaw`DELETE FROM GaPageDaily WHERE date < ${cut(KEEP_PAGES_DAYS)}`,
    prisma.$executeRaw`DELETE FROM GaDimDaily WHERE date < ${cut(KEEP_DIMS_DAYS)}`,
  ]);
  return { hourly: h, pages: pg, dims: d };
}
