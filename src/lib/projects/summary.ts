/**
 * Автоматическая сводка проекта (сайта) из таблиц инструментов: пины, статьи, блог, выгрузки, расход ИИ.
 * Только чтение. Права проверяет вызывающий (visibleAccessIds). Число запросов не зависит от числа сайтов.
 */
import { prisma } from "@/lib/db";
import { Prisma, type PinRunStatus } from "@prisma/client";
import { sitesStock, TZ, dayKey } from "@/lib/pins/runs/stats";
import { futureReadyBySite } from "@/lib/pins/export/service";
import { runDefaultsFrom } from "@/lib/pins/types";
import { STATUS_FILTER_GROUPS as ART_GROUPS } from "@/lib/articles/queries";
import { STATUS_FILTER_GROUPS as BLOG_GROUPS } from "@/lib/blog/queries";
import { daysBetween, todayKey } from "@/lib/pins/schedule/math";

export type ToolLink = { ids: string[]; active: boolean };

export type PinsSummary = {
  tool: ToolLink | null;
  runs: { total: number; costUsd: number; last: { id: string; status: PinRunStatus; createdAt: string; name: string } | null; lastDoneAt: string | null };
  pins: { planned: number; ready: number; pending: number; errors: number; rejected: number; pages: number; pagesWithError: number; perPageAvg: number | null };
  schedule: { throughDay: string | null; daysLeft: number; stockRunDays: number; futureReady: number; targetPerDay: number | null };
  exports: { count: number; lastAt: string | null; rows: number; days: number };
  uploads: { lastDay: string | null; pendingDays: number; doneDays: number };
  urls: { withPins: number };
};

export type ContentSummary = {
  tool: ToolLink | null;
  total: number;
  published: number;
  inWork: number;
  failed: number;
  stopped: number;
  lastPublishedAt: string | null;
  costUsd: number;
  /** Опубликованные статьи, на которые пины ещё не делали (только с crossUrls) */
  withoutPins?: number;
};

export type ProjectSummary = {
  accessId: string;
  pins: PinsSummary;
  articles: ContentSummary;
  blog: ContentSummary;
  cost: { pins: number; articles: number; blog: number; total: number };
  /** Последнее движение по автоматике (прогон, публикация, экспорт) */
  lastActivityAt: string | null;
};

export type MonthCost = { month: string; pins: number; articles: number; blog: number; total: number };

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const maxDate = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

/** Сколько дней подряд с сегодняшнего есть хотя бы один пин — так же, как календарь на /pinterest/pins. */
export function stockRun(counts: number[]): number {
  let k = 0;
  while (k < counts.length && counts[k] > 0) k++;
  return k;
}

/** Нормализация адреса статьи для сравнения «есть ли пины»: без протокола, www, query, хэша и завершающего «/». */
export function normUrl(u: string): string {
  let s = u.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("#")[0].split("?")[0];
  return s.replace(/\/+$/, "");
}

function emptyContent(tool: ToolLink | null): ContentSummary {
  return { tool, total: 0, published: 0, inWork: 0, failed: 0, stopped: 0, lastPublishedAt: null, costUsd: 0 };
}

const artGroup = (k: string): "published" | "failed" | "stopped" | "inWork" => {
  if (k === "COMPLETED") return "published";
  if (ART_GROUPS.find((g) => g.value === "errors")?.statuses.includes(k as never)) return "failed";
  if (ART_GROUPS.find((g) => g.value === "stopped")?.statuses.includes(k as never)) return "stopped";
  return "inWork";
};
const blogGroup = (k: string): "published" | "failed" | "stopped" | "inWork" => {
  if (k === "COMPLETED") return "published";
  if (BLOG_GROUPS.find((g) => g.value === "errors")?.statuses.includes(k as never)) return "failed";
  if (k === "STOPPED") return "stopped";
  return "inWork";
};

export async function projectSummaries(accessIds: string[], opts: { crossUrls?: boolean; stockDays?: number } = {}): Promise<Map<string, ProjectSummary>> {
  const out = new Map<string, ProjectSummary>();
  if (!accessIds.length) return out;
  const [pinSites, artSites, blogSites] = await Promise.all([
    prisma.pinSite.findMany({ where: { wpConnectionId: { in: accessIds } }, select: { id: true, wpConnectionId: true, isActive: true, recipe: true } }),
    prisma.artSite.findMany({ where: { accessId: { in: accessIds } }, select: { id: true, accessId: true, isActive: true } }),
    prisma.blogSite.findMany({ where: { accessId: { in: accessIds } }, select: { id: true, accessId: true, isActive: true } }),
  ]);
  const pinToAccess = new Map(pinSites.map((s) => [s.id, s.wpConnectionId as string]));
  const artToAccess = new Map(artSites.map((s) => [s.id, s.accessId as string]));
  const blogToAccess = new Map(blogSites.map((s) => [s.id, s.accessId as string]));
  const P = pinSites.map((s) => s.id), A = artSites.map((s) => s.id), B = blogSites.map((s) => s.id);
  const toolLink = (rows: { id: string; isActive: boolean }[], key: (r: { id: string }) => string | undefined, accessId: string): ToolLink | null => {
    const mine = rows.filter((r) => key(r) === accessId);
    return mine.length ? { ids: mine.map((r) => r.id), active: mine.some((r) => r.isActive) } : null;
  };
  for (const id of accessIds) {
    out.set(id, {
      accessId: id,
      pins: {
        tool: toolLink(pinSites, (r) => pinToAccess.get(r.id), id),
        runs: { total: 0, costUsd: 0, last: null, lastDoneAt: null },
        pins: { planned: 0, ready: 0, pending: 0, errors: 0, rejected: 0, pages: 0, pagesWithError: 0, perPageAvg: null },
        schedule: { throughDay: null, daysLeft: 0, stockRunDays: 0, futureReady: 0, targetPerDay: null },
        exports: { count: 0, lastAt: null, rows: 0, days: 0 },
        uploads: { lastDay: null, pendingDays: 0, doneDays: 0 },
        urls: { withPins: 0 },
      },
      articles: emptyContent(toolLink(artSites, (r) => artToAccess.get(r.id), id)),
      blog: emptyContent(toolLink(blogSites, (r) => blogToAccess.get(r.id), id)),
      cost: { pins: 0, articles: 0, blog: 0, total: 0 },
      lastActivityAt: null,
    });
  }
  const lastActivity = new Map<string, Date | null>();
  const touch = (accessId: string, d: Date | null | undefined) => { if (d) lastActivity.set(accessId, maxDate(lastActivity.get(accessId) ?? null, d)); };

  // ── Пины ──
  if (P.length) {
    type ItemRow = { siteId: string; planned: bigint; ready: bigint; pending: bigint; errors: bigint; rejected: bigint; throughAt: Date | null };
    type LastRow = { siteId: string; id: string; status: PinRunStatus; createdAt: Date; name: string; settings: unknown };
    type PageRow = { siteId: string; pages: bigint; pagesWithError: bigint };
    type UrlRow = { siteId: string; cnt: bigint };
    type ExpDayRow = { siteId: string; day: string };
    const [runs, lastRuns, done, items, pages, stock, future, exportsAgg, exportDays, urlCounts, uploads] = await Promise.all([
      prisma.pinRun.groupBy({ by: ["siteId"], where: { siteId: { in: P }, NOT: { name: "__system__" } }, _count: { _all: true }, _sum: { costUsd: true }, _max: { createdAt: true } }),
      prisma.$queryRaw<LastRow[]>`
        SELECT siteId, id, status, createdAt, name, settings FROM (
          SELECT siteId, id, status, createdAt, name, settings, ROW_NUMBER() OVER (PARTITION BY siteId ORDER BY createdAt DESC) rn
          FROM PinRun WHERE siteId IN (${Prisma.join(P)}) AND name <> '__system__'
        ) t WHERE rn = 1`,
      prisma.pinRun.groupBy({ by: ["siteId"], where: { siteId: { in: P }, status: "DONE", NOT: { name: "__system__" } }, _max: { updatedAt: true } }),
      prisma.$queryRaw<ItemRow[]>`
        SELECT siteId,
          CAST(SUM(status NOT IN ('POOL','REMOVED') AND moderation <> 'REJECTED') AS SIGNED) AS planned,
          CAST(SUM(status = 'READY' AND moderation = 'APPROVED' AND title <> '') AS SIGNED) AS ready,
          CAST(SUM(status = 'PENDING') AS SIGNED) AS pending,
          CAST(SUM(status = 'ERROR') AS SIGNED) AS errors,
          CAST(SUM(moderation = 'REJECTED' AND status <> 'REMOVED') AS SIGNED) AS rejected,
          MAX(CASE WHEN status NOT IN ('POOL','REMOVED') AND moderation <> 'REJECTED' THEN scheduledAt END) AS throughAt
        FROM PinRunItem WHERE siteId IN (${Prisma.join(P)}) GROUP BY siteId`,
      prisma.$queryRaw<PageRow[]>`
        SELECT r.siteId, COUNT(*) AS pages, CAST(SUM(p.status = 'error') AS SIGNED) AS pagesWithError
        FROM PinRunPage p JOIN PinRun r ON r.id = p.runId
        WHERE r.siteId IN (${Prisma.join(P)}) AND r.name <> '__system__' GROUP BY r.siteId`,
      sitesStock(P, opts.stockDays ?? 92),
      futureReadyBySite(P),
      prisma.pinExportLog.groupBy({ by: ["siteId"], where: { siteId: { in: P } }, _count: { _all: true }, _sum: { rows: true }, _max: { createdAt: true } }),
      prisma.$queryRaw<ExpDayRow[]>`SELECT DISTINCT siteId, day FROM PinExportLog WHERE siteId IN (${Prisma.join(P)})`,
      prisma.$queryRaw<UrlRow[]>`SELECT siteId, COUNT(DISTINCT url) AS cnt FROM PinUrlHistory WHERE siteId IN (${Prisma.join(P)}) GROUP BY siteId`,
      prisma.prjUpload.findMany({ where: { pinSiteId: { in: P } }, select: { pinSiteId: true, day: true } }),
    ]);
    const today = todayKey(new Date(), TZ);
    const at = (siteId: string | null) => (siteId ? out.get(pinToAccess.get(siteId) ?? "") : undefined);
    for (const r of runs) {
      const s = at(r.siteId); if (!s) continue;
      s.pins.runs.total += r._count._all; s.pins.runs.costUsd += r._sum.costUsd ?? 0;
      touch(s.accessId, r._max.createdAt);
    }
    for (const r of lastRuns) {
      const s = at(r.siteId); if (!s) continue;
      const cur = s.pins.runs.last;
      if (!cur || new Date(cur.createdAt) < r.createdAt) {
        s.pins.runs.last = { id: r.id, status: r.status, createdAt: r.createdAt.toISOString(), name: r.name };
        const site = pinSites.find((x) => x.id === r.siteId);
        let settings: unknown = r.settings;
        if (typeof settings === "string") { try { settings = JSON.parse(settings); } catch { settings = null; } }
        try { s.pins.schedule.targetPerDay = runDefaultsFrom(site?.recipe ?? null, settings ?? null).schedule.pinsPerDay; } catch { /* чужие настройки */ }
      }
    }
    for (const r of done) {
      const s = at(r.siteId); if (!s) continue;
      const d = r._max.updatedAt;
      if (d && (!s.pins.runs.lastDoneAt || new Date(s.pins.runs.lastDoneAt) < d)) s.pins.runs.lastDoneAt = d.toISOString();
      touch(s.accessId, d);
    }
    for (const r of items) {
      const s = at(r.siteId); if (!s) continue;
      s.pins.pins.planned += n(r.planned); s.pins.pins.ready += n(r.ready); s.pins.pins.pending += n(r.pending); s.pins.pins.errors += n(r.errors); s.pins.pins.rejected += n(r.rejected);
      if (r.throughAt) {
        const day = dayKey(r.throughAt, TZ);
        if (!s.pins.schedule.throughDay || s.pins.schedule.throughDay < day) s.pins.schedule.throughDay = day;
      }
    }
    for (const r of pages) {
      const s = at(r.siteId); if (!s) continue;
      s.pins.pins.pages += n(r.pages); s.pins.pins.pagesWithError += n(r.pagesWithError);
    }
    for (const r of exportsAgg) {
      const s = at(r.siteId); if (!s) continue;
      s.pins.exports.count += r._count._all; s.pins.exports.rows += r._sum.rows ?? 0;
      const d = r._max.createdAt;
      if (d && (!s.pins.exports.lastAt || new Date(s.pins.exports.lastAt) < d)) s.pins.exports.lastAt = d.toISOString();
      touch(s.accessId, d);
    }
    const uploadedSet = new Set(uploads.map((u) => `${u.pinSiteId}|${u.day}`));
    const seenExport = new Set<string>();
    for (const r of exportDays) {
      const s = at(r.siteId); if (!s) continue;
      const key = `${r.siteId}|${r.day}`;
      if (seenExport.has(key)) continue;
      seenExport.add(key);
      s.pins.exports.days++;
      if (!uploadedSet.has(key)) s.pins.uploads.pendingDays++;
    }
    for (const u of uploads) {
      const s = at(u.pinSiteId); if (!s) continue;
      s.pins.uploads.doneDays++;
      if (!s.pins.uploads.lastDay || s.pins.uploads.lastDay < u.day) s.pins.uploads.lastDay = u.day;
    }
    for (const r of urlCounts) {
      const s = at(r.siteId); if (!s) continue;
      s.pins.urls.withPins += n(r.cnt);
    }
    // Запас по дням: по сайтам одного доступа складываем календари.
    const stockByAccess = new Map<string, number[]>();
    for (const [siteId, counts] of stock.bySite) {
      const accessId = pinToAccess.get(siteId); if (!accessId) continue;
      const arr = stockByAccess.get(accessId) ?? new Array(counts.length).fill(0);
      counts.forEach((c, i) => { arr[i] += c; });
      stockByAccess.set(accessId, arr);
    }
    for (const [accessId, arr] of stockByAccess) { const s = out.get(accessId); if (s) s.pins.schedule.stockRunDays = stockRun(arr); }
    for (const [siteId, f] of future) { const s = at(siteId); if (s) s.pins.schedule.futureReady += f.pins; }
    for (const s of out.values()) {
      const pp = s.pins.pins;
      pp.perPageAvg = pp.pages ? Math.round((pp.planned / pp.pages) * 10) / 10 : null;
      const th = s.pins.schedule.throughDay;
      s.pins.schedule.daysLeft = th && th >= today ? daysBetween(today, th) + 1 : 0;
    }
  }

  // ── Статьи и блог ──
  const fillContent = async (kind: "articles" | "blog") => {
    const ids = kind === "articles" ? A : B;
    if (!ids.length) return;
    const toAccess = kind === "articles" ? artToAccess : blogToAccess;
    const grouper = kind === "articles" ? artGroup : blogGroup;
    const groups = kind === "articles"
      ? await prisma.article.groupBy({ by: ["siteId", "status"], where: { siteId: { in: ids } }, _count: { _all: true }, _sum: { costUsd: true }, _max: { publishedAt: true } })
      : await prisma.blogPost.groupBy({ by: ["siteId", "status"], where: { siteId: { in: ids } }, _count: { _all: true }, _sum: { costUsd: true }, _max: { publishedAt: true } });
    for (const g of groups) {
      const s = out.get(toAccess.get(g.siteId) ?? ""); if (!s) continue;
      const c = s[kind];
      c.total += g._count._all; c.costUsd += g._sum.costUsd ?? 0;
      const grp = grouper(g.status as string);
      c[grp] += g._count._all;
      if (grp === "published" && g._max.publishedAt) {
        if (!c.lastPublishedAt || new Date(c.lastPublishedAt) < g._max.publishedAt) c.lastPublishedAt = g._max.publishedAt.toISOString();
        touch(s.accessId, g._max.publishedAt);
      }
    }
  };
  await Promise.all([fillContent("articles"), fillContent("blog")]);

  // ── Статьи без пинов (только карточка) ──
  if (opts.crossUrls && P.length) {
    const [hist, arts, posts] = await Promise.all([
      prisma.$queryRaw<Array<{ siteId: string; url: string }>>`SELECT DISTINCT siteId, url FROM PinUrlHistory WHERE siteId IN (${Prisma.join(P)})`,
      A.length ? prisma.article.findMany({ where: { siteId: { in: A }, status: "COMPLETED", wpUrl: { not: null } }, select: { siteId: true, wpUrl: true } }) : [],
      B.length ? prisma.blogPost.findMany({ where: { siteId: { in: B }, status: "COMPLETED", wpUrl: { not: null } }, select: { siteId: true, wpUrl: true } }) : [],
    ]);
    const pinned = new Map<string, Set<string>>();
    for (const h of hist) {
      const accessId = pinToAccess.get(h.siteId); if (!accessId) continue;
      const set = pinned.get(accessId) ?? new Set<string>(); set.add(normUrl(h.url)); pinned.set(accessId, set);
    }
    for (const s of out.values()) { s.articles.withoutPins = 0; s.blog.withoutPins = 0; }
    for (const a of arts) { const s = out.get(artToAccess.get(a.siteId) ?? ""); if (s && a.wpUrl && !pinned.get(s.accessId)?.has(normUrl(a.wpUrl))) s.articles.withoutPins!++; }
    for (const p of posts) { const s = out.get(blogToAccess.get(p.siteId) ?? ""); if (s && p.wpUrl && !pinned.get(s.accessId)?.has(normUrl(p.wpUrl))) s.blog.withoutPins!++; }
  }

  for (const s of out.values()) {
    s.cost = { pins: s.pins.runs.costUsd, articles: s.articles.costUsd, blog: s.blog.costUsd, total: s.pins.runs.costUsd + s.articles.costUsd + s.blog.costUsd };
    s.lastActivityAt = iso(lastActivity.get(s.accessId) ?? null);
  }
  return out;
}

/** Срезать деньги из сводки для тех, кому финансы не показываются. */
export function stripFinance(s: ProjectSummary): ProjectSummary {
  return { ...s, pins: { ...s.pins, runs: { ...s.pins.runs, costUsd: 0 } }, articles: { ...s.articles, costUsd: 0 }, blog: { ...s.blog, costUsd: 0 }, cost: { pins: 0, articles: 0, blog: 0, total: 0 } };
}

/** Расход ИИ по месяцам (UTC) через журнал расхода: прогоны пинов, статьи, блог одного сайта. Только для карточки. */
export async function projectCostByMonth(accessId: string): Promise<MonthCost[]> {
  const [pinSites, artSites, blogSites] = await Promise.all([
    prisma.pinSite.findMany({ where: { wpConnectionId: accessId }, select: { id: true } }),
    prisma.artSite.findMany({ where: { accessId }, select: { id: true } }),
    prisma.blogSite.findMany({ where: { accessId }, select: { id: true } }),
  ]);
  type Row = { m: string; kind: string; usd: number | null };
  const parts: Prisma.Sql[] = [];
  if (pinSites.length) parts.push(Prisma.sql`SELECT DATE_FORMAT(u.createdAt, '%Y-%m') AS m, 'pins' AS kind, SUM(u.costUsd) AS usd FROM PinRun r JOIN UsageLog u ON u.refId = r.id WHERE r.siteId IN (${Prisma.join(pinSites.map((s) => s.id))}) GROUP BY m`);
  if (artSites.length) parts.push(Prisma.sql`SELECT DATE_FORMAT(u.createdAt, '%Y-%m') AS m, 'articles' AS kind, SUM(u.costUsd) AS usd FROM Article a JOIN UsageLog u ON u.refId = a.id WHERE a.siteId IN (${Prisma.join(artSites.map((s) => s.id))}) GROUP BY m`);
  if (blogSites.length) parts.push(Prisma.sql`SELECT DATE_FORMAT(u.createdAt, '%Y-%m') AS m, 'blog' AS kind, SUM(u.costUsd) AS usd FROM BlogPost p JOIN UsageLog u ON u.refId = p.id WHERE p.siteId IN (${Prisma.join(blogSites.map((s) => s.id))}) GROUP BY m`);
  if (!parts.length) return [];
  const rows = await prisma.$queryRaw<Row[]>(Prisma.join(parts, " UNION ALL "));
  const map = new Map<string, MonthCost>();
  for (const r of rows) {
    const row = map.get(r.m) ?? { month: r.m, pins: 0, articles: 0, blog: 0, total: 0 };
    const v = Number(r.usd ?? 0);
    if (r.kind === "pins") row.pins += v; else if (r.kind === "articles") row.articles += v; else row.blog += v;
    row.total += v;
    map.set(r.m, row);
  }
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month));
}
