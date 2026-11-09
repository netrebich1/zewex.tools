import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { groupTasks, listTasks } from "@/lib/projects/tasks";
import { siteAccessWhere } from "@/lib/projects/access";
import { TasksList } from "@/components/projects/TasksList";

export const dynamic = "force-dynamic";

/** Все задачи по проектам: мои / все видимые. Просроченные сверху. */
export default async function ProjectTasksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const scope = sp(q, "scope") === "all" ? "all" : "mine";
  const accessId = sp(q, "site") ?? "";
  const done = sp(q, "done") === "1";
  const [rows, sites] = await Promise.all([
    listTasks(me, { scope, accessId: accessId || undefined, done }),
    prisma.siteAccess.findMany({ where: await siteAccessWhere(me), orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const groups = groupTasks(rows);
  const link = (patch: Record<string, string>) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries({ scope, site: accessId, done: done ? "1" : "", ...patch })) if (v) u.set(k, v); const s = u.toString(); return `/pinterest/projects/tasks${s ? `?${s}` : ""}`; };

  return (
    <>
      <PageHeader title="Задачи" subtitle="Задачи по всем проектам, которые вам видны. Добавляются в карточке проекта на вкладке «Задачи»." />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Link href={link({ scope: "mine" })} className={`tab ${scope === "mine" ? "active" : ""}`}>Мои</Link>
          <Link href={link({ scope: "all" })} className={`tab ${scope === "all" ? "active" : ""}`}>Все видимые</Link>
          <Link href={link({ done: done ? "" : "1" })} className={`tab ${done ? "active" : ""}`}>Показать сделанные</Link>
          <form method="get" action="/pinterest/projects/tasks" className="ml-auto flex gap-2">
            <input type="hidden" name="scope" value={scope} />
            {done && <input type="hidden" name="done" value="1" />}
            <select name="site" className="input py-1.5 text-[13.5px]" defaultValue={accessId}><option value="">Все сайты</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <button type="submit" className="btn-ghost btn-sm">Показать</button>
          </form>
        </div>
        {groups.length === 0 ? <p className="help">Задач нет.</p> : groups.map((g) => (
          <div key={g.key} className="mb-4">
            <div className={`mb-1 text-[12px] font-semibold uppercase tracking-wider ${g.key === "overdue" ? "text-danger" : "text-muted"}`}>{g.label} · {g.rows.length}</div>
            <TasksList rows={g.rows} showSite />
          </div>
        ))}
      </Card>
    </>
  );
}
