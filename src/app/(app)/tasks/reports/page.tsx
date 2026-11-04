import Link from "next/link";
import { requireTasks, allPeople } from "@/lib/tasks/access";
import { listReports } from "@/lib/tasks/queries";
import { addDays, fmtDateTime, fmtDay, isYmd, todayYmd } from "@/lib/tasks/consts";
import { deleteReport } from "@/actions/tasks";
import { TasksHeader } from "@/components/tasks/Header";
import { Avatar } from "@/components/tasks/bits";
import { TkForm, Btn } from "@/components/tasks/TkForm";
import { Card, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Отчёты сотрудников из Telegram (голосовые и текст): кто, когда, что сделал; активность по дням и людям. */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireTasks();
  const params = await searchParams;
  const today = todayYmd();
  const d = sp(params, "d");
  const period = sp(params, "p") ?? (d ? "day" : "14");
  const from = period === "day" && d && isYmd(d) ? d : period === "7" ? addDays(today, -6) : period === "30" ? addDays(today, -29) : addDays(today, -13);
  const to = period === "day" && d && isYmd(d) ? d : today;
  const who = sp(params, "who");
  const [rows, people] = await Promise.all([listReports({ from, to, userId: who || undefined }), allPeople()]);
  const days: string[] = [];
  for (let x = from; x <= to; x = addDays(x, 1)) days.push(x);
  const reporters = people.filter((p) => rows.some((r) => r.userId === p.id));
  const cost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const byDay = (uid: string, ymd: string) => rows.filter((r) => r.userId === uid && r.date === ymd).reduce((s, r) => s + r.items.length, 0);
  const maxItems = Math.max(1, ...reporters.flatMap((p) => days.map((x) => byDay(p.id, x))));
  const link = (q: Record<string, string | undefined>) => { const s = new URLSearchParams(Object.entries({ p: period === "14" ? undefined : period, d, who, ...q }).filter(([, v]) => v) as [string, string][]).toString(); return s ? `/tasks/reports?${s}` : "/tasks/reports"; };
  const grouped = days.slice().reverse().map((ymd) => ({ ymd, rows: rows.filter((r) => r.date === ymd) })).filter((g) => g.rows.length);
  return (
    <>
      <TasksHeader userId={me.id} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-xl bg-ink/5 p-1">
          {[["7", "7 дней"], ["14", "14 дней"], ["30", "30 дней"]].map(([k, l]) => <Link key={k} href={link({ p: k, d: undefined })} className={`rounded-lg px-3.5 py-1.5 text-[14px] font-semibold ${period === k ? "bg-surface shadow-[var(--shadow-card)]" : "text-muted"}`}>{l}</Link>)}
        </div>
        <form action="/tasks/reports" className="inline-flex items-center gap-1"><input type="hidden" name="p" value="day" />{who && <input type="hidden" name="who" value={who} />}<input type="date" name="d" defaultValue={period === "day" ? from : today} className="input !w-auto !py-1.5 !text-[13px]" /><button className="btn-ghost btn-sm">День</button></form>
        <div className="ml-auto inline-flex gap-1 rounded-xl bg-ink/5 p-1">
          <Link href={link({ who: undefined })} className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold ${!who ? "bg-surface shadow-[var(--shadow-card)]" : "text-muted"}`}>Все</Link>
          {people.filter((p) => rows.some((r) => r.userId === p.id) || p.id === who).map((p) => <Link key={p.id} href={link({ who: p.id })} className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold ${who === p.id ? "bg-surface shadow-[var(--shadow-card)]" : "text-muted"}`}>{p.name.split(" ")[0]}</Link>)}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4 min-w-0">
          {grouped.length === 0 && <Card title="Отчётов нет"><p className="help">Сотрудник записывает боту голосовое «что сделал за сегодня» — здесь появляется расшифровка и пункты. Привязка бота — в <Link href="/tasks/settings" className="underline">настройках</Link>.</p></Card>}
          {grouped.map((g) => (
            <Card key={g.ymd} title={<span className="capitalize">{fmtDay(g.ymd)}</span>} description={g.ymd}>
              <div className="space-y-4">
                {g.rows.map((r) => (
                  <div key={r.id} className="flex items-start gap-3">
                    <Avatar name={r.user} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-semibold">{r.user} <span className="help font-normal">· {fmtDateTime(r.createdAt)} · {r.source === "voice" ? `🎤 ${r.audioSec ?? 0} с` : "✍️ текст"}{r.costUsd ? ` · $${r.costUsd.toFixed(4)}` : ""}</span></p>
                      <ul className="mt-1 space-y-0.5 text-[14.5px]">{r.items.map((it, i) => <li key={i} className="flex gap-2"><span className="text-ok">•</span><span className="[overflow-wrap:anywhere]">{it}</span></li>)}</ul>
                      {r.source === "voice" && <details className="mt-1.5 help"><summary className="cursor-pointer list-none select-none">Расшифровка</summary><p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{r.transcript}</p></details>}
                    </div>
                    <TkForm action={deleteReport} hidden={{ id: r.id }} confirm="Удалить этот отчёт?" inline><Btn className="btn-ghost btn-sm text-danger !px-2">✕</Btn></TkForm>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
        <div className="space-y-4 min-w-0">
          <Card title="Активность" description="Квадрат — день, насыщенность — сколько пунктов в отчёте.">
            {reporters.length === 0 ? <p className="help">Пока нет данных.</p> : (
              <div className="space-y-3">
                {reporters.map((p) => {
                  const total = rows.filter((r) => r.userId === p.id).reduce((s, r) => s + r.items.length, 0);
                  const daysWith = days.filter((x) => byDay(p.id, x) > 0).length;
                  return (
                    <div key={p.id}>
                      <div className="flex items-center gap-2 mb-1"><Avatar name={p.name} size={22} /><span className="text-[14px] font-medium flex-1 truncate">{p.name}</span><span className="help">{daysWith}/{days.length} дн · {total} пунктов</span></div>
                      <div className="flex gap-0.5">{days.map((x) => { const n = byDay(p.id, x); return <div key={x} className="flex-1 h-5 rounded-sm" title={`${fmtDay(x)}: ${n}`} style={{ background: n ? `rgba(21,128,61,${0.25 + 0.75 * (n / maxItems)})` : "var(--color-line)" }} />; })}</div>
                    </div>
                  );
                })}
                <p className="help">Нет отчёта в рабочий день — повод спросить. Расход на расшифровку за период: ${cost.toFixed(3)}.</p>
              </div>
            )}
          </Card>
          <Card title="Как сдавать отчёт">
            <ol className="list-decimal pl-5 text-[14px] space-y-1">
              <li>Сотрудник открывает бота и присылает <code>/start КОД</code> (код — в настройках).</li>
              <li>Вечером записывает голосовое: что сделал, что в планах, где застрял.</li>
              <li>Бот расшифровывает, выделяет пункты и показывает здесь. Стоимость: около 0,3 цента за минуту записи.</li>
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
