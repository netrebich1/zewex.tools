/** Задачи проектов: кто что видит. Сотрудник — задачи по видимым ему сайтам; «мои» — где он исполнитель. */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { visibleAccessIds } from "@/lib/sites/access";
import type { Prisma } from "@prisma/client";

export async function taskWhere(me: CurrentUser): Promise<Prisma.PrjTaskWhereInput> {
  const ids = await visibleAccessIds(me);
  return ids === null ? {} : { card: { accessId: { in: ids } } };
}

export async function overdueTasksCount(me: CurrentUser): Promise<number> {
  const where = await taskWhere(me);
  return prisma.prjTask.count({ where: { ...where, status: { not: "done" }, dueAt: { lt: new Date() }, ...(me.role === "ADMIN" || me.leadTeamIds.length ? {} : { assigneeId: me.id }) } });
}

export type TaskRow = {
  id: string; title: string; description: string | null; status: string; dueAt: string | null; assigneeId: string | null; assigneeName: string | null;
  accessId: string; siteName: string; createdAt: string; doneAt: string | null;
};

export async function listTasks(me: CurrentUser, f: { scope: "mine" | "team" | "all"; accessId?: string; done?: boolean }): Promise<TaskRow[]> {
  const base = await taskWhere(me);
  const where: Prisma.PrjTaskWhereInput = {
    ...base,
    ...(f.scope === "mine" ? { assigneeId: me.id } : {}),
    ...(f.accessId ? { card: { accessId: f.accessId } } : {}),
    ...(f.done ? {} : { status: { not: "done" } }),
  };
  const rows = await prisma.prjTask.findMany({ where, orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }], take: 500, include: { card: { select: { accessId: true, access: { select: { name: true } } } } } });
  const userIds = [...new Set(rows.map((r) => r.assigneeId).filter((x): x is string => !!x))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
  const uname = (id: string | null) => { const u = users.find((x) => x.id === id); return u ? u.name || u.email : null; };
  return rows.map((r) => ({
    id: r.id, title: r.title, description: r.description, status: r.status, dueAt: r.dueAt?.toISOString() ?? null, assigneeId: r.assigneeId, assigneeName: uname(r.assigneeId),
    accessId: r.card.accessId, siteName: r.card.access.name, createdAt: r.createdAt.toISOString(), doneAt: r.doneAt?.toISOString() ?? null,
  }));
}

/** Группировка для экрана задач: просрочено / сегодня / неделя / позже / без срока / сделано. */
export function groupTasks(rows: TaskRow[], now = new Date()): Array<{ key: string; label: string; rows: TaskRow[] }> {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = day(now), week = today + 7 * 86400000;
  const g: Record<string, TaskRow[]> = { overdue: [], today: [], week: [], later: [], none: [], done: [] };
  for (const r of rows) {
    if (r.status === "done") { g.done.push(r); continue; }
    if (!r.dueAt) { g.none.push(r); continue; }
    const d = day(new Date(r.dueAt));
    if (d < today) g.overdue.push(r); else if (d === today) g.today.push(r); else if (d < week) g.week.push(r); else g.later.push(r);
  }
  const labels: Record<string, string> = { overdue: "Просрочено", today: "Сегодня", week: "На неделе", later: "Позже", none: "Без срока", done: "Сделано" };
  return Object.entries(g).filter(([, v]) => v.length).map(([key, v]) => ({ key, label: labels[key], rows: v }));
}

/** Сотрудники, которым можно назначить задачу по сайту: участники команд сайта (владелец + открытые). */
export async function assigneesFor(teamIds: string[]): Promise<Array<{ id: string; name: string }>> {
  if (!teamIds.length) return [];
  const rows = await prisma.teamMember.findMany({ where: { teamId: { in: teamIds }, user: { isActive: true } }, select: { user: { select: { id: true, name: true, email: true } } }, distinct: ["userId"] });
  return rows.map((r) => ({ id: r.user.id, name: r.user.name || r.user.email })).sort((a, b) => a.name.localeCompare(b.name));
}
