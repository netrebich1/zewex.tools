import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireTasks, taskPeople } from "@/lib/tasks/access";
import { getTask, listTasks, projectTree } from "@/lib/tasks/queries";
import { fmtDateTime } from "@/lib/tasks/consts";
import { TasksHeader } from "@/components/tasks/Header";
import { TaskForm } from "@/components/tasks/TaskForm";
import { TaskActions, Checklist, NoteForm } from "@/components/tasks/TaskActions";
import { QuickAdd } from "@/components/tasks/QuickAdd";
import { TaskLine, StatusBadge, ModeBadge, Pri } from "@/components/tasks/bits";
import { Card } from "@/components/ui";
import { Fold as FoldBlock } from "@/components/ui/Fold";

export const dynamic = "force-dynamic";

/** Карточка задачи: быстрые действия, чеклист, подзадачи, лента (комментарии + события), полная форма правки. */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireTasks();
  const { id } = await params;
  const t = await getTask(id);
  if (!t) notFound();
  const [people, tree, labels, parents, checks, notes, children, parent] = await Promise.all([
    taskPeople(), projectTree(), prisma.tkLabel.findMany({ orderBy: { order: "asc" } }),
    prisma.tkTask.findMany({ where: { status: { notIn: ["done", "cancelled"] }, NOT: { id } }, select: { id: true, title: true }, orderBy: { updatedAt: "desc" }, take: 300 }),
    prisma.tkCheck.findMany({ where: { taskId: id }, orderBy: { order: "asc" } }),
    prisma.tkNote.findMany({ where: { taskId: id }, orderBy: { createdAt: "asc" } }),
    listTasks({ includeDone: true }, 3000).then((all) => all.filter((x) => x.parentId === id)),
    t.parentId ? prisma.tkTask.findUnique({ where: { id: t.parentId }, select: { id: true, title: true } }) : null,
  ]);
  const userName = (uid: string | null) => (uid ? people.find((p) => p.id === uid)?.name ?? "сотрудник" : "бот");
  return (
    <>
      <TasksHeader userId={me.id} />
      <div className="mb-4">
        <p className="help flex flex-wrap items-center gap-1.5">
          <Link href="/tasks/board" className="hover:underline">Канбан</Link>
          {t.project && <>· <Link href={`/tasks/projects/${t.projectId}`} className="hover:underline">{t.project}</Link></>}
          {parent && <>· <Link href={`/tasks/t/${parent.id}`} className="hover:underline">{parent.title}</Link></>}
        </p>
        <h1 className="h1 mt-1"><Pri n={t.priority} /> {t.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge status={t.status} /><ModeBadge mode={t.mode} counterpart={t.counterpart} />
          {t.assignee && <span className="help">Исполнитель: <b className="text-ink">{t.assignee}</b></span>}
          {t.routineId && <span className="badge bg-info-soft text-info">из регламента</span>}
          <span className="help">создана {fmtDateTime(t.createdAt)}</span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4 min-w-0">
          <Card title="Быстрые действия"><TaskActions t={t} back={t.projectId ? `/tasks/projects/${t.projectId}` : "/tasks/board"} /></Card>
          {t.descriptionFull && <Card title="Описание"><div className="whitespace-pre-wrap text-[14.5px] leading-relaxed [overflow-wrap:anywhere]">{t.descriptionFull}</div></Card>}
          <Card title={<>Чеклист {checks.length ? <span className="text-muted font-normal">({checks.filter((c) => c.done).length}/{checks.length})</span> : null}</>}>
            <Checklist taskId={id} items={checks} />
          </Card>
          <Card title={<>Подзадачи {children.length ? <span className="text-muted font-normal">({children.filter((c) => c.status === "done").length}/{children.length})</span> : null}</>}>
            {children.length > 0 && <div className="mb-3">{children.map((c) => <TaskLine key={c.id} t={c} />)}</div>}
            <QuickAdd defaults={{ parentId: id, projectId: t.projectId ?? undefined, assigneeId: t.assigneeId ?? undefined }} placeholder="Новая подзадача" />
          </Card>
          <Card title="Лента">
            <div className="space-y-2 mb-4">
              {notes.length === 0 && <p className="help">Пока пусто.</p>}
              {notes.map((n) => n.kind === "event" ? (
                <p key={n.id} className="help">· {n.text} <span className="text-muted/70">— {userName(n.userId)}, {fmtDateTime(n.createdAt)}</span></p>
              ) : (
                <div key={n.id} className="rounded-xl bg-ink/[0.035] px-3.5 py-2.5">
                  <p className="text-[12.5px] font-semibold">{userName(n.userId)} <span className="text-muted font-normal">· {fmtDateTime(n.createdAt)}</span></p>
                  <p className="text-[14px] whitespace-pre-wrap [overflow-wrap:anywhere] mt-0.5">{n.text}</p>
                </div>
              ))}
            </div>
            <NoteForm taskId={id} />
          </Card>
        </div>
        <div className="min-w-0">
          <FoldBlock title="Изменить задачу" summary="все поля" defaultOpen={!t.descriptionFull && !t.assigneeId} className="bg-surface">
            <TaskForm task={t} refs={{ people, projects: tree, labels, parents }} />
          </FoldBlock>
        </div>
      </div>
    </>
  );
}
