import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, requireUser, type CurrentUser } from "@/lib/auth";
import { canUseTool } from "@/lib/permissions";
import { ANALYTICS } from "./types";

/**
 * Трафик сайтов: обычный инструмент (`Permissions.tools`). Аккаунты Google настраивает тот, кто их подключил, и админы.
 * Смотреть (обзор, страницы, сайт, выгрузка, «сейчас на сайте») лидер команды может и сайты сотрудников своей команды.
 */
export async function requireAnalytics(): Promise<CurrentUser> {
  const me = await requireUser();
  if (!canUseTool(me, ANALYTICS)) redirect("/?denied=1");
  return me;
}

export async function analyticsUser(): Promise<CurrentUser | null> {
  const me = await getCurrentUser();
  return me && canUseTool(me, ANALYTICS) ? me : null;
}

export const accountWhere = (me: CurrentUser) => (me.role === "ADMIN" ? {} : { userId: me.id });
export const propertyWhere = (me: CurrentUser) => (me.role === "ADMIN" ? {} : { account: { userId: me.id } });
export const groupWhere = (me: CurrentUser) => (me.role === "ADMIN" ? {} : { userId: me.id });

/**
 * Чьи подключённые сайты пользователь видит (только просмотр): свои, а лидеру — ещё сотрудников команд, где он лидер.
 * Аккаунты админов в это не входят: это аккаунты портала, а не команды. null — все (админ).
 */
async function viewerUserIds(me: CurrentUser): Promise<string[] | null> {
  if (me.role === "ADMIN") return null;
  if (!me.leadTeamIds.length) return [me.id];
  const team = await prisma.teamMember.findMany({ where: { teamId: { in: me.leadTeamIds }, user: { role: "MEMBER" } }, select: { userId: true } });
  return [...new Set([me.id, ...team.map((m) => m.userId)])];
}

/** Условие на GaProperty для экранов просмотра. Менять чужие сайты нельзя: действия идут через `propertyWhere`. */
export async function propertyViewWhere(me: CurrentUser) {
  const ids = await viewerUserIds(me);
  return ids === null ? {} : { account: { userId: { in: ids } } };
}

export type SiteRef = { id: string; name: string; host: string | null; url: string | null; timezone: string; groupIds: string[]; lastSyncAt: Date | null; lastSyncError: string | null; backfilling: boolean };
export type GroupRef = { id: string; name: string; color: string; count: number };

/** Подключённые сайты и группы пользователя — основа всех экранов. */
export async function visibleSites(me: CurrentUser): Promise<{ sites: SiteRef[]; groups: GroupRef[] }> {
  const [props, groups] = await Promise.all([
    prisma.gaProperty.findMany({ where: { enabled: true, removed: false, ...(await propertyViewWhere(me)) }, orderBy: [{ order: "asc" }, { name: "asc" }], include: { groups: { select: { groupId: true } } } }),
    prisma.gaGroup.findMany({ where: groupWhere(me), orderBy: [{ order: "asc" }, { name: "asc" }], include: { _count: { select: { properties: true } } } }),
  ]);
  return {
    sites: props.map((p) => ({ id: p.id, name: p.name, host: p.host, url: p.url, timezone: p.timezone, groupIds: p.groups.map((g) => g.groupId), lastSyncAt: p.lastSyncAt, lastSyncError: p.lastSyncError, backfilling: isBackfilling(p.syncState) })),
    groups: groups.map((g) => ({ id: g.id, name: g.name, color: g.color, count: g._count.properties })),
  };
}

/** Первичная загрузка истории ещё идёт (страницы грузятся порциями по несколько дней). */
export function isBackfilling(state: unknown): boolean {
  return !(state as { done?: boolean } | null)?.done;
}
