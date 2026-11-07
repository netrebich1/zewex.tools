import Link from "next/link";
import { requireTasks, taskPeople } from "@/lib/tasks/access";
import { dayView } from "@/lib/tasks/queries";
import { addDays, fmtDay, isYmd, todayYmd } from "@/lib/tasks/consts";
import { moveAllToDay } from "@/actions/tasks";
import { TasksHeader } from "@/components/tasks/Header";
import { QuickAdd } from "@/components/tasks/QuickAdd";
import { TaskLine } from "@/components/tasks/bits";
import { TkForm, Btn } from "@/components/tasks/TkForm";
import { Card, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Экран дня: Сегодня / Завтра / любой день. Мои задачи по умолчанию, можно смотреть коллегу или всех. */
export default async function TodayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireTasks();
  const params = await searchParams;
  const today = todayYmd();
  const d = sp(params, "d");
  const ymd = d && isYmd(d) ? d : today;
  const whoParam = sp(params, "who");
  const who = whoParam === "all" ? undefined : whoParam || me.id;
  const [v, people] = await Promise.all([dayView(ymd, who), taskPeople()]);
  const link = (q: Record<string, string | undefined>) => { const s = new URLSearchParams(Object.entries({ d: ymd === today ? undefined : ymd, who: whoParam, ...q }).filter(([, val]) => val) as [string, string][]).toString(); return s ? `/tasks/today?${s}` : "/tasks/today"; };
  const openLeft = v.planned.filter((t) => t.status !== "done").length + v.due.length;
  const Sec = ({ title, rows, tone }: { title: string; rows: typeof v.planned; tone?: string }) => rows.length ? (
    <Card title={<span className={tone}>{title} <span className="text-muted font-normal">({rows.length})</span></span>}>
      <div>{rows.map((t) => <TaskLine key={t.id} t={t} />)}</div>
    </Card>
  ) : null;

  return (
    <>
      <TasksHeader userId={me.id} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-xl bg-ink/5 p-1">
          {[{ k: addDays(today, -1), l: "Вчера" }, { k: today, l: "Сегодня" }, { k: addDays(today, 1), l: "Завтра" }].map((x) => (
            <Link key={x.k} href={link({ d: x.k === today ? undefined : x.k })} className={`rounded-lg px-3.5 py-1.5 text-[14px] font-semibold transition ${ymd === x.k ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>{x.l}</Link>
          ))}
        </div>
        <form action="/tasks/today" className="inline-flex items-center gap-1">
          {whoParam && <input type="hidden" name="who" value={whoParam} />}
          <input type="date" name="d" defaultValue={ymd} className="input !w-auto !py-1.5 !text-[13px]" />
          <button className="btn-ghost btn-sm">Показать</button>
        </form>
        <div className="ml-auto inline-flex gap-1 rounded-xl bg-ink/5 p-1">
          <Link href={link({ who: undefined })} className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold ${!whoParam ? "bg-surface shadow-[var(--shadow-card)]" : "text-muted"}`}>Мои</Link>
          {people.filter((p) => p.id !== me.id).map((p) => <Link key={p.id} href={link({ who: p.id })} className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold ${whoParam === p.id ? "bg-surface shadow-[var(--shadow-card)]" : "text-muted"}`}>{p.name.split(" ")[0]}</Link>)}
          <Link href={link({ who: "all" })} className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold ${whoParam === "all" ? "bg-surface shadow-[var(--shadow-card)]" : "text-muted"}`}>Все</Link>
        </div>
      </div>

      <QuickAdd defaults={{ planDate: ymd, assigneeId: who, status: "planned" }} placeholder={`Что сделать ${fmtDay(ymd)}? Enter — и задача в плане дня`} />

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4 min-w-0">
          <Card title={<>План на {fmtDay(ymd)} <span className="text-muted font-normal">({v.planned.length})</span></>} actions={openLeft > 0 && ymd <= today ? (
            <TkForm action={moveAllToDay} hidden={{ from: ymd, to: addDays(today, 1), assigneeId: who ?? null }} confirm="Перенести все незакрытые задачи этого дня на завтра?" inline><Btn className="btn-ghost btn-sm">Незакрытое → завтра</Btn></TkForm>
          ) : undefined}>
            {v.planned.length ? <div>{v.planned.map((t) => <TaskLine key={t.id} t={t} />)}</div> : <p className="help">На этот день ничего не запланировано. Добавьте строкой выше или перетащите из канбана в «На день».</p>}
            {v.planned.length > 5 && <p className="help mt-3">Больше пяти задач на день редко закрываются полностью. Оставьте 3–5 главных, остальное — на завтра.</p>}
          </Card>
          <Sec title="Срок в этот день, но не в плане" rows={v.due} tone="text-warn" />
          <Sec title="Просрочено" rows={v.overdue} tone="text-danger" />
          <Sec title="Пора пнуть — ждём ответа дольше срока" rows={v.waiting} tone="text-danger" />
        </div>
        <div className="space-y-4 min-w-0">
          <Card title={<>Сделано {fmtDay(ymd)} <span className="text-muted font-normal">({v.doneToday.length})</span></>}>
            {v.doneToday.length ? <div>{v.doneToday.map((t) => <TaskLine key={t.id} t={t} />)}</div> : <p className="help">Пока ничего.</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
