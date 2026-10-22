/**
 * Права раздела «Проекты». Видимость проекта = видимость сайта (src/lib/sites/access.ts):
 * сотрудник — свои сайты, лидер — сайты команды, админ — все. Деньги (расход ИИ, траты, доходы) —
 * только главные админы (владелец и те, кому он поставил флаг): правило владельца 2026-10-22.
 */
import type { CurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canAccessSiteAccess, siteAccessWhere, visibleAccessIds } from "@/lib/sites/access";

export { siteAccessWhere, visibleAccessIds };

/** Финансы проекта видят только главные админы. В режиме «Сотрудник» у владельца тоже скрыто. */
export function canSeeFinance(me: CurrentUser): boolean {
  return me.superAdmin;
}

/** Доступ к сайту (и карточке проекта) с загрузкой самого доступа; null — не найден или закрыт. */
export async function loadAccessForUser(me: CurrentUser, accessId: string) {
  const a = await prisma.siteAccess.findUnique({
    where: { id: accessId },
    select: { id: true, name: true, baseUrl: true, teamId: true, linkDomain: true, projects: true, lastCheckOk: true, teams: { select: { teamId: true } }, viewers: { select: { userId: true } } },
  });
  if (!a) return null;
  if (!(await canAccessSiteAccess(me, accessId))) return null;
  return a;
}
