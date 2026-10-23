/** Сайты и «пользователь без сессии» для крона и API агента: без импортов next/* (файл нужен воркеру). */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { resolvePermissions } from "@/lib/permissions";
import { pinSiteWhere } from "@/lib/sites/access";

export type SiteRow = { id: string; name: string; teamId: string; wpConnectionId: string | null };

/** Активные сайты пинов, которые видит этот человек. */
export async function visiblePinSites(me: CurrentUser): Promise<SiteRow[]> {
  return prisma.pinSite.findMany({ where: { ...(await pinSiteWhere(me)), isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, teamId: true, wpConnectionId: true } });
}

/**
 * «Пользователь» для крона и API агента без сессии: команды и права из базы, без активной команды и режимов главного админа.
 * Нужен для проверок видимости сайтов (`pinSiteWhere`) от имени владельца агента.
 */
export async function userAsCurrent(userId: string): Promise<CurrentUser | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { memberships: { select: { teamId: true, role: true, team: { select: { name: true } } } } },
  });
  if (!u || !u.isActive) return null;
  const teams = u.memberships.map((m) => ({ id: m.teamId, name: m.team.name, lead: m.role === "LEAD" }));
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    teamIds: teams.map((t) => t.id), leadTeamIds: teams.filter((t) => t.lead).map((t) => t.id), teams, activeTeamId: null,
    perms: resolvePermissions(u.role, u.permissions),
    superAdmin: false, memberView: false, impersonator: null, privateTools: [],
  };
}
