import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";

/**
 * Видимость проектов модуля: админ — все; сотрудник — проекты своих команд (команда проекта = команда расхода).
 * Настройки проекта (источники, сущности, бюджет, бот) меняют админ и лидер команды проекта.
 */

export function projectWhere(me: CurrentUser) {
  return me.role === "ADMIN" ? {} : { teamId: { in: me.teamIds } };
}

export async function visibleProjects(me: CurrentUser) {
  // Рейтинг просмотров (сотни КБ) нужен только странице «Просмотры» — она читает его сама.
  return prisma.newsProject.findMany({ where: projectWhere(me), orderBy: { createdAt: "asc" }, omit: { viewsReport: true } });
}

export async function requireProject(me: CurrentUser, id: string | null | undefined) {
  const list = await visibleProjects(me);
  const p = (id && list.find((x) => x.id === id)) || list[0];
  return { project: p ?? null, list };
}

export function canManageProject(me: CurrentUser, p: { teamId: string }): boolean {
  return me.role === "ADMIN" || me.leadTeamIds.includes(p.teamId);
}

export async function loadProjectFor(me: CurrentUser, id: string, manage = false) {
  const p = await prisma.newsProject.findUnique({ where: { id } });
  if (!p) throw new Error("Проект не найден");
  if (me.role !== "ADMIN" && !me.teamIds.includes(p.teamId)) throw new Error("Нет доступа к проекту");
  if (manage && !canManageProject(me, p)) throw new Error("Менять настройки проекта может администратор или лидер команды");
  return p;
}
