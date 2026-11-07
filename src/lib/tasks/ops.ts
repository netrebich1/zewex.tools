import { prisma } from "@/lib/db";
import { isStatus, statusLabel, todayYmd, ymdToDate, type Status } from "./consts";
import { matchByName, parseQuick } from "./quick";
import { taskPeople } from "./access";
import { projectTree } from "./queries";

/** Общие операции над задачами: используют и server actions, и Telegram-бот. */

export async function logEvent(taskId: string, userId: string | null, text: string) {
  await prisma.tkNote.create({ data: { taskId, userId, kind: "event", text } });
}

/** Создать задачу из строки быстрого ввода. Возвращает id и что распознано. */
export async function createFromQuick(raw: string, byUserId: string, defaults: { projectId?: string | null; assigneeId?: string | null; status?: Status; parentId?: string | null } = {}) {
  const q = parseQuick(raw);
  const [people, tree] = await Promise.all([taskPeople(), projectTree()]);
  const assignee = matchByName(people, q.assigneeName);
  const project = matchByName(tree, q.projectName);
  const labelRows = q.labels.length ? await prisma.tkLabel.findMany() : [];
  const labelIds = q.labels.map((l) => matchByName(labelRows, l)?.id).filter((x): x is string => !!x);
  const status: Status = defaults.status ?? (q.planDate ? "planned" : "backlog");
  const projectId = project?.id ?? defaults.projectId ?? null;
  const projOwner = projectId ? tree.find((t) => t.id === projectId)?.ownerId ?? null : null;
  const assigneeId = assignee?.id ?? defaults.assigneeId ?? projOwner ?? byUserId;
  const last = await prisma.tkTask.aggregate({ _min: { order: true }, where: { status } });
  const task = await prisma.tkTask.create({
    data: {
      title: q.title, mode: q.mode, counterpart: q.counterpart, priority: q.priority, status, assigneeId, projectId, parentId: defaults.parentId ?? null,
      planDate: q.planDate ? ymdToDate(q.planDate) : null, dueAt: q.dueAt ? ymdToDate(q.dueAt) : null,
      waitUntil: q.mode !== "do" && q.dueAt ? ymdToDate(q.dueAt) : null,
      order: (last._min.order ?? 0) - 1, createdById: byUserId,
      labels: labelIds.length ? { create: labelIds.map((labelId) => ({ labelId })) } : undefined,
    },
  });
  const unknown: string[] = [];
  if (q.assigneeName && !assignee) unknown.push(`исполнитель «${q.assigneeName}»`);
  if (q.projectName && !project) unknown.push(`проект «${q.projectName}»`);
  return { id: task.id, title: task.title, parsed: q, assignee: people.find((p) => p.id === assigneeId)?.name ?? null, project: project?.name ?? null, unknown };
}

/** Смена статуса с событием в ленте и датой закрытия. */
export async function setStatus(taskId: string, status: string, byUserId: string | null) {
  if (!isStatus(status)) throw new Error("Неизвестный статус");
  const t = await prisma.tkTask.findUnique({ where: { id: taskId }, select: { status: true } });
  if (!t) throw new Error("Задача не найдена");
  if (t.status === status) return;
  await prisma.tkTask.update({ where: { id: taskId }, data: { status, doneAt: status === "done" ? new Date() : null } });
  if (status === "planned") {
    const row = await prisma.tkTask.findUnique({ where: { id: taskId }, select: { planDate: true } });
    if (!row?.planDate) await prisma.tkTask.update({ where: { id: taskId }, data: { planDate: ymdToDate(todayYmd()) } });
  }
  await logEvent(taskId, byUserId, `${statusLabel(t.status)} → ${statusLabel(status)}`);
}

/** Перенести на день: планы на день. Статус idea/backlog → planned. */
export async function planOn(taskId: string, ymd: string, byUserId: string | null) {
  const t = await prisma.tkTask.findUnique({ where: { id: taskId }, select: { status: true } });
  if (!t) throw new Error("Задача не найдена");
  const data: { planDate: Date; status?: string } = { planDate: ymdToDate(ymd) };
  if (t.status === "idea" || t.status === "backlog") data.status = "planned";
  await prisma.tkTask.update({ where: { id: taskId }, data });
  await logEvent(taskId, byUserId, `План на ${ymd}`);
}

/** Все незакрытые задачи плана на день `from` → день `to`. */
export async function moveDay(from: string, to: string, assigneeId: string | null, byUserId: string | null): Promise<number> {
  const rows = await prisma.tkTask.findMany({ where: { planDate: ymdToDate(from), status: { in: ["idea", "backlog", "planned", "doing", "waiting"] }, ...(assigneeId ? { assigneeId } : {}) }, select: { id: true } });
  if (!rows.length) return 0;
  await prisma.tkTask.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { planDate: ymdToDate(to) } });
  await prisma.tkNote.createMany({ data: rows.map((r) => ({ taskId: r.id, userId: byUserId, kind: "event", text: `Перенесено с ${from} на ${to}` })) });
  return rows.length;
}
