import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, requireUser, type CurrentUser } from "@/lib/auth";
import { canUseTool } from "@/lib/permissions";
import { ANALYTICS } from "./types";

/** Трафик сайтов: обычный инструмент (`Permissions.tools`). Аккаунты Google видит тот, кто их подключил, и админы. */
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

export type SiteRef = { id: string; name: string; host: string | null; url: string | null; timezone: string; groupIds: string[]; lastSyncAt: Date | null; lastSyncError: string | null; backfilling: boolean };
export type GroupRef = { id: string; name: string; color: string; count: number };

/** Подключённые сайты и группы пользователя — основа всех экранов. */
export async function visibleSites(me: CurrentUser): Promise<{ sites: SiteRef[]; groups: GroupRef[] }> {
  const [props, groups] = await Promise.all([
    prisma.gaProperty.findMany({ where: { enabled: true, removed: false, ...propertyWhere(me) }, orderBy: [{ order: "asc" }, { name: "asc" }], include: { groups: { select: { groupId: true } } } }),
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
