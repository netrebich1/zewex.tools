import Link from "next/link";
import { requireTasks, taskPeople } from "@/lib/tasks/access";
import { listTasks, projectFamily, projectTree } from "@/lib/tasks/queries";
import { BOARD_STATUSES, MODES } from "@/lib/tasks/consts";
import { prisma } from "@/lib/db";
import { TasksHeader } from "@/components/tasks/Header";
import { QuickAdd } from "@/components/tasks/QuickAdd";
import { Board } from "@/components/tasks/Board";
import { sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Канбан всех задач с фильтрами: проект (с подпроектами), человек, способ, метка, поиск. */
export default async function BoardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireTasks();
  const params = await searchParams;
  const f = { project: sp(params, "project"), who: sp(params, "who"), mode: sp(params, "mode"), label: sp(params, "label"), q: sp(params, "q"), done: sp(params, "done") };
  const [tree, people, labels] = await Promise.all([projectTree(), taskPeople(), prisma.tkLabel.findMany({ orderBy: { order: "asc" } })]);
  const projectIds = f.project ? projectFamily(tree, f.project) : undefined;
  const tasks = await listTasks({ projectIds, assigneeId: f.who || undefined, mode: f.mode || undefined, labelId: f.label || undefined, q: f.q || undefined, status: f.done ? [...BOARD_STATUSES] : BOARD_STATUSES.filter((s) => s !== "done") }, 1500);
  // Готовые — только за 7 дней, чтобы колонка не разрасталась
  const weekAgo = Date.now() - 7 * 86400000;
  const rows = tasks.filter((t) => t.status !== "done" || (t.doneAt && new Date(t.doneAt).getTime() > weekAgo));
  const href = (q: Record<string, string | undefined>) => { const s = new URLSearchParams(Object.entries({ ...f, ...q }).filter(([, v]) => v) as [string, string][]).toString(); return s ? `/tasks/board?${s}` : "/tasks/board"; };
  const Chip = ({ active, to, children }: { active: boolean; to: string; children: React.ReactNode }) => <Link href={to} className={`tab !py-1 !text-[13px] ${active ? "active" : "border-line"}`}>{children}</Link>;
  return (
    <>
      <TasksHeader userId={me.id} />
      <QuickAdd defaults={{ projectId: f.project, assigneeId: f.who }} />
      <div className="mb-3 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="help mr-1">Проект:</span>
          <Chip active={!f.project} to={href({ project: undefined })}>Все</Chip>
          {tree.filter((p) => p.depth === 0).map((p) => <Chip key={p.id} active={f.project === p.id} to={href({ project: p.id })}><span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />{p.name}</Chip>)}
          {f.project && tree.filter((p) => p.parentId === f.project).map((p) => <Chip key={p.id} active={false} to={href({ project: p.id })}>↳ {p.name}</Chip>)}
          {f.project && tree.find((p) => p.id === f.project)?.depth ? <Chip active to={href({ project: f.project })}>{tree.find((p) => p.id === f.project)!.name}</Chip> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="help mr-1">Кто:</span>
          <Chip active={!f.who} to={href({ who: undefined })}>Все</Chip>
          {people.map((p) => <Chip key={p.id} active={f.who === p.id} to={href({ who: p.id })}>{p.name.split(" ")[0]}</Chip>)}
          <span className="help ml-3 mr-1">Способ:</span>
          <Chip active={!f.mode} to={href({ mode: undefined })}>Все</Chip>
          {MODES.map((m) => <Chip key={m.key} active={f.mode === m.key} to={href({ mode: m.key })}>{m.icon} {m.short}</Chip>)}
          {labels.length > 0 && <><span className="help ml-3 mr-1">Метка:</span>{labels.map((l) => <Chip key={l.id} active={f.label === l.id} to={href({ label: f.label === l.id ? undefined : l.id })}><span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />{l.name}</Chip>)}</>}
          <form action="/tasks/board" className="ml-auto inline-flex items-center gap-1">
            {Object.entries(f).filter(([k, v]) => v && k !== "q").map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <input name="q" defaultValue={f.q ?? ""} placeholder="Поиск" className="input !w-40 !py-1 !text-[13px]" />
            <Chip active={!!f.done} to={href({ done: f.done ? undefined : "1" })}>{f.done ? "Готовые: за 7 дн" : "Показать готовые"}</Chip>
          </form>
        </div>
      </div>
      <Board tasks={rows} hideDone={!f.done} />
      <p className="help mt-2">Перетаскивайте карточки между колонками и внутри колонки. «На день» без даты получает план на сегодня.</p>
    </>
  );
}
