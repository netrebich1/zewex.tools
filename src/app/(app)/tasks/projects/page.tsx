import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireTasks, taskPeople } from "@/lib/tasks/access";
import { projectTree } from "@/lib/tasks/queries";
import { OPEN_STATUSES } from "@/lib/tasks/consts";
import { deleteProject, saveProject } from "@/actions/tasks";
import { TasksHeader } from "@/components/tasks/Header";
import { Avatar } from "@/components/tasks/bits";
import { TkForm, Btn } from "@/components/tasks/TkForm";
import { Card, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

const COLORS = ["#e11d48", "#f97316", "#f59e0b", "#16a34a", "#0ea5e9", "#2563eb", "#7c3aed", "#db2777", "#64748b", "#0f766e"];

/** Проекты: дерево направлений и подпроектов, создание/правка, ответственные, цвета. */
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireTasks();
  const params = await searchParams;
  const showArchived = !!sp(params, "archived");
  const editId = sp(params, "edit");
  const [tree, people, counts] = await Promise.all([
    projectTree({ archived: true }), taskPeople(),
    prisma.tkTask.groupBy({ by: ["projectId"], where: { status: { in: OPEN_STATUSES } }, _count: { _all: true } }),
  ]);
  const cnt = (id: string) => counts.find((c) => c.projectId === id)?._count._all ?? 0;
  const edit = editId ? tree.find((p) => p.id === editId) : null;
  const visible = tree.filter((p) => showArchived || !p.archived);
  return (
    <>
      <TasksHeader userId={me.id} />
      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        <Card title="Направления и проекты" description="Верхний уровень — направление (Pinterest, Сайты…), внутри — проекты и подпроекты. У каждого свой ответственный, цвет и дашборд." actions={<Link href={showArchived ? "/tasks/projects" : "/tasks/projects?archived=1"} className="btn-ghost btn-sm">{showArchived ? "Скрыть архив" : "Показать архив"}</Link>}>
          {visible.length === 0 ? <p className="help">Проектов нет. Создайте первое направление в форме справа.</p> : (
            <div className="divide-y divide-line/70">
              {visible.map((p) => (
                <div key={p.id} className={`flex items-center gap-3 py-2 ${p.archived ? "opacity-50" : ""}`} style={{ paddingLeft: p.depth * 22 }}>
                  <span className="inline-block h-3 w-3 rounded-full shrink-0" style={{ background: p.color }} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/tasks/projects/${p.id}`} className={`hover:underline ${p.depth === 0 ? "text-[15px] font-bold" : "text-[14px] font-medium"}`}>{p.name}</Link>
                    {p.archived && <span className="badge bg-ink/5 text-muted ml-2">архив</span>}
                    {p.description && <p className="help truncate">{p.description}</p>}
                  </div>
                  <span className="help tabular-nums" title="Открытых задач">{cnt(p.id)}</span>
                  <Avatar name={people.find((u) => u.id === p.ownerId)?.name ?? null} size={22} />
                  <Link href={`/tasks/projects?edit=${p.id}${showArchived ? "&archived=1" : ""}`} className="btn-ghost btn-sm">Изменить</Link>
                </div>
              ))}
            </div>
          )}
        </Card>
        <div className="space-y-4">
          <Card title={edit ? `Изменить: ${edit.name}` : "Новый проект"} actions={edit ? <Link href="/tasks/projects" className="btn-ghost btn-sm">Новый</Link> : undefined}>
            <TkForm key={edit?.id ?? "new"} action={saveProject} hidden={{ id: edit?.id }} reset={!edit} redirectTo={edit ? "/tasks/projects" : undefined} className="space-y-3">
              <div><label className="label">Название</label><input name="name" defaultValue={edit?.name ?? ""} required maxLength={120} className="input" placeholder="Например: Кулинарные сайты" /></div>
              <div>
                <label className="label">Внутри чего</label>
                <select name="parentId" defaultValue={edit?.parentId ?? sp(params, "parent") ?? ""} className="input">
                  <option value="">— направление верхнего уровня —</option>
                  {tree.filter((p) => !p.archived && p.id !== edit?.id && !p.path.startsWith((edit?.path ?? "\u0000") + " / ")).map((p) => <option key={p.id} value={p.id}>{"  ".repeat(p.depth)}{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Цвет</label>
                <div className="flex flex-wrap gap-1.5">
                  {COLORS.map((c) => <label key={c} className="h-7 w-7 rounded-full cursor-pointer ring-offset-2 ring-offset-surface has-[:checked]:ring-2 has-[:checked]:ring-ink" style={{ background: c }}><input type="radio" name="color" value={c} defaultChecked={(edit?.color ?? COLORS[8]) === c} className="sr-only" /></label>)}
                </div>
              </div>
              <div><label className="label">Ответственный</label><select name="ownerId" defaultValue={edit?.ownerId ?? ""} className="input"><option value="">— никто —</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><p className="help mt-1">Новые задачи проекта по умолчанию достаются ему.</p></div>
              <div><label className="label">Описание</label><textarea name="description" rows={2} defaultValue={edit?.description ?? ""} className="input" placeholder="Цель проекта, ссылки" /></div>
              {edit && <label className="inline-flex items-center gap-2 text-[14px]"><input type="checkbox" name="archived" value="1" defaultChecked={edit.archived} /> В архиве (не показывать в списках)</label>}
              <div className="flex gap-2"><Btn className="btn-primary">{edit ? "Сохранить" : "Создать"}</Btn></div>
            </TkForm>
            {edit && (
              <TkForm action={deleteProject} hidden={{ id: edit.id }} confirm={`Удалить проект «${edit.name}»? Возможно только без задач и подпроектов.`} redirectTo="/tasks/projects" className="mt-3">
                <Btn className="btn-ghost btn-sm text-danger">Удалить проект</Btn>
              </TkForm>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
