import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { addDays, dateToYmd, OPEN_STATUSES, todayYmd, ymdToDate } from "./consts";
import { taskPeople, type Person } from "./access";

export type TaskRow = {
  id: string; title: string; description: string | null; mode: string; status: string; priority: number;
  assigneeId: string | null; assignee: string | null; counterpart: string | null;
  waitUntil: string | null; planDate: string | null; startAt: string | null; dueAt: string | null;
  projectId: string | null; project: string | null; projectColor: string | null; parentId: string | null; routineId: string | null;
  order: number; doneAt: string | null; createdAt: string;
  labels: { id: string; name: string; color: string }[];
  checks: { total: number; done: number };
  children: number;
};

const INCLUDE = {
  project: { select: { id: true, name: true, color: true } },
  labels: { select: { label: { select: { id: true, name: true, color: true } } } },
  checks: { select: { done: true } },
  _count: { select: { children: true } },
} satisfies Prisma.TkTaskInclude;
type Raw = Prisma.TkTaskGetPayload<{ include: typeof INCLUDE }>;

export function toRow(r: Raw, people: Person[]): TaskRow {
  return {
    id: r.id, title: r.title, description: r.description, mode: r.mode, status: r.status, priority: r.priority,
    assigneeId: r.assigneeId, assignee: people.find((p) => p.id === r.assigneeId)?.name ?? null, counterpart: r.counterpart,
    waitUntil: dateToYmd(r.waitUntil), planDate: dateToYmd(r.planDate), startAt: dateToYmd(r.startAt), dueAt: dateToYmd(r.dueAt),
    projectId: r.projectId, project: r.project?.name ?? null, projectColor: r.project?.color ?? null, parentId: r.parentId, routineId: r.routineId,
    order: r.order, doneAt: r.doneAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
    labels: r.labels.map((l) => l.label),
    checks: { total: r.checks.length, done: r.checks.filter((c) => c.done).length },
    children: r._count.children,
  };
}

export type ProjectNode = { id: string; parentId: string | null; name: string; color: string; ownerId: string | null; order: number; archived: boolean; description: string | null; depth: number; path: string };

/** Проекты деревом (плоский список в порядке обхода, с глубиной и полным путём «Pinterest / Кулинария»). */
export async function projectTree(opts: { archived?: boolean } = {}): Promise<ProjectNode[]> {
  const rows = await prisma.tkProject.findMany({ where: opts.archived ? {} : { archived: false }, orderBy: [{ order: "asc" }, { name: "asc" }] });
  const out: ProjectNode[] = [];
  const walk = (parentId: string | null, depth: number, path: string) => {
    for (const r of rows.filter((x) => x.parentId === parentId)) {
      const p = path ? `${path} / ${r.name}` : r.name;
      out.push({ id: r.id, parentId: r.parentId, name: r.name, color: r.color, ownerId: r.ownerId, order: r.order, archived: r.archived, description: r.description, depth, path: p });
      walk(r.id, depth + 1, p);
    }
  };
  walk(null, 0, "");
  // Сироты (родитель заархивирован/удалён) — в конец верхним уровнем
  for (const r of rows) if (!out.some((o) => o.id === r.id)) out.push({ id: r.id, parentId: null, name: r.name, color: r.color, ownerId: r.ownerId, order: r.order, archived: r.archived, description: r.description, depth: 0, path: r.name });
  return out;
}
/** id проекта и всех его потомков. */
export function projectFamily(tree: ProjectNode[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const n of tree) if (n.parentId === out[i]) out.push(n.id);
  return out;
}

export type Filters = { projectIds?: string[]; assigneeId?: string; mode?: string; status?: string[]; labelId?: string; q?: string; includeDone?: boolean };

export function filterWhere(f: Filters): Prisma.TkTaskWhereInput {
  return {
    ...(f.projectIds ? { projectId: { in: f.projectIds } } : {}),
    ...(f.assigneeId ? { assigneeId: f.assigneeId } : {}),
    ...(f.mode ? { mode: f.mode } : {}),
    ...(f.status ? { status: { in: f.status } } : f.includeDone ? {} : { status: { in: OPEN_STATUSES } }),
    ...(f.labelId ? { labels: { some: { labelId: f.labelId } } } : {}),
    ...(f.q ? { OR: [{ title: { contains: f.q } }, { description: { contains: f.q } }] } : {}),
  };
}

export async function listTasks(f: Filters, take = 1000): Promise<TaskRow[]> {
  const [rows, people] = await Promise.all([
    prisma.tkTask.findMany({ where: filterWhere(f), include: INCLUDE, orderBy: [{ priority: "asc" }, { order: "asc" }, { createdAt: "desc" }], take }),
    taskPeople(),
  ]);
  return rows.map((r) => toRow(r, people));
}

export async function getTask(id: string): Promise<(TaskRow & { descriptionFull: string | null; createdById: string | null }) | null> {
  const [r, people] = await Promise.all([prisma.tkTask.findUnique({ where: { id }, include: INCLUDE }), taskPeople()]);
  return r ? { ...toRow(r, people), descriptionFull: r.description, createdById: r.createdById } : null;
}

/* ---------- Экран дня ---------- */

export type DayView = {
  ymd: string;
  planned: TaskRow[];     // план на этот день
  overdue: TaskRow[];     // дедлайн прошёл (только для сегодня)
  due: TaskRow[];         // дедлайн в этот день, но не в плане
  waiting: TaskRow[];     // ждём ответа, срок ожидания истёк
  doneToday: TaskRow[];   // закрыто в этот день
};

export async function dayView(ymd: string, assigneeId?: string): Promise<DayView> {
  const people = await taskPeople();
  const day = ymdToDate(ymd);
  const next = ymdToDate(addDays(ymd, 1));
  const who = assigneeId ? { assigneeId } : {};
  const isToday = ymd === todayYmd();
  const [planned, overdue, due, waiting, doneToday] = await Promise.all([
    prisma.tkTask.findMany({ where: { ...who, planDate: day, status: { in: OPEN_STATUSES } }, include: INCLUDE, orderBy: [{ priority: "asc" }, { order: "asc" }] }),
    isToday ? prisma.tkTask.findMany({ where: { ...who, dueAt: { lt: day }, status: { in: OPEN_STATUSES } }, include: INCLUDE, orderBy: [{ dueAt: "asc" }, { priority: "asc" }] }) : Promise.resolve([] as Raw[]),
    prisma.tkTask.findMany({ where: { ...who, dueAt: day, status: { in: OPEN_STATUSES }, NOT: { planDate: day } }, include: INCLUDE, orderBy: [{ priority: "asc" }] }),
    isToday ? prisma.tkTask.findMany({ where: { ...who, mode: { in: ["delegate", "ask"] }, status: { in: OPEN_STATUSES }, waitUntil: { lte: day } }, include: INCLUDE, orderBy: [{ waitUntil: "asc" }] }) : Promise.resolve([] as Raw[]),
    prisma.tkTask.findMany({ where: { ...who, status: "done", doneAt: { gte: day, lt: next } }, include: INCLUDE, orderBy: [{ doneAt: "desc" }] }),
  ]);
  const m = (xs: Raw[]) => xs.map((r) => toRow(r, people));
  return { ymd, planned: m(planned), overdue: m(overdue), due: m(due), waiting: m(waiting), doneToday: m(doneToday) };
}

/* ---------- Дашборд ---------- */

export type Stats = {
  open: number; doing: number; waiting: number; ideas: number; overdue: number; today: number; nudge: number;
  doneWeek: number; createdWeek: number; stale: number;
  byMode: Record<string, number>;
  byPerson: { id: string; name: string; open: number; today: number; overdue: number; doneWeek: number }[];
  byProject: { id: string; name: string; color: string; depth: number; open: number; doing: number; overdue: number; doneWeek: number; createdWeek: number; lastMove: string | null }[];
  weekly: { ymd: string; done: number; created: number }[];
};

export async function stats(): Promise<Stats> {
  const today = todayYmd();
  const day = ymdToDate(today);
  const weekAgo = ymdToDate(addDays(today, -7));
  const staleBefore = ymdToDate(addDays(today, -14));
  const [people, tree, open, doneWeek, createdWeekRows, doneRows] = await Promise.all([
    taskPeople(), projectTree({ archived: true }),
    prisma.tkTask.findMany({ where: { status: { in: OPEN_STATUSES } }, select: { id: true, status: true, mode: true, assigneeId: true, projectId: true, planDate: true, dueAt: true, waitUntil: true, updatedAt: true } }),
    prisma.tkTask.findMany({ where: { status: "done", doneAt: { gte: weekAgo } }, select: { assigneeId: true, projectId: true, doneAt: true } }),
    prisma.tkTask.findMany({ where: { createdAt: { gte: weekAgo } }, select: { projectId: true, createdAt: true } }),
    prisma.tkTask.findMany({ where: { status: "done", doneAt: { gte: ymdToDate(addDays(today, -13)) } }, select: { doneAt: true } }),
  ]);
  const top = (pid: string | null): ProjectNode | null => {
    let n = tree.find((t) => t.id === pid) ?? null;
    while (n && n.parentId) n = tree.find((t) => t.id === n!.parentId) ?? null;
    return n;
  };
  const s: Stats = {
    open: open.length, doing: 0, waiting: 0, ideas: 0, overdue: 0, today: 0, nudge: 0, doneWeek: doneWeek.length, createdWeek: createdWeekRows.length, stale: 0,
    byMode: { do: 0, delegate: 0, ask: 0 }, byPerson: [], byProject: [], weekly: [],
  };
  for (const t of open) {
    if (t.status === "doing") s.doing++;
    if (t.status === "waiting") s.waiting++;
    if (t.status === "idea") s.ideas++;
    if (t.dueAt && t.dueAt < day) s.overdue++;
    if (t.planDate && t.planDate.getTime() === day.getTime()) s.today++;
    if ((t.mode === "delegate" || t.mode === "ask") && t.waitUntil && t.waitUntil <= day) s.nudge++;
    if (t.status !== "idea" && t.updatedAt < staleBefore) s.stale++;
    s.byMode[t.mode] = (s.byMode[t.mode] ?? 0) + 1;
  }
  s.byPerson = people.map((p) => ({
    id: p.id, name: p.name,
    open: open.filter((t) => t.assigneeId === p.id).length,
    today: open.filter((t) => t.assigneeId === p.id && t.planDate && t.planDate.getTime() === day.getTime()).length,
    overdue: open.filter((t) => t.assigneeId === p.id && t.dueAt && t.dueAt < day).length,
    doneWeek: doneWeek.filter((t) => t.assigneeId === p.id).length,
  }));
  const un = open.filter((t) => !t.assigneeId).length;
  if (un) s.byPerson.push({ id: "", name: "Без исполнителя", open: un, today: 0, overdue: open.filter((t) => !t.assigneeId && t.dueAt && t.dueAt < day).length, doneWeek: 0 });
  // По проектам: верхний уровень суммирует потомков
  for (const n of tree.filter((t) => !t.archived)) {
    const fam = projectFamily(tree, n.id);
    const mine = open.filter((t) => t.projectId && fam.includes(t.projectId));
    const dw = doneWeek.filter((t) => t.projectId && fam.includes(t.projectId));
    const cw = createdWeekRows.filter((t) => t.projectId && fam.includes(t.projectId));
    const last = [...mine.map((t) => t.updatedAt), ...dw.map((t) => t.doneAt!)].sort((a, b) => b.getTime() - a.getTime())[0];
    s.byProject.push({ id: n.id, name: n.name, color: n.color, depth: n.depth, open: mine.length, doing: mine.filter((t) => t.status === "doing").length, overdue: mine.filter((t) => t.dueAt && t.dueAt < day).length, doneWeek: dw.length, createdWeek: cw.length, lastMove: last ? last.toISOString() : null });
  }
  const noProj = open.filter((t) => !t.projectId || !top(t.projectId));
  if (noProj.length) s.byProject.push({ id: "", name: "Без проекта", color: "#94a3b8", depth: 0, open: noProj.length, doing: noProj.filter((t) => t.status === "doing").length, overdue: noProj.filter((t) => t.dueAt && t.dueAt < day).length, doneWeek: doneWeek.filter((t) => !t.projectId).length, createdWeek: createdWeekRows.filter((t) => !t.projectId).length, lastMove: null });
  for (let i = 13; i >= 0; i--) {
    const ymd = addDays(today, -i);
    const d0 = ymdToDate(ymd), d1 = ymdToDate(addDays(ymd, 1));
    s.weekly.push({ ymd, done: doneRows.filter((r) => r.doneAt && r.doneAt >= d0 && r.doneAt < d1).length, created: createdWeekRows.filter((r) => r.createdAt >= d0 && r.createdAt < d1).length });
  }
  return s;
}

/* ---------- Отчёты сотрудников ---------- */

export type ReportRow = { id: string; userId: string; user: string; date: string; source: string; transcript: string; items: string[]; audioSec: number | null; costUsd: number | null; createdAt: string };

export async function listReports(f: { from: string; to: string; userId?: string }): Promise<ReportRow[]> {
  const [rows, users] = await Promise.all([
    prisma.tkReport.findMany({ where: { date: { gte: ymdToDate(f.from), lte: ymdToDate(f.to) }, ...(f.userId ? { userId: f.userId } : {}) }, orderBy: [{ date: "desc" }, { createdAt: "desc" }] }),
    prisma.user.findMany({ select: { id: true, name: true, email: true } }),
  ]);
  return rows.map((r) => ({
    id: r.id, userId: r.userId, user: users.find((u) => u.id === r.userId)?.name || users.find((u) => u.id === r.userId)?.email || "?",
    date: dateToYmd(r.date)!, source: r.source, transcript: r.transcript, items: Array.isArray(r.items) ? (r.items as string[]) : [],
    audioSec: r.audioSec, costUsd: r.costUsd, createdAt: r.createdAt.toISOString(),
  }));
}
