import Link from "next/link";
import { requireTasks } from "@/lib/tasks/access";
import { listTasks, projectTree, type ProjectNode, type TaskRow } from "@/lib/tasks/queries";
import { TasksHeader } from "@/components/tasks/Header";
import { QuickAdd } from "@/components/tasks/QuickAdd";
import { Avatar, DayChip, LabelChip, ModeBadge, Pri, StatusBadge } from "@/components/tasks/bits";
import { sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Дерево: направление → проект → задача → подзадачи. Сворачивается без JavaScript (<details>). */
export default async function TreePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireTasks();
  const params = await searchParams;
  const showDone = !!sp(params, "done");
  const [tree, tasks] = await Promise.all([projectTree(), listTasks({ includeDone: showDone }, 3000)]);
  const kids = (parentId: string | null, projectId: string | null) => tasks.filter((t) => t.parentId === parentId && (parentId ? true : t.projectId === projectId)).sort((a, b) => a.priority - b.priority || a.order - b.order);
  const countIn = (projectId: string) => tasks.filter((t) => t.projectId === projectId && t.status !== "done" && t.status !== "cancelled").length;
  const subtreeCount = (n: ProjectNode) => [n.id, ...tree.filter((c) => c.path.startsWith(n.path + " / ")).map((c) => c.id)].reduce((s, id) => s + countIn(id), 0);

  const TaskNode = ({ t, depth }: { t: TaskRow; depth: number }) => {
    const ch = kids(t.id, t.projectId);
    const row = (
      <div className="flex items-center gap-2 py-1.5 min-w-0">
        <Link href={`/tasks/t/${t.id}`} className={`text-[14px] hover:underline [overflow-wrap:anywhere] ${t.status === "done" ? "line-through text-muted" : "font-medium"}`}><Pri n={t.priority} /> {t.title}</Link>
        <StatusBadge status={t.status} />
        <ModeBadge mode={t.mode} counterpart={t.counterpart} compact />
        <DayChip ymd={t.dueAt} kind="due" />
        {t.labels.map((l) => <LabelChip key={l.id} name={l.name} color={l.color} small />)}
        <span className="ml-auto" /><Avatar name={t.assignee} size={20} />
      </div>
    );
    if (!ch.length) return <div style={{ paddingLeft: depth * 20 + 22 }} className="border-l border-line/60 ml-2">{row}</div>;
    return (
      <details open className="group" style={{ paddingLeft: depth * 20 }}>
        <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-muted transition group-open:rotate-90" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
          <div className="min-w-0 flex-1">{row}</div>
        </summary>
        <div className="ml-2 border-l border-line/60">{ch.map((c) => <TaskNode key={c.id} t={c} depth={1} />)}</div>
      </details>
    );
  };

  const ProjectNodeView = ({ n }: { n: ProjectNode }) => {
    const children = tree.filter((c) => c.parentId === n.id);
    const own = kids(null, n.id);
    const count = subtreeCount(n);
    return (
      <details open={n.depth === 0 || count > 0} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-2 [&::-webkit-details-marker]:hidden">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-muted transition group-open:rotate-90" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
          <span className="inline-block h-3 w-3 rounded-full shrink-0" style={{ background: n.color }} />
          <Link href={`/tasks/projects/${n.id}`} className={`hover:underline ${n.depth === 0 ? "text-[16px] font-bold" : "text-[14.5px] font-semibold"}`}>{n.name}</Link>
          <span className="help">{count} откр.</span>
          <Link href={`/tasks/new?project=${n.id}`} className="ml-auto btn-ghost btn-sm !py-0.5 opacity-0 group-hover:opacity-100">+ задача</Link>
        </summary>
        <div className="ml-5 pl-3 border-l-2" style={{ borderColor: `${n.color}55` }}>
          {own.map((t) => <TaskNode key={t.id} t={t} depth={0} />)}
          {children.map((c) => <ProjectNodeView key={c.id} n={c} />)}
          {!own.length && !children.length && <p className="help py-1">Пусто</p>}
        </div>
      </details>
    );
  };

  const orphans = kids(null, null);
  return (
    <>
      <TasksHeader userId={me.id} />
      <QuickAdd />
      <div className="mb-3 flex items-center gap-2">
        <Link href={showDone ? "/tasks/tree" : "/tasks/tree?done=1"} className="tab border-line">{showDone ? "Скрыть готовые" : "Показать готовые"}</Link>
        <Link href="/tasks/projects" className="tab border-line">Управлять проектами</Link>
      </div>
      <div className="card p-4 sm:p-5 space-y-1">
        {tree.filter((n) => n.depth === 0).map((n) => <ProjectNodeView key={n.id} n={n} />)}
        {orphans.length > 0 && (
          <details open className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 py-2 [&::-webkit-details-marker]:hidden"><span className="inline-block h-3 w-3 rounded-full bg-ink/20" /><span className="text-[16px] font-bold">Без проекта</span><span className="help">{orphans.length}</span></summary>
            <div className="ml-5 pl-3 border-l-2 border-line">{orphans.map((t) => <TaskNode key={t.id} t={t} depth={0} />)}</div>
          </details>
        )}
      </div>
    </>
  );
}
