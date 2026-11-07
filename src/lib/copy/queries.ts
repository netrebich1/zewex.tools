/**
 * Article Copy: данные экранов (дашборд запаса, настройки, карточка ядра). Видимость — по командам человека,
 * администратор видит все команды.
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { artSiteWhere } from "@/lib/articles/access";
import { copySettings, type CoreForm } from "./build";
import { SHARED_TEAM, groupOf } from "./keys";

export async function visibleTeams(me: CurrentUser): Promise<Array<{ id: string; name: string }>> {
  return prisma.team.findMany({ where: me.role === "ADMIN" ? {} : { id: { in: me.teamIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

export type CopyFilters = { team?: string; niche?: string; q?: string; only?: string };

export async function dashboardData(me: CurrentUser, f: CopyFilters) {
  const [teams, settings] = await Promise.all([visibleTeams(me), copySettings()]);
  const teamIds = teams.map((t) => t.id);
  const scope = f.team && teamIds.includes(f.team) ? [f.team] : teamIds;
  // Общий банк: карта одна на всех (teamId = SHARED_TEAM), фильтр по команде не действует.
  const base: Prisma.CopyCoreWhereInput = settings.sharedBank ? { teamId: SHARED_TEAM } : { teamId: { in: scope } };
  const where: Prisma.CopyCoreWhereInput = { ...base };
  if (f.niche) where.niche = f.niche;
  if (f.q) where.core = { contains: f.q.trim().toLowerCase() };
  if (f.only === "ready") where.capacity = { gt: 0 };
  if (f.only === "nosites") { where.byPhotos = { gt: 0 }; where.freeSites = 0; }
  const [summary, cores, total, sites] = await Promise.all([
    prisma.copyCore.groupBy({ by: ["teamId", "niche"], where: base, _count: { _all: true }, _sum: { articles: true, byPhotos: true, capacity: true, photosPublished: true, photosReserve: true } }),
    prisma.copyCore.findMany({ where, orderBy: [{ capacity: "desc" }, { byPhotos: "desc" }, { articles: "desc" }, { core: "asc" }], take: 300, select: { id: true, teamId: true, niche: true, core: true, articles: true, freeModifiers: true, usedModifiers: true, photosPublished: true, photosReserve: true, byPhotos: true, freeSites: true, capacity: true } }),
    prisma.copyCore.count({ where }),
    prisma.copySite.findMany({ where: { ...(settings.sharedBank ? {} : { teamId: { in: scope } }), publish: true }, select: { artSiteId: true, teamId: true } }),
  ]);
  const siteRows = await prisma.artSite.findMany({ where: { id: { in: sites.map((s) => s.artSiteId) }, isActive: true }, select: { id: true, teamId: true, nicheCode: true } });
  const sitesBy = new Map<string, number>();
  for (const s of siteRows) { const k = `${settings.sharedBank ? SHARED_TEAM : s.teamId}|${groupOf(s.nicheCode)}`; sitesBy.set(k, (sitesBy.get(k) ?? 0) + 1); }
  const teamName = new Map<string, string>([...teams.map((t) => [t.id, t.name] as [string, string]), [SHARED_TEAM, "Все команды"]]);
  const rows = summary
    .map((s) => ({
      teamId: s.teamId, team: teamName.get(s.teamId) ?? "—", niche: s.niche, cores: s._count._all, articles: s._sum.articles ?? 0, byPhotos: s._sum.byPhotos ?? 0,
      capacity: s._sum.capacity ?? 0, photosPublished: s._sum.photosPublished ?? 0, photosReserve: s._sum.photosReserve ?? 0, sites: sitesBy.get(`${s.teamId}|${groupOf(s.niche)}`) ?? 0,
    }))
    .sort((a, b) => a.team.localeCompare(b.team) || b.byPhotos - a.byPhotos);
  const niches = [...new Set(summary.map((s) => s.niche))].sort();
  return { teams, settings, summary: rows, niches, cores: cores.map((c) => ({ ...c, team: teamName.get(c.teamId) ?? "—", usedModifiers: (c.usedModifiers as string[] | null) ?? [] })), total, boundSites: siteRows.length };
}

export async function settingsData(me: CurrentUser) {
  const [settings, sites, bound] = await Promise.all([
    copySettings(),
    prisma.artSite.findMany({ where: { ...(await artSiteWhere(me)), isActive: true }, select: { id: true, name: true, teamId: true, nicheCode: true, team: { select: { name: true } }, _count: { select: { articles: true } } }, orderBy: [{ teamId: "asc" }, { name: "asc" }] }),
    prisma.copySite.findMany({ select: { artSiteId: true, publish: true } }),
  ]);
  const on = new Set(bound.filter((b) => b.publish).map((b) => b.artSiteId));
  return { settings, sites: sites.map((s) => ({ id: s.id, name: s.name, team: s.team.name, grp: groupOf(s.nicheCode), articles: s._count.articles, bound: on.has(s.id) })) };
}

/** Собранные статьи: последние 300 с состоянием в конвейере статей, счётчики за сегодня и итог автосборки. */
export async function articlesData(me: CurrentUser) {
  const [teams, settings] = await Promise.all([visibleTeams(me), copySettings()]);
  const teamIds = teams.map((t) => t.id);
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const [rows, total, today] = await Promise.all([
    prisma.copyArticle.findMany({ where: { teamId: { in: teamIds } }, orderBy: { createdAt: "desc" }, take: 300 }),
    prisma.copyArticle.count({ where: { teamId: { in: teamIds } } }),
    prisma.copyArticle.count({ where: { teamId: { in: teamIds }, createdAt: { gte: since } } }),
  ]);
  const [arts, sites] = await Promise.all([
    prisma.article.findMany({ where: { id: { in: rows.map((r) => r.articleId) } }, select: { id: true, status: true, stage: true, wpUrl: true, costUsd: true, error: true } }),
    prisma.artSite.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.siteId))] } }, select: { id: true, name: true } }),
  ]);
  const art = new Map(arts.map((a) => [a.id, a]));
  const site = new Map(sites.map((s) => [s.id, s.name]));
  const published = await prisma.article.count({ where: { id: { in: rows.map((r) => r.articleId) }, status: "COMPLETED" } });
  return { settings, total, today, published, rows: rows.map((r) => ({ ...r, site: site.get(r.siteId) ?? "—", art: art.get(r.articleId) ?? null })) };
}

export async function coreData(me: CurrentUser, id: string) {
  const core = await prisma.copyCore.findUnique({ where: { id } });
  const shared = core?.teamId === SHARED_TEAM;
  if (!core || (!shared && me.role !== "ADMIN" && !me.teamIds.includes(core.teamId))) return null;
  const forms = (core.formulations as CoreForm[] | null) ?? [];
  const teamWhere = shared ? {} : { teamId: core.teamId };
  const [sites, team, bound] = await Promise.all([
    prisma.artSite.findMany({ where: { ...teamWhere, isActive: true }, select: { id: true, name: true, nicheCode: true } }),
    shared ? Promise.resolve({ name: "Все команды" }) : prisma.team.findUnique({ where: { id: core.teamId }, select: { name: true } }),
    prisma.copySite.findMany({ where: { ...teamWhere, publish: true }, select: { artSiteId: true } }),
  ]);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const has = new Set((core.siteIds as string[] | null) ?? []);
  const boundIds = new Set(bound.map((b) => b.artSiteId));
  const free = sites.filter((s) => boundIds.has(s.id) && groupOf(s.nicheCode) === core.grp && !has.has(s.id)).map((s) => s.name);
  return { core, team: team?.name ?? "—", forms: forms.map((f) => ({ ...f, site: siteName.get(f.s) ?? "—" })), freeSiteNames: free, usedModifiers: (core.usedModifiers as string[] | null) ?? [] };
}
