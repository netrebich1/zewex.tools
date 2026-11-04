import { redirect } from "next/navigation";
import { getCurrentUser, requireUser, type CurrentUser } from "@/lib/auth";
import { canUseTool } from "@/lib/permissions";
import { prisma } from "@/lib/db";

/** Задачи — закрытый инструмент: роль не важна, нужен выданный доступ (`ToolAccess`) или владелец портала. */
export const TASKS = "tasks";

export async function requireTasks(): Promise<CurrentUser> {
  const me = await requireUser();
  if (!canUseTool(me, TASKS)) redirect("/?denied=1");
  return me;
}

export async function tasksUser(): Promise<CurrentUser | null> {
  const me = await getCurrentUser();
  return me && canUseTool(me, TASKS) ? me : null;
}

export type Person = { id: string; name: string };

/** Кому можно назначать задачи: все, кому открыт инструмент (владелец + ToolAccess). */
export async function taskPeople(): Promise<Person[]> {
  const [grants, admins] = await Promise.all([
    prisma.toolAccess.findMany({ where: { slug: TASKS, user: { isActive: true } }, select: { user: { select: { id: true, name: true, email: true } } } }),
    prisma.user.findMany({ where: { isActive: true, role: "ADMIN" }, select: { id: true, name: true, email: true, superAdmin: true } }),
  ]);
  const owners = (process.env.ALLOWED_REGISTRATION_EMAILS ?? "").split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const map = new Map<string, Person>();
  for (const a of admins) if (a.superAdmin || owners.includes(a.email.toLowerCase())) map.set(a.id, { id: a.id, name: a.name || a.email });
  for (const g of grants) map.set(g.user.id, { id: g.user.id, name: g.user.name || g.user.email });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/** Все активные сотрудники портала — для привязки бота и голосовых отчётов. */
export async function allPeople(): Promise<Person[]> {
  const rows = await prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } });
  return rows.map((u) => ({ id: u.id, name: u.name || u.email }));
}
