/**
 * Общие выборки для страниц сервиса «Статьи»: воронка по сайтам, состояние воркера, очередь с пагинацией,
 * статьи в работе (живая доска), статистика сайта и прогресс запуска. Страницы остаются тонкими.
 * Всё, что уходит в клиентские компоненты, сериализуемо (даты — ISO-строки).
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { ArtStatus, Prisma } from "@prisma/client";
import { artSiteWhere, articleWhere } from "./access";
import { liveAiRunIds, notHeldByAi } from "./moderation";
import { phaseOf, stageLabel } from "./stages";
import { STATUS_LABELS, type Tone } from "./labels";

/* ───────── Воронка ───────── */

export type FunnelKey = "pending" | "photos" | "photoReview" | "fewPhotos" | "writing" | "articleReview" | "publishing" | "errors" | "stopped";
export type FunnelCounts = Record<FunnelKey, number> & { published24h: number; completed: number; total: number };

export const FUNNEL_COLUMNS: Array<{ key: FunnelKey | "published24h"; label: string; short: string; tone: Tone; statuses: ArtStatus[] }> = [
  { key: "pending", label: "В очереди", short: "очередь", tone: "muted", statuses: ["PENDING"] },
  { key: "photos", label: "Ищем фото", short: "фото", tone: "info", statuses: ["RUNNING"] },
  { key: "photoReview", label: "Модерация фото", short: "модер. фото", tone: "warn", statuses: ["PHOTO_REVIEW"] },
  { key: "fewPhotos", label: "Мало фото", short: "мало фото", tone: "danger", statuses: ["INSUFFICIENT_PHOTOS", "WAITING_FOR_PHOTOS"] },
  { key: "writing", label: "Пишутся", short: "текст", tone: "info", statuses: ["RUNNING"] },
  { key: "articleReview", label: "Модерация статьи", short: "модер. статьи", tone: "warn", statuses: ["REVIEW_PENDING", "NEEDS_REWORK"] },
  { key: "publishing", label: "Публикуются", short: "публикация", tone: "info", statuses: ["PUBLISH_QUEUED", "PUBLISHING"] },
  { key: "errors", label: "Ошибки", short: "ошибки", tone: "danger", statuses: ["FAILED", "PUBLISH_ERROR"] },
  { key: "published24h", label: "Опубликовано за 24 ч", short: "за 24 ч", tone: "ok", statuses: ["COMPLETED"] },
];

export function emptyFunnel(): FunnelCounts {
  return { pending: 0, photos: 0, photoReview: 0, fewPhotos: 0, writing: 0, articleReview: 0, publishing: 0, errors: 0, stopped: 0, published24h: 0, completed: 0, total: 0 };
}

/** В какую колонку воронки попадает статья. RUNNING делится по фазе этапа. */
export function funnelBucket(status: ArtStatus, stage: string): FunnelKey | "completed" {
  switch (status) {
    case "PENDING": return "pending";
    case "RUNNING": {
      const ph = phaseOf(stage);
      return ph === "photos" ? "photos" : ph === "publish" ? "publishing" : "writing";
    }
    case "PHOTO_REVIEW": return "photoReview";
    case "INSUFFICIENT_PHOTOS": case "WAITING_FOR_PHOTOS": return "fewPhotos";
    case "REVIEW_PENDING": case "NEEDS_REWORK": return "articleReview";
    case "PUBLISH_QUEUED": case "PUBLISHING": return "publishing";
    case "FAILED": case "PUBLISH_ERROR": return "errors";
    case "COMPLETED": return "completed";
    default: return "stopped";
  }
}

export type SiteFunnelRow = {
  id: string; name: string; isActive: boolean; nicheCode: string | null; teamName: string; recipeName: string | null; hasAccess: boolean;
  lastAt: string | null; funnel: FunnelCounts;
};

export async function sitesFunnel(me: CurrentUser): Promise<SiteFunnelRow[]> {
  const sites = await prisma.artSite.findMany({
    where: await artSiteWhere(me), orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    include: { team: { select: { name: true } }, defaultRecipe: { select: { name: true } } },
  });
  const ids = sites.map((s) => s.id);
  if (!ids.length) return [];
  const since = new Date(Date.now() - 86_400_000);
  const [groups, pub, last] = await Promise.all([
    prisma.article.groupBy({ by: ["siteId", "status", "stage"], where: { siteId: { in: ids } }, _count: { _all: true } }),
    prisma.article.groupBy({ by: ["siteId"], where: { siteId: { in: ids }, status: "COMPLETED", publishedAt: { gte: since } }, _count: { _all: true } }),
    prisma.article.findMany({ where: { siteId: { in: ids } }, orderBy: { updatedAt: "desc" }, distinct: ["siteId"], select: { siteId: true, updatedAt: true } }),
  ]);
  const map = new Map<string, FunnelCounts>();
  for (const s of sites) map.set(s.id, emptyFunnel());
  for (const g of groups) {
    const f = map.get(g.siteId)!;
    const n = g._count._all;
    f.total += n;
    const b = funnelBucket(g.status, g.stage);
    if (b === "completed") f.completed += n; else f[b] += n;
  }
  for (const p of pub) map.get(p.siteId)!.published24h = p._count._all;
  return sites.map((s) => ({
    id: s.id, name: s.name, isActive: s.isActive, nicheCode: s.nicheCode, teamName: s.team.name, recipeName: s.defaultRecipe?.name ?? null, hasAccess: !!s.accessId,
    lastAt: last.find((l) => l.siteId === s.id)?.updatedAt.toISOString() ?? null, funnel: map.get(s.id)!,
  }));
}

/* ───────── Воркер и сводные счётчики ───────── */

export type WorkerState = {
  /** Статей в статусе «В работе» */
  running: number;
  /** Из них с живой арендой (воркер отвечал недавно) */
  alive: number;
  /** В очереди (PENDING) */
  pending: number;
  /** running > 0 и все аренды истекли — воркер, скорее всего, не запущен */
  stuck: boolean;
};

export async function workerState(me: CurrentUser): Promise<WorkerState> {
  const where = await articleWhere(me);
  const now = new Date();
  const [running, alive, pending] = await Promise.all([
    prisma.article.count({ where: { ...where, status: "RUNNING" } }),
    prisma.article.count({ where: { ...where, status: "RUNNING", leaseUntil: { gt: now } } }),
    prisma.article.count({ where: { ...where, status: "PENDING" } }),
  ]);
  return { running, alive, pending, stuck: running > 0 && alive === 0 };
}

export async function errorsLastHour(siteIds: string[]): Promise<number> {
  if (!siteIds.length) return 0;
  return prisma.artError.count({ where: { siteId: { in: siteIds }, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
}

/**
 * Счётчики модерации (Обзор и меню сервиса), совпадают со списком «Модерации фото»:
 * photos — PHOTO_REVIEW, кроме статей на проверке у идущего запуска ИИ (их людям пока не выдают);
 * insufficient — «Мало фото» отдельно (INSUFFICIENT_PHOTOS / WAITING_FOR_PHOTOS); articles — REVIEW_PENDING + NEEDS_REWORK.
 */
export async function moderationCounts(me: CurrentUser): Promise<{ photos: number; insufficient: number; articles: number }> {
  const where = await articleWhere(me);
  const live = await liveAiRunIds();
  const [photos, insufficient, articles] = await Promise.all([
    prisma.article.count({ where: { ...where, status: "PHOTO_REVIEW", ...notHeldByAi(live) } }),
    prisma.article.count({ where: { ...where, status: { in: ["INSUFFICIENT_PHOTOS", "WAITING_FOR_PHOTOS"] } } }),
    prisma.article.count({ where: { ...where, status: { in: ["REVIEW_PENDING", "NEEDS_REWORK"] } } }),
  ]);
  return { photos, insufficient, articles };
}

/* ───────── Статьи в работе (живая доска и API) ───────── */

export type ArticleBrief = {
  id: string; keyword: string; keywordRu: string; siteId: string; siteName: string; runId: string | null; runName: string | null;
  status: ArtStatus; statusLabel: string; tone: Tone; stage: string; stageLabel: string;
  updatedAt: string; startedAt: string | null; costUsd: number; note: string | null; error: string | null; attempts: number;
  /** Аренда воркера жива (только для RUNNING) */
  leaseAlive: boolean;
};

const BOARD_STATUSES: ArtStatus[] = ["RUNNING", "PUBLISHING", "PUBLISH_QUEUED", "PENDING"];

export async function articlesInWork(me: CurrentUser, limit = 80): Promise<ArticleBrief[]> {
  const where = await articleWhere(me);
  const rows = await prisma.article.findMany({
    where: { ...where, status: { in: BOARD_STATUSES } },
    orderBy: [{ updatedAt: "desc" }], take: limit,
    select: { id: true, keyword: true, keywordRu: true, siteId: true, status: true, stage: true, updatedAt: true, startedAt: true, costUsd: true, note: true, error: true, attempts: true, leaseUntil: true, runId: true, site: { select: { name: true } }, run: { select: { name: true } } },
  });
  const now = Date.now();
  const order = (s: ArtStatus) => (s === "RUNNING" ? 0 : s === "PUBLISHING" ? 1 : s === "PUBLISH_QUEUED" ? 2 : 3);
  return rows
    .map((a) => ({
      id: a.id, keyword: a.keyword, keywordRu: a.keywordRu, siteId: a.siteId, siteName: a.site.name, runId: a.runId, runName: a.run?.name ?? null,
      status: a.status, statusLabel: STATUS_LABELS[a.status].label, tone: STATUS_LABELS[a.status].tone, stage: a.stage, stageLabel: stageLabel(a.stage),
      updatedAt: a.updatedAt.toISOString(), startedAt: a.startedAt?.toISOString() ?? null, costUsd: a.costUsd, note: a.note, error: a.error, attempts: a.attempts,
      leaseAlive: a.status === "RUNNING" && !!a.leaseUntil && a.leaseUntil.getTime() > now,
    }))
    .sort((a, b) => order(a.status) - order(b.status) || b.updatedAt.localeCompare(a.updatedAt));
}

/* ───────── Очередь сайта / статьи запуска ───────── */

export type ArticleRowData = {
  id: string; keyword: string; keywordRu: string; recipeName: string | null; status: ArtStatus; stage: string; moderator: string | null;
  updatedAt: string; createdAt: string; costUsd: number; wpUrl: string | null; runId: string | null; runName: string | null;
  photoReview: boolean; publishMode: string; error: string | null; photoCount: number;
  /** Строка Google Таблицы и состояние обратной записи отчёта (ok | error | null — ещё не писали) */
  sheetRow: number | null; sheetSyncState: string | null; sheetSyncError: string | null;
};

export type QueueFilters = { status?: string; runId?: string; q?: string; page?: number; perPage?: number };
export type QueuePage = { rows: ArticleRowData[]; total: number; page: number; pages: number; perPage: number };

const rowSelect = {
  id: true, keyword: true, keywordRu: true, status: true, stage: true, updatedAt: true, createdAt: true, costUsd: true, wpUrl: true, runId: true,
  photoReview: true, publishMode: true, error: true, photoCount: true, moderatedById: true, reviewedById: true,
  sheetRow: true, sheetSyncState: true, sheetSyncError: true,
  recipeRef: { select: { name: true } }, run: { select: { name: true } },
} satisfies Prisma.ArticleSelect;

type RowSrc = Prisma.ArticleGetPayload<{ select: typeof rowSelect }>;

async function toRows(src: RowSrc[]): Promise<ArticleRowData[]> {
  const userIds = [...new Set(src.flatMap((a) => [a.moderatedById, a.reviewedById]).filter((x): x is string => !!x))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
  const nameOf = (id: string | null) => { if (!id) return null; const u = users.find((x) => x.id === id); return u ? u.name || u.email : "—"; };
  return src.map((a) => ({
    id: a.id, keyword: a.keyword, keywordRu: a.keywordRu, recipeName: a.recipeRef?.name ?? null, status: a.status, stage: a.stage,
    moderator: nameOf(a.reviewedById ?? a.moderatedById), updatedAt: a.updatedAt.toISOString(), createdAt: a.createdAt.toISOString(),
    costUsd: a.costUsd, wpUrl: a.wpUrl, runId: a.runId, runName: a.run?.name ?? null, photoReview: a.photoReview, publishMode: a.publishMode, error: a.error, photoCount: a.photoCount,
    sheetRow: a.sheetRow, sheetSyncState: a.sheetSyncState, sheetSyncError: a.sheetSyncError,
  }));
}

export const STATUS_FILTER_GROUPS: Array<{ value: string; label: string; statuses: ArtStatus[] }> = [
  { value: "active", label: "Все живые", statuses: ["PENDING", "RUNNING", "PHOTO_REVIEW", "INSUFFICIENT_PHOTOS", "WAITING_FOR_PHOTOS", "REVIEW_PENDING", "NEEDS_REWORK", "PUBLISH_QUEUED", "PUBLISHING"] },
  { value: "PENDING", label: "В очереди", statuses: ["PENDING"] },
  { value: "RUNNING", label: "В работе", statuses: ["RUNNING"] },
  { value: "PHOTO_REVIEW", label: "Модерация фото", statuses: ["PHOTO_REVIEW"] },
  { value: "fewPhotos", label: "Мало фото", statuses: ["INSUFFICIENT_PHOTOS", "WAITING_FOR_PHOTOS"] },
  { value: "REVIEW_PENDING", label: "Модерация статьи", statuses: ["REVIEW_PENDING", "NEEDS_REWORK"] },
  { value: "publishing", label: "Публикуются", statuses: ["PUBLISH_QUEUED", "PUBLISHING"] },
  { value: "COMPLETED", label: "Опубликованы", statuses: ["COMPLETED"] },
  { value: "errors", label: "Ошибки", statuses: ["FAILED", "PUBLISH_ERROR"] },
  { value: "stopped", label: "Остановлены / пауза", statuses: ["STOPPED", "PAUSED"] },
];

export function statusesForFilter(value: string | undefined): ArtStatus[] | null {
  if (!value) return null;
  const g = STATUS_FILTER_GROUPS.find((x) => x.value === value);
  if (g) return g.statuses;
  return value in STATUS_LABELS ? [value as ArtStatus] : null;
}

export async function queuePage(siteId: string, f: QueueFilters): Promise<QueuePage> {
  const perPage = Math.min(200, Math.max(10, f.perPage ?? 50));
  const page = Math.max(1, f.page ?? 1);
  const statuses = statusesForFilter(f.status);
  const where: Prisma.ArticleWhereInput = {
    siteId,
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(f.runId ? { runId: f.runId } : {}),
    ...(f.q?.trim() ? { OR: [{ keyword: { contains: f.q.trim() } }, { keywordRu: { contains: f.q.trim() } }, { slug: { contains: f.q.trim() } }] } : {}),
  };
  const [total, src] = await Promise.all([
    prisma.article.count({ where }),
    prisma.article.findMany({ where, orderBy: [{ updatedAt: "desc" }], skip: (page - 1) * perPage, take: perPage, select: rowSelect }),
  ]);
  return { rows: await toRows(src), total, page, pages: Math.max(1, Math.ceil(total / perPage)), perPage };
}

export async function runArticles(runId: string): Promise<ArticleRowData[]> {
  const src = await prisma.article.findMany({ where: { runId }, orderBy: [{ createdAt: "asc" }], select: rowSelect });
  return toRows(src);
}

/** Запуски сайта для фильтра очереди. */
export async function siteRuns(siteId: string, take = 30) {
  return prisma.artRun.findMany({ where: { siteId }, orderBy: { createdAt: "desc" }, take, select: { id: true, name: true, createdAt: true, _count: { select: { articles: true } } } });
}

/* ───────── Прогресс запуска ───────── */

export type RunProgress = { total: number; byStatus: Array<{ status: ArtStatus; count: number }>; completed: number; errors: number; waiting: number; live: number; costUsd: number };

export async function runProgress(runId: string): Promise<RunProgress> {
  const [groups, cost] = await Promise.all([
    prisma.article.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } }),
    prisma.article.aggregate({ where: { runId }, _sum: { costUsd: true } }),
  ]);
  const byStatus = groups.map((g) => ({ status: g.status, count: g._count._all })).sort((a, b) => b.count - a.count);
  const n = (list: ArtStatus[]) => byStatus.filter((x) => list.includes(x.status)).reduce((s, x) => s + x.count, 0);
  return {
    total: byStatus.reduce((s, x) => s + x.count, 0), byStatus,
    completed: n(["COMPLETED"]), errors: n(["FAILED", "PUBLISH_ERROR"]), waiting: n(["PHOTO_REVIEW", "INSUFFICIENT_PHOTOS", "WAITING_FOR_PHOTOS", "REVIEW_PENDING", "NEEDS_REWORK"]),
    live: n(["PENDING", "RUNNING", "PUBLISH_QUEUED", "PUBLISHING"]), costUsd: cost._sum.costUsd ?? 0,
  };
}

/* ───────── Статистика сайта ───────── */

export type SiteStats = {
  days: Array<{ day: string; count: number }>;
  completed: number; avgCost: number | null; totalCost: number; completed30: number;
};

/** Публикации по дням и средняя цена опубликованной. Ошибки сайта — errorsSummary (errorsView.ts), расходы — costBreakdown (costs.ts). */
export async function siteStats(siteId: string, days = 30): Promise<SiteStats> {
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
  const [published, agg] = await Promise.all([
    prisma.article.findMany({ where: { siteId, status: "COMPLETED", publishedAt: { gte: since } }, select: { publishedAt: true } }),
    prisma.article.aggregate({ where: { siteId, status: "COMPLETED" }, _count: { _all: true }, _avg: { costUsd: true }, _sum: { costUsd: true } }),
  ]);
  const byDay = new Map<string, number>();
  for (let i = 0; i < days; i++) { const d = new Date(since); d.setDate(since.getDate() + i); byDay.set(d.toISOString().slice(0, 10), 0); }
  for (const p of published) { if (!p.publishedAt) continue; const k = p.publishedAt.toISOString().slice(0, 10); byDay.set(k, (byDay.get(k) ?? 0) + 1); }
  return {
    days: [...byDay.entries()].map(([day, count]) => ({ day, count })),
    completed: agg._count._all, avgCost: agg._avg.costUsd, totalCost: agg._sum.costUsd ?? 0, completed30: published.length,
  };
}

/* ───────── Карточка статьи ───────── */

export async function articleUsage(articleId: string) {
  return prisma.usageLog.findMany({
    where: { refId: articleId }, orderBy: { createdAt: "desc" }, take: 300,
    select: { id: true, createdAt: true, ok: true, error: true, costUsd: true, inputTokens: true, outputTokens: true, durationMs: true, provider: { select: { name: true } }, model: { select: { name: true, modelId: true } }, slot: { select: { key: true, name: true } } },
  });
}
