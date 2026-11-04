import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireTasks, taskPeople } from "@/lib/tasks/access";
import { listTasks, projectFamily, projectTree } from "@/lib/tasks/queries";
import { addDays, BOARD_STATUSES, fmtDateTime, todayYmd } from "@/lib/tasks/consts";
import { TasksHeader } from "@/components/tasks/Header";
import { QuickAdd } from "@/components/tasks/QuickAdd";
import { Board } from "@/components/tasks/Board";
import { Avatar, TaskLine } from "@/components/tasks/bits";
import { Card, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

const KPI = "kpi min-w-0 !flex-row items-baseline justify-between gap-3 sm:!flex-col sm:items-stretch sm:justify-start sm:gap-1";
const V = "kpi-value tabular-nums !text-[22px] sm:!text-[30px]";

/** Дашборд проекта: его цифры, подпроекты, канбан или список своих задач (с подпроектами). */
export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireTasks();
  const { id } = await params;
  const sparams = await searchParams;
  const view = sp(sparams, "view") === "list" ? "list" : "board";
  const tree = await projectTree({ archived: true });
  const p = tree.find((x) => x.id === id);
  if (!p) notFound();
  const fam = projectFamily(tree, id);
  const [people, tasks, notes] = await Promise.all([
    taskPeople(),
    listTasks({ projectIds: fam, status: [...BOARD_STATUSES] }, 2000),
    prisma.tkNote.findMany({ where: { task: { projectId: { in: fam } } }, orderBy: { createdAt: "desc" }, take: 12, include: { task: { select: { id: true, title: true } } } }),
  ]);
  const today = todayYmd();
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const open = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const doneWeek = tasks.filter((t) => t.status === "done" && t.doneAt && new Date(t.doneAt) > weekAgo);
  const overdue = open.filter((t) => t.dueAt && t.dueAt < today);
  const children = tree.filter((c) => c.parentId === id && !c.archived);
  const crumbs: typeof tree = [];
  for (let n: typeof p | undefined = p; n; n = tree.find((x) => x.id === n!.parentId)) crumbs.unshift(n);
  const boardRows = tasks.filter((t) => t.status !== "done" || (t.doneAt && new Date(t.doneAt) > weekAgo));
  const byPerson = people.map((u) => ({ ...u, open: open.filter((t) => t.assigneeId === u.id).length, done: doneWeek.filter((t) => t.assigneeId === u.id).length })).filter((u) => u.open || u.done);
  return (
    <>
      <TasksHeader userId={me.id} />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="help flex flex-wrap items-center gap-1.5"><Link href="/tasks/projects" className="hover:underline">Проекты</Link>{crumbs.slice(0, -1).map((c) => <span key={c.id}>· <Link href={`/tasks/projects/${c.id}`} className="hover:underline">{c.name}</Link></span>)}</p>
          <h1 className="h1 mt-1 flex items-center gap-2.5"><span className="inline-block h-4 w-4 rounded-full shrink-0" style={{ background: p.color }} />{p.name}{p.archived && <span className="badge bg-ink/5 text-muted">архив</span>}</h1>
          {p.description && <p className="help mt-1 max-w-2xl">{p.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {p.ownerId && <span className="help inline-flex items-center gap-1.5"><Avatar name={people.find((u) => u.id === p.ownerId)?.name ?? null} /> ответственный</span>}
          <Link href={`/tasks/projects?edit=${id}`} className="btn-ghost btn-sm">Изменить</Link>
          <Link href={`/tasks/projects?parent=${id}`} className="btn-ghost btn-sm">+ подпроект</Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
        <div className={KPI}><span className="help">Открыто</span><span className={V}>{open.length}</span></div>
        <div className={KPI}><span className="help">В работе</span><span className={`${V} text-ok`}>{open.filter((t) => t.status === "doing").length}</span></div>
        <div className={KPI}><span className="help">Просрочено</span><span className={`${V} ${overdue.length ? "text-danger" : "text-muted"}`}>{overdue.length}</span></div>
        <div className={KPI}><span className="help">Сделано за неделю</span><span className={`${V} text-ok`}>{doneWeek.length}</span></div>
      </div>

      {children.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {children.map((c) => {
            const cf = projectFamily(tree, c.id);
            const n = open.filter((t) => t.projectId && cf.includes(t.projectId)).length;
            return <Link key={c.id} href={`/tasks/projects/${c.id}`} className="card card-hover px-3.5 py-2 inline-flex items-center gap-2 text-[14px] font-medium"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />{c.name}<span className="help">{n}</span></Link>;
          })}
        </div>
      )}

      <QuickAdd defaults={{ projectId: id, assigneeId: p.ownerId ?? undefined }} placeholder={`Новая задача в «${p.name}»`} />

      <div className="mb-3 flex items-center gap-2">
        <div className="inline-flex gap-1 rounded-xl bg-ink/5 p-1">
          <Link href={`/tasks/projects/${id}`} className={`rounded-lg px-3.5 py-1.5 text-[14px] font-semibold ${view === "board" ? "bg-surface shadow-[var(--shadow-card)]" : "text-muted"}`}>Канбан</Link>
          <Link href={`/tasks/projects/${id}?view=list`} className={`rounded-lg px-3.5 py-1.5 text-[14px] font-semibold ${view === "list" ? "bg-surface shadow-[var(--shadow-card)]" : "text-muted"}`}>Список</Link>
        </div>
        <Link href={`/tasks/tree`} className="tab border-line">Дерево</Link>
        <Link href={`/tasks/today?who=all&d=${today}`} className="tab border-line">Сегодня</Link>
        <Link href={`/tasks/today?who=all&d=${addDays(today, 1)}`} className="tab border-line">Завтра</Link>
      </div>

      {view === "board" ? <Board tasks={boardRows} /> : (
        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <Card title={`Открытые задачи (${open.length})`}>{open.length ? <div>{open.sort((a, b) => a.priority - b.priority).map((t) => <TaskLine key={t.id} t={t} />)}</div> : <p className="help">Пусто.</p>}</Card>
          <div className="space-y-4">
            {byPerson.length > 0 && <Card title="Кто что везёт"><div className="space-y-2">{byPerson.map((u) => <div key={u.id} className="flex items-center gap-2 text-[14px]"><Avatar name={u.name} size={24} /><span className="flex-1 truncate">{u.name}</span><span className="help">{u.open} откр. · <span className="text-ok">+{u.done}</span></span></div>)}</div></Card>}
            <Card title="Последние события">
              {notes.length === 0 ? <p className="help">Пока тихо.</p> : <div className="space-y-1.5">{notes.map((n) => <p key={n.id} className="help"><Link href={`/tasks/t/${n.task.id}`} className="text-ink hover:underline">{n.task.title}</Link>: {n.kind === "comment" ? `💬 ${n.text.slice(0, 80)}` : n.text} <span className="text-muted/70">· {fmtDateTime(n.createdAt)}</span></p>)}</div>}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
