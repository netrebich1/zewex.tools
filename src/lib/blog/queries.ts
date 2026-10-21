/**
 * Выборки для страниц сервиса инфо-статей: воронка по сайтам, состояние воркера, очередь с пагинацией,
 * посты в работе, прогресс запуска, очередь проверки, расход поста. Всё для клиента сериализуемо (даты — ISO).
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { BlogStatus, Prisma } from "@prisma/client";
import { blogPostWhere, blogSiteWhere } from "./access";
import { stageLabel } from "./stages";
import type { Tone } from "./labels";

export type FunnelKey = "pending" | "running" | "review" | "publishing" | "errors" | "stopped";
export type FunnelCounts = Record<FunnelKey, number> & { published24h: number; completed: number; total: number };

export const FUNNEL_COLUMNS: Array<{ key: FunnelKey | "published24h"; label: string; short: string; tone: Tone; filter: string }> = [
  { key: "pending", label: "В очереди", short: "очередь", tone: "muted", filter: "PENDING" },
  { key: "running", label: "В работе", short: "работа", tone: "info", filter: "RUNNING" },
  { key: "review", label: "На проверке", short: "проверка", tone: "warn", filter: "review" },
  { key: "publishing", label: "Публикуются", short: "публикация", tone: "info", filter: "PUBLISHING" },
  { key: "errors", label: "Ошибки", short: "ошибки", tone: "danger", filter: "errors" },
  { key: "published24h", label: "Опубликовано за 24 ч", short: "за 24 ч", tone: "ok", filter: "COMPLETED" },
];

export function emptyFunnel(): FunnelCounts {
  return { pending: 0, running: 0, review: 0, publishing: 0, errors: 0, stopped: 0, published24h: 0, completed: 0, total: 0 };
}

export function funnelBucket(status: BlogStatus): FunnelKey | "completed" {
  switch (status) {
    case "PENDING": return "pending";
    case "RUNNING": return "running";
    case "REVIEW_PENDING": case "NEEDS_REWORK": return "review";
    case "PUBLISHING": return "publishing";
    case "FAILED": case "PUBLISH_ERROR": return "errors";
    case "COMPLETED": return "completed";
    default: return "stopped";
  }
}

export type SiteFunnelRow = { id: string; name: string; isActive: boolean; teamName: string; recipeName: string | null; hasAccess: boolean; lastAt: string | null; funnel: FunnelCounts };

export async function sitesFunnel(me: CurrentUser): Promise<SiteFunnelRow[]> {
  const sites = await prisma.blogSite.findMany({ where: await blogSiteWhere(me), orderBy: [{ isActive: "desc" }, { name: "asc" }], include: { defaultRecipe: { select: { name: true } } } });
  const ids = sites.map((s) => s.id);
  if (!ids.length) return [];
  const teams = await prisma.team.findMany({ where: { id: { in: [...new Set(sites.map((s) => s.teamId))] } }, select: { id: true, name: true } });
  const since = new Date(Date.now() - 86_400_000);
  const [groups, pub, last] = await Promise.all([
    prisma.blogPost.groupBy({ by: ["siteId", "status"], where: { siteId: { in: ids } }, _count: { _all: true } }),
    prisma.blogPost.groupBy({ by: ["siteId"], where: { siteId: { in: ids }, status: "COMPLETED", publishedAt: { gte: since } }, _count: { _all: true } }),
    prisma.blogPost.findMany({ where: { siteId: { in: ids } }, orderBy: { updatedAt: "desc" }, distinct: ["siteId"], select: { siteId: true, updatedAt: true } }),
  ]);
  const map = new Map<string, FunnelCounts>();
  for (const s of sites) map.set(s.id, emptyFunnel());
  for (const g of groups) {
    const f = map.get(g.siteId)!;
    f.total += g._count._all;
    const b = funnelBucket(g.status);
    if (b === "completed") f.completed += g._count._all; else f[b] += g._count._all;
  }
  for (const p of pub) map.get(p.siteId)!.published24h = p._count._all;
  const lastAt = new Map(last.map((l) => [l.siteId, l.updatedAt.toISOString()]));
  return sites.map((s) => ({ id: s.id, name: s.name, isActive: s.isActive, teamName: teams.find((t) => t.id === s.teamId)?.name ?? "—", recipeName: s.defaultRecipe?.name ?? null, hasAccess: !!s.accessId, lastAt: lastAt.get(s.id) ?? null, funnel: map.get(s.id)! }));
}

export type WorkerState = { running: number; pending: number; waiting: number; workerCap: number; master: boolean; maxConcurrent: number; alive: boolean };

export async function workerState(me: CurrentUser): Promise<WorkerState> {
  const where = await blogPostWhere(me);
  const [running, pending, waiting, settings, lease] = await Promise.all([
    prisma.blogPost.count({ where: { ...where, status: "RUNNING" } }),
    prisma.blogPost.count({ where: { ...where, status: "PENDING" } }),
    prisma.blogPost.count({ where: { ...where, status: { in: ["REVIEW_PENDING", "NEEDS_REWORK"] } } }),
    prisma.blogSettings.findUnique({ where: { id: "main" } }),
    prisma.blogPost.findFirst({ where: { status: "RUNNING", leaseUntil: { gt: new Date() } }, select: { id: true } }),
  ]);
  return { running, pending, waiting, workerCap: settings?.workerCap ?? 0, master: settings?.master ?? true, maxConcurrent: settings?.maxConcurrent ?? 0, alive: !!lease || running === 0 };
}

export type PostRowData = {
  id: string; keyword: string; status: BlogStatus; stage: string; stageLabel: string; error: string | null; note: string | null;
  recipeName: string | null; runId: string | null; runName: string | null; siteId: string; siteName: string;
  wordCount: number; photos: number; costUsd: number; wpUrl: string | null; updatedAt: string; createdAt: string;
};

const ROW_INCLUDE = { site: { select: { name: true } }, run: { select: { name: true } }, recipeRef: { select: { name: true } }, _count: { select: { photos: true } } } as const;
type RowWithRel = Prisma.BlogPostGetPayload<{ include: typeof ROW_INCLUDE }>;

function toRow(p: RowWithRel): PostRowData {
  return {
    id: p.id, keyword: p.keyword, status: p.status, stage: p.stage, stageLabel: stageLabel(p.stage), error: p.error, note: p.note,
    recipeName: p.recipeRef?.name ?? null, runId: p.runId, runName: p.run?.name ?? null, siteId: p.siteId, siteName: p.site.name,
    wordCount: p.wordCount, photos: p._count.photos, costUsd: p.costUsd, wpUrl: p.wpUrl, updatedAt: p.updatedAt.toISOString(), createdAt: p.createdAt.toISOString(),
  };
}

export const STATUS_FILTER_GROUPS: Array<{ value: string; label: string; statuses: BlogStatus[] }> = [
  { value: "PENDING", label: "В очереди", statuses: ["PENDING"] },
  { value: "RUNNING", label: "В работе", statuses: ["RUNNING"] },
  { value: "review", label: "На проверке / в доработку", statuses: ["REVIEW_PENDING", "NEEDS_REWORK"] },
  { value: "PUBLISHING", label: "Публикуются", statuses: ["PUBLISHING"] },
  { value: "COMPLETED", label: "Опубликованы", statuses: ["COMPLETED"] },
  { value: "errors", label: "Ошибки", statuses: ["FAILED", "PUBLISH_ERROR"] },
  { value: "STOPPED", label: "Остановлены", statuses: ["STOPPED"] },
];

export function statusesForFilter(value: string | undefined): BlogStatus[] | null {
  if (!value) return null;
  return STATUS_FILTER_GROUPS.find((g) => g.value === value)?.statuses ?? null;
}

export type QueueFilters = { status?: string; runId?: string; q?: string; page?: number; perPage?: number };
export type QueuePage = { rows: PostRowData[]; total: number; page: number; pages: number; perPage: number };

export async function queuePage(siteId: string, f: QueueFilters): Promise<QueuePage> {
  const perPage = Math.min(200, Math.max(10, f.perPage ?? 50));
  const page = Math.max(1, f.page ?? 1);
  const statuses = statusesForFilter(f.status);
  const where: Prisma.BlogPostWhereInput = {
    siteId,
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(f.runId ? { runId: f.runId } : {}),
    ...(f.q ? { OR: [{ keyword: { contains: f.q } }, { slug: { contains: f.q } }, { h1: { contains: f.q } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.blogPost.count({ where }),
    prisma.blogPost.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (page - 1) * perPage, take: perPage, include: ROW_INCLUDE }),
  ]);
  return { rows: rows.map(toRow), total, page, pages: Math.max(1, Math.ceil(total / perPage)), perPage };
}

export async function runPosts(runId: string): Promise<PostRowData[]> {
  const rows = await prisma.blogPost.findMany({ where: { runId }, orderBy: { createdAt: "asc" }, include: ROW_INCLUDE });
  return rows.map(toRow);
}

export async function postsInWork(me: CurrentUser, limit = 60): Promise<PostRowData[]> {
  const where = await blogPostWhere(me);
  const rows = await prisma.blogPost.findMany({ where: { ...where, status: { in: ["RUNNING", "PUBLISHING", "PENDING"] } }, orderBy: [{ status: "asc" }, { updatedAt: "desc" }], take: limit, include: ROW_INCLUDE });
  return rows.map(toRow);
}

export async function reviewQueue(me: CurrentUser, limit = 200): Promise<PostRowData[]> {
  const where = await blogPostWhere(me);
  const rows = await prisma.blogPost.findMany({ where: { ...where, status: { in: ["REVIEW_PENDING", "NEEDS_REWORK"] } }, orderBy: { updatedAt: "asc" }, take: limit, include: ROW_INCLUDE });
  return rows.map(toRow);
}

export async function siteRuns(siteId: string, take = 30) {
  return prisma.blogRun.findMany({ where: { siteId }, orderBy: { createdAt: "desc" }, take, select: { id: true, name: true, createdAt: true, _count: { select: { posts: true } } } });
}

export type RunProgress = { total: number; byStatus: Array<{ status: BlogStatus; count: number }>; completed: number; errors: number; waiting: number; live: number; costUsd: number };

export async function runProgress(runId: string): Promise<RunProgress> {
  const [groups, cost] = await Promise.all([
    prisma.blogPost.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } }),
    prisma.blogPost.aggregate({ where: { runId }, _sum: { costUsd: true } }),
  ]);
  const byStatus = groups.map((g) => ({ status: g.status, count: g._count._all }));
  const n = (list: BlogStatus[]) => byStatus.filter((b) => list.includes(b.status)).reduce((s, b) => s + b.count, 0);
  return { total: byStatus.reduce((s, b) => s + b.count, 0), byStatus, completed: n(["COMPLETED"]), errors: n(["FAILED", "PUBLISH_ERROR"]), waiting: n(["REVIEW_PENDING", "NEEDS_REWORK"]), live: n(["PENDING", "RUNNING", "PUBLISHING"]), costUsd: cost._sum.costUsd ?? 0 };
}

export async function postUsage(postId: string) {
  return prisma.usageLog.findMany({
    where: { refId: postId }, orderBy: { createdAt: "desc" }, take: 300,
    select: { id: true, createdAt: true, ok: true, error: true, costUsd: true, inputTokens: true, outputTokens: true, durationMs: true, provider: { select: { name: true } }, model: { select: { name: true, modelId: true } }, slot: { select: { key: true, name: true } } },
  });
}

export async function errorsLastHour(siteIds: string[]): Promise<number> {
  if (!siteIds.length) return 0;
  return prisma.blogError.count({ where: { siteId: { in: siteIds }, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
}
