import { prisma } from "@/lib/db";
import { requireTasks, taskPeople } from "@/lib/tasks/access";
import { projectTree } from "@/lib/tasks/queries";
import { isYmd } from "@/lib/tasks/consts";
import { TasksHeader } from "@/components/tasks/Header";
import { TaskForm } from "@/components/tasks/TaskForm";
import { Card, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Полная форма новой задачи (?project=, ?who=, ?day=, ?parent=). */
export default async function NewTaskPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireTasks();
  const params = await searchParams;
  const [people, tree, labels, parents] = await Promise.all([
    taskPeople(), projectTree(), prisma.tkLabel.findMany({ orderBy: { order: "asc" } }),
    prisma.tkTask.findMany({ where: { status: { notIn: ["done", "cancelled"] } }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 300 }),
  ]);
  const day = sp(params, "day");
  return (
    <>
      <TasksHeader userId={me.id} />
      <Card title="Новая задача" description="Для быстрого ввода хватает строки «+» на любом экране; здесь — все поля." className="max-w-3xl">
        <TaskForm refs={{ people, projects: tree, labels, parents }} defaults={{ projectId: sp(params, "project") ?? null, assigneeId: sp(params, "who") ?? me.id, parentId: sp(params, "parent") ?? null, planDate: day && isYmd(day) ? day : null, status: sp(params, "status") ?? "backlog" }} back="/tasks/board" />
      </Card>
    </>
  );
}
