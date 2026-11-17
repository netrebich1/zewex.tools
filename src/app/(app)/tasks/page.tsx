import Link from "next/link";
import { requireTasks } from "@/lib/tasks/access";
import { stats } from "@/lib/tasks/queries";
import { fmtDay, fmtDateTime, modeLabel } from "@/lib/tasks/consts";
import { TasksHeader } from "@/components/tasks/Header";
import { QuickAdd } from "@/components/tasks/QuickAdd";
import { Avatar } from "@/components/tasks/bits";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

const KPI = "kpi min-w-0 !flex-row items-baseline justify-between gap-3 sm:!flex-col sm:items-stretch sm:justify-start sm:gap-1";
const V = "kpi-value tabular-nums !text-[22px] sm:!text-[30px]";

/** Главный дашборд: что в работе, что стоит, движение по проектам и людям, сделано за 14 дней. */
export default async function TasksHome() {
  const me = await requireTasks();
  const s = await stats();
  const maxBar = Math.max(1, ...s.weekly.map((w) => Math.max(w.done, w.created)));
  const stuck = (p: (typeof s.byProject)[number]) => p.open > 0 && p.doneWeek === 0 && p.createdWeek === 0;
  return (
    <>
      <TasksHeader userId={me.id} />
      <QuickAdd />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Link href="/tasks/today" className={`${KPI} card-hover`}><span className="help">На сегодня</span><span className={`${V} ${s.today ? "" : "text-muted"}`}>{s.today}</span></Link>
        <Link href="/tasks/board" className={`${KPI} card-hover`}><span className="help">В работе</span><span className={`${V} text-ok`}>{s.doing}</span></Link>
        <Link href="/tasks/board?mode=delegate" className={`${KPI} card-hover`}><span className="help">Ждём ответа</span><span className={`${V} text-warn`}>{s.waiting}</span></Link>
        <Link href="/tasks/today" className={`${KPI} card-hover`}><span className="help">Просрочено</span><span className={`${V} ${s.overdue ? "text-danger" : "text-muted"}`}>{s.overdue}</span></Link>
        <Link href="/tasks/today" className={`${KPI} card-hover`}><span className="help">Пора пнуть</span><span className={`${V} ${s.nudge ? "text-danger" : "text-muted"}`}>{s.nudge}</span></Link>
        <div className={KPI}><span className="help">Сделано за неделю</span><span className={`${V} text-ok`}>{s.doneWeek}</span></div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4 min-w-0">
          <Card title="По проектам" description="Открытые задачи и движение за 7 дней. Серым подсвечены проекты, где ничего не двигалось.">
            {s.byProject.length === 0 ? <p className="help">Проектов пока нет — <Link href="/tasks/projects" className="underline">создайте направления</Link>.</p> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Проект</th><th className="text-right">Открыто</th><th className="text-right col-sm">В работе</th><th className="text-right">Просрочено</th><th className="text-right">Сделано/нед</th><th className="text-right col-sm">Новых/нед</th><th className="col-md">Движение</th></tr></thead>
                <tbody>
                  {s.byProject.map((p) => (
                    <tr key={p.id || "none"} className={stuck(p) ? "text-muted" : ""}>
                      <td style={{ paddingLeft: `${12 + p.depth * 16}px` }}>
                        <span className="inline-flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />{p.id ? <Link href={`/tasks/projects/${p.id}`} className={`hover:underline ${p.depth === 0 ? "font-semibold" : ""}`}>{p.name}</Link> : p.name}{stuck(p) && <span className="badge bg-ink/5 text-muted">стоит</span>}</span>
                      </td>
                      <td className="text-right tabular-nums">{p.open}</td>
                      <td className="text-right tabular-nums col-sm">{p.doing}</td>
                      <td className={`text-right tabular-nums ${p.overdue ? "text-danger font-semibold" : ""}`}>{p.overdue || "—"}</td>
                      <td className={`text-right tabular-nums ${p.doneWeek ? "text-ok font-semibold" : ""}`}>{p.doneWeek || "—"}</td>
                      <td className="text-right tabular-nums col-sm">{p.createdWeek || "—"}</td>
                      <td className="col-md help">{p.lastMove ? fmtDateTime(p.lastMove) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>

          <Card title="Сделано и добавлено за 14 дней" description="Зелёное — закрыто, серое — создано. Если серого стабильно больше, бэклог растёт.">
            <div className="flex items-end gap-1.5 h-32">
              {s.weekly.map((w) => (
                <div key={w.ymd} className="flex-1 flex flex-col items-center justify-end gap-0.5 h-full" title={`${fmtDay(w.ymd)}: сделано ${w.done}, создано ${w.created}`}>
                  <div className="w-full flex items-end gap-px h-full">
                    <div className="flex-1 rounded-t bg-ok/80" style={{ height: `${(w.done / maxBar) * 100}%` }} />
                    <div className="flex-1 rounded-t bg-ink/15" style={{ height: `${(w.created / maxBar) * 100}%` }} />
                  </div>
                  <span className="text-[10px] text-muted tabular-nums">{w.ymd.slice(8)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-4 min-w-0">
          <Card title="По людям">
            <div className="space-y-2.5">
              {s.byPerson.map((p) => (
                <Link key={p.id || "none"} href={p.id ? `/tasks/board?who=${p.id}` : "/tasks/board"} className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-ink/5">
                  <Avatar name={p.name} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium truncate">{p.name}</p>
                    <p className="help">{p.open} открыто · {p.today} сегодня{p.overdue ? <span className="text-danger"> · {p.overdue} просрочено</span> : ""}</p>
                  </div>
                  <span className="text-ok font-bold tabular-nums" title="Сделано за неделю">+{p.doneWeek}</span>
                </Link>
              ))}
            </div>
          </Card>
          <Card title="По способу">
            <div className="space-y-1.5">
              {Object.entries(s.byMode).map(([k, n]) => (
                <div key={k} className="flex items-center gap-2 text-[14px]">
                  <span className="w-28 shrink-0">{modeLabel(k)}</span>
                  <div className="flex-1 h-2 rounded bg-ink/5 overflow-hidden"><div className="h-full bg-ink/40 rounded" style={{ width: `${s.open ? (n / s.open) * 100 : 0}%` }} /></div>
                  <span className="w-8 text-right tabular-nums">{n}</span>
                </div>
              ))}
            </div>
            <p className="help mt-3">Идей: {s.ideas} · Без движения 14+ дней: <span className={s.stale ? "text-warn font-semibold" : ""}>{s.stale}</span></p>
          </Card>
        </div>
      </div>
    </>
  );
}
