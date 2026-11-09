import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireTasks, taskPeople } from "@/lib/tasks/access";
import { projectTree } from "@/lib/tasks/queries";
import { dateToYmd, fmtDay, modeLabel } from "@/lib/tasks/consts";
import { describeRule } from "@/lib/tasks/routines";
import { deleteRoutine } from "@/actions/tasks";
import { TasksHeader } from "@/components/tasks/Header";
import { RoutineForm, type RoutineRow } from "@/components/tasks/RoutineForm";
import { Avatar } from "@/components/tasks/bits";
import { TkForm, Btn } from "@/components/tasks/TkForm";
import { Card, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Регламент: повторяющиеся процессы менеджмента. Воркер создаёт из них задачи в нужный день. */
export default async function RoutinesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireTasks();
  const params = await searchParams;
  const editId = sp(params, "edit");
  const [rows, people, tree, spawned] = await Promise.all([
    prisma.tkRoutine.findMany({ orderBy: [{ active: "desc" }, { nextAt: "asc" }] }), taskPeople(), projectTree(),
    prisma.tkTask.groupBy({ by: ["routineId"], where: { routineId: { not: null } }, _count: { _all: true } }),
  ]);
  const list: RoutineRow[] = rows.map((r) => ({ id: r.id, title: r.title, description: r.description, rule: r.rule, ruleArg: r.ruleArg, steps: Array.isArray(r.steps) ? (r.steps as string[]) : [], mode: r.mode, priority: r.priority, assigneeId: r.assigneeId, projectId: r.projectId, active: r.active, nextAt: dateToYmd(r.nextAt) }));
  const edit = list.find((r) => r.id === editId) ?? null;
  const spawnedCount = (id: string) => spawned.find((s) => s.routineId === id)?._count._all ?? 0;
  return (
    <>
      <TasksHeader userId={me.id} />
      <div className="grid gap-4 lg:grid-cols-[1fr_440px]">
        <Card title="Регулярные процессы" description="Каждое число проверить офферы, по понедельникам созвон с сотрудниками, раз в 3 дня глянуть ключи. В нужный день задача появляется сама в плане дня с чеклистом шагов и попадает в утренний дайджест.">
          {list.length === 0 ? <p className="help">Регламентов пока нет. Добавьте первый справа.</p> : (
            <div className="divide-y divide-line/70">
              {list.map((r) => (
                <div key={r.id} className={`py-3 flex items-start gap-3 ${r.active ? "" : "opacity-50"}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-semibold [overflow-wrap:anywhere]">{r.title}{!r.active && <span className="badge bg-ink/5 text-muted ml-2">выключен</span>}</p>
                    <p className="help mt-0.5">
                      {describeRule(r.rule, r.ruleArg)} · {modeLabel(r.mode)}
                      {r.projectId && <> · {tree.find((p) => p.id === r.projectId)?.name}</>}
                      {r.nextAt && r.active && <> · следующая: <b className="text-ink">{fmtDay(r.nextAt)}</b></>}
                      {spawnedCount(r.id) > 0 && <> · создано задач: {spawnedCount(r.id)}</>}
                    </p>
                    {r.steps.length > 0 && <ol className="mt-1.5 list-decimal pl-5 text-[13px] text-ink-2 space-y-0.5">{r.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
                  </div>
                  <Avatar name={people.find((p) => p.id === r.assigneeId)?.name ?? null} size={24} />
                  <Link href={`/tasks/routines?edit=${r.id}`} className="btn-ghost btn-sm">Изменить</Link>
                </div>
              ))}
            </div>
          )}
        </Card>
        <div className="space-y-4">
          <Card title={edit ? "Изменить регламент" : "Новый регламент"} actions={edit ? <Link href="/tasks/routines" className="btn-ghost btn-sm">Новый</Link> : undefined}>
            <RoutineForm key={edit?.id ?? "new"} r={edit} people={people} projects={tree} onDone={edit ? "/tasks/routines" : undefined} />
            {edit && <TkForm action={deleteRoutine} hidden={{ id: edit.id }} confirm={`Удалить регламент «${edit.title}»? Уже созданные задачи останутся.`} redirectTo="/tasks/routines" className="mt-3"><Btn className="btn-ghost btn-sm text-danger">Удалить регламент</Btn></TkForm>}
          </Card>
        </div>
      </div>
    </>
  );
}
