import { prisma } from "@/lib/db";
import { OPEN_STATUSES, todayYmd, ymdToDate } from "@/lib/tasks/consts";
import { TasksNav } from "./TasksNav";

/** Шапка раздела: подменю со счётчиком «Сегодня» (мои задачи на сегодня + пора пнуть). */
export async function TasksHeader({ userId }: { userId: string }) {
  const day = ymdToDate(todayYmd());
  const [today, nudge] = await Promise.all([
    prisma.tkTask.count({ where: { assigneeId: userId, status: { in: OPEN_STATUSES }, OR: [{ planDate: day }, { dueAt: { lte: day } }] } }),
    prisma.tkTask.count({ where: { assigneeId: userId, status: { in: OPEN_STATUSES }, mode: { in: ["delegate", "ask"] }, waitUntil: { lte: day } } }),
  ]);
  return <TasksNav badge={{ today: today + nudge, nudge }} />;
}
