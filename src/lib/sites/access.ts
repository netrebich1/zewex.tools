/**
 * Кто видит какой сайт. Уровень системы: доступ к сайту (SiteAccess) принадлежит команде-владельцу,
 * может быть открыт ещё нескольким командам и ограничен списком сотрудников.
 * Сайт сервиса (PinSite) наследует видимость своего доступа; сайты без доступа — по команде.
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { Prisma } from "@prisma/client";

type AccessRow = { id: string; teamId: string; teams: { teamId: string }[]; viewers: { userId: string }[] };

/** Видит ли пользователь доступ: админ — всё; иначе одна из его команд + (список сотрудников пуст, или он в нём, или он лидер команды-владельца). */
export function canSeeAccess(me: CurrentUser, a: Omit<AccessRow, "id">): boolean {
  if (me.role === "ADMIN") return true;
  const inTeam = me.teamIds.includes(a.teamId) || a.teams.some((t) => me.teamIds.includes(t.teamId));
  if (!inTeam) return false;
  if (!a.viewers.length) return true;
  return a.viewers.some((v) => v.userId === me.id) || me.leadTeamIds.includes(a.teamId);
}

/** Id доступов, видимых пользователю; null — все (админ). */
export async function visibleAccessIds(me: CurrentUser): Promise<string[] | null> {
  if (me.role === "ADMIN") return null;
  if (!me.teamIds.length) return [];
  const rows = await prisma.siteAccess.findMany({
    where: { OR: [{ teamId: { in: me.teamIds } }, { teams: { some: { teamId: { in: me.teamIds } } } }] },
    select: { id: true, teamId: true, teams: { select: { teamId: true } }, viewers: { select: { userId: true } } },
  });
  return rows.filter((r) => canSeeAccess(me, r)).map((r) => r.id);
}

/** Условие для SiteAccess.findMany. */
export async function siteAccessWhere(me: CurrentUser): Promise<Prisma.SiteAccessWhereInput> {
  const ids = await visibleAccessIds(me);
  return ids === null ? {} : { id: { in: ids } };
}

/** Условие для PinSite.findMany: сайты видимых доступов плюс сайты без доступа из своих команд. */
export async function pinSiteWhere(me: CurrentUser): Promise<Prisma.PinSiteWhereInput> {
  const ids = await visibleAccessIds(me);
  if (ids === null) return {};
  return { OR: [{ wpConnectionId: { in: ids } }, { wpConnectionId: null, teamId: { in: me.teamIds } }] };
}

/** Условие для PinRun.findMany: прогоны видимых сайтов плюс прогоны без сайта из своих команд. */
export async function pinRunWhere(me: CurrentUser): Promise<Prisma.PinRunWhereInput> {
  const ids = await visibleAccessIds(me);
  if (ids === null) return {};
  return { OR: [{ site: { OR: [{ wpConnectionId: { in: ids } }, { wpConnectionId: null, teamId: { in: me.teamIds } }] } }, { siteId: null, teamId: { in: me.teamIds } }] };
}

export async function canAccessSiteAccess(me: CurrentUser, accessId: string): Promise<boolean> {
  if (me.role === "ADMIN") return true;
  const a = await prisma.siteAccess.findUnique({ where: { id: accessId }, select: { teamId: true, teams: { select: { teamId: true } }, viewers: { select: { userId: true } } } });
  return !!a && canSeeAccess(me, a);
}

/** Доступ к сайту сервиса: через его доступ WordPress, а без него — по команде. */
export async function canAccessPinSite(me: CurrentUser, site: { teamId: string; wpConnectionId: string | null }): Promise<boolean> {
  if (me.role === "ADMIN") return true;
  if (site.wpConnectionId) {
    const ok = await canAccessSiteAccess(me, site.wpConnectionId);
    // Доступ удалён/недоступен, но сайт в своей команде — пусть остаётся виден команде.
    if (ok) return true;
  }
  return !site.wpConnectionId && me.teamIds.includes(site.teamId);
}

/** Прогон виден, если виден его сайт; прогон без сайта — по команде. */
export async function canAccessRun(me: CurrentUser, run: { teamId: string; site: { teamId: string; wpConnectionId: string | null } | null }): Promise<boolean> {
  if (me.role === "ADMIN") return true;
  if (run.site) return canAccessPinSite(me, run.site);
  return me.teamIds.includes(run.teamId);
}

/** Команды, которым доступен сайт (владелец первым). */
export function accessTeamIds(a: { teamId: string; teams: { teamId: string }[] }): string[] {
  return [a.teamId, ...a.teams.map((t) => t.teamId).filter((t) => t !== a.teamId)];
}
