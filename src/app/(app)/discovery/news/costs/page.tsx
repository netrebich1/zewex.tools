import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { NewsNav } from "@/components/news/NewsNav";
import { requireProject } from "@/lib/news/access";
import { COST_OPS, type CostOp } from "@/lib/news/llm";
import { kyivDayStart } from "@/lib/news/query";
import { BASE_PATH } from "@/lib/news/types";
import { fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PERIODS = [7, 30, 90] as const;
const OPS = Object.keys(COST_OPS) as CostOp[];
const kyivDay = (d: Date) => d.toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 10);
const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", weekday: "short" });
const fmtN = (n: number) => n.toLocaleString("ru-RU");
const money = (v: number) => (v ? fmtMoney(v) : "—");

type Agg = { usd: number; calls: number; fails: number; inTok: number; outTok: number };
const empty = (): Agg => ({ usd: 0, calls: 0, fails: 0, inTok: 0, outTok: 0 });
const add = (a: Agg, r: { costUsd: number; ok: boolean; inputTokens: number; outputTokens: number }) => {
  a.usd += r.costUsd;
  a.calls++;
  if (!r.ok) a.fails++;
  a.inTok += r.inputTokens;
  a.outTok += r.outputTokens;
};

/** Расходы модуля по дням и статьям (журнал NewsCost: каждый вызов модели и ресёрч). */
export default async function NewsCostsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const { project, list } = await requireProject(me, sp(q, "project"));
  if (!project) return <Empty title="Проектов пока нет" hint="Создайте проект в настройках." action={<Link href={`${BASE_PATH}/settings`} className="btn-brand">Настройки</Link>} />;
  const days = PERIODS.find((p) => String(p) === sp(q, "d")) ?? 30;
  const op = OPS.find((o) => o === sp(q, "op"));
  const since = kyivDayStart(days - 1);
  const rows = await prisma.newsCost.findMany({
    where: { projectId: project.id, createdAt: { gte: since } },
    select: { op: true, model: true, costUsd: true, ok: true, inputTokens: true, outputTokens: true, createdAt: true },
  });
  const link = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams({ project: project.id });
    for (const [k, v] of Object.entries({ d: days === 30 ? undefined : String(days), op, ...patch })) if (v) u.set(k, v);
    return `${BASE_PATH}/costs?${u.toString()}`;
  };

  // Дни × статьи, итоги по статьям и по моделям.
  const byDay = new Map<string, Map<string, Agg>>();
  const byOp = new Map<string, Agg>();
  const byModel = new Map<string, Agg & { op: string; model: string }>();
  const total = empty();
  for (const r of rows) {
    const d = kyivDay(r.createdAt);
    const day = byDay.get(d) ?? new Map<string, Agg>();
    byDay.set(d, day);
    for (const key of [r.op, "_all"]) {
      const a = day.get(key) ?? empty();
      add(a, r);
      day.set(key, a);
    }
    const o = byOp.get(r.op) ?? empty();
    add(o, r);
    byOp.set(r.op, o);
    if (r.op !== "research") add(total, r);
    const mk = `${r.op}|${r.model ?? "—"}`;
    const m = byModel.get(mk) ?? { ...empty(), op: r.op, model: r.model ?? "—" };
    add(m, r);
    byModel.set(mk, m);
  }
  const dayList: string[] = [];
  for (let i = 0; i < days; i++) dayList.push(kyivDay(new Date(kyivDayStart(i).getTime() + 3 * 3600_000)));
  const activeOps = OPS.filter((o) => byOp.has(o));
  const shownOps = op ? [op] : activeOps;
  const today = byDay.get(dayList[0])?.get("_all")?.usd ?? 0;
  const yesterday = byDay.get(dayList[1])?.get("_all")?.usd ?? 0;
  const paidDays = dayList.filter((d) => byDay.has(d)).length;
  const firstAt = await prisma.newsCost.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });

  return (
    <>
      <NewsNav projects={list.map((p) => ({ id: p.id, name: p.name }))} current={project.id} />
      <PageHeader
        title="Расходы"
        subtitle="Каждый вызов модели записывается со статьёй расхода: классификация, эмбеддинги, склейка дублей, суть карточек, углы, ТЗ, разметка просмотров. Ресёрч в вебе бесплатный, показан счётчиком. Дни — по Киеву."
        actions={<Link href={`${BASE_PATH}/runs?project=${project.id}`} className="btn-ghost">Прогоны</Link>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[14px]">
        <span className="help">Период:</span>
        {PERIODS.map((p) => <Link key={p} href={link({ d: p === 30 ? undefined : String(p) })} className={`tab ${days === p ? "active" : ""}`}>{p} дней</Link>)}
        <span className="mx-1 h-4 w-px bg-line" />
        <span className="help">Статья:</span>
        <Link href={link({ op: undefined })} className={`tab ${!op ? "active" : ""}`}>Все</Link>
        {activeOps.map((o) => <Link key={o} href={link({ op: o })} className={`tab ${op === o ? "active" : ""}`}>{COST_OPS[o]}</Link>)}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { label: "Сегодня", value: fmtMoney(today) },
          { label: "Вчера", value: fmtMoney(yesterday) },
          { label: `За ${days} дней`, value: fmtMoney(total.usd) },
          { label: "В среднем за день", value: fmtMoney(paidDays ? total.usd / paidDays : 0) },
          { label: "Вызовов модели", value: fmtN(total.calls) },
        ].map((k) => (
          <div key={k.label} className="kpi">
            <div className="kpi-value">{k.value}</div>
            <div className="help">{k.label}</div>
          </div>
        ))}
      </div>

      {rows.length === 0 ? <Empty title="За период расходов нет" hint="Журнал заполняется с каждым прогоном и кнопками углов и ТЗ." /> : (
        <div className="space-y-5">
          <Card title="По статьям расхода" description={`Доля — от всего платного расхода за ${days} дней. Токены — вход / выход.`}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Статья</th><th className="col-sm">Сумма</th><th className="col-sm">Доля</th><th className="col-sm">Вызовов</th><th className="col-sm">За вызов</th><th className="col-md">Токены</th><th className="col-sm">Ошибок</th></tr></thead>
                <tbody>
                  {activeOps.map((o) => {
                    const a = byOp.get(o)!;
                    return (
                      <tr key={o}>
                        <td><Link href={link({ op: o })} className="hover:underline">{COST_OPS[o]}</Link></td>
                        <td className="col-sm tabular-nums font-medium">{o === "research" ? "$0" : fmtMoney(a.usd)}</td>
                        <td className="col-sm tabular-nums">{total.usd && o !== "research" ? `${Math.round((a.usd / total.usd) * 100)}%` : "—"}</td>
                        <td className="col-sm tabular-nums">{fmtN(a.calls)}</td>
                        <td className="col-sm tabular-nums">{o === "research" ? "—" : fmtMoney(a.usd / a.calls)}</td>
                        <td className="col-md help tabular-nums">{a.inTok || a.outTok ? `${fmtN(a.inTok)} / ${fmtN(a.outTok)}` : "—"}</td>
                        <td className={`col-sm tabular-nums ${a.fails ? "text-danger" : "text-muted"}`}>{a.fails || "—"}</td>
                      </tr>
                    );
                  })}
                  <tr className="font-semibold"><td>Итого</td><td className="col-sm tabular-nums">{fmtMoney(total.usd)}</td><td className="col-sm">100%</td><td className="col-sm tabular-nums">{fmtN(total.calls)}</td><td colSpan={3} /></tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="По дням" description={op ? `Только «${COST_OPS[op]}».` : "Строка — день, столбцы — статьи. Ресёрч — сколько раз искали материалы (бесплатно)."}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="col-md">День</th>
                    {shownOps.map((o) => <th key={o} className="col-sm">{COST_OPS[o].split(" (")[0]}</th>)}
                    {!op && <th className="col-sm">Итого</th>}
                  </tr>
                </thead>
                <tbody>
                  {dayList.map((d) => {
                    const day = byDay.get(d);
                    return (
                      <tr key={d} className={day ? "" : "opacity-50"}>
                        <td className="col-md tabular-nums">{fmtDay(d)}</td>
                        {shownOps.map((o) => {
                          const a = day?.get(o);
                          return (
                            <td key={o} className="col-sm tabular-nums">
                              {o === "research" ? (a ? `${a.calls} раз` : "—") : money(a?.usd ?? 0)}
                              {a && o !== "research" && <div className="help">{fmtN(a.calls)} выз.</div>}
                            </td>
                          );
                        })}
                        {!op && <td className="col-sm tabular-nums font-medium">{money(day?.get("_all")?.usd ?? 0)}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="По моделям" description="Какая модель на что тратит.">
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Модель</th><th className="col-md">Статья</th><th className="col-sm">Сумма</th><th className="col-sm">Вызовов</th><th className="col-md">Токены</th></tr></thead>
                <tbody>
                  {[...byModel.values()].filter((m) => m.op !== "research" && (!op || m.op === op)).sort((a, b) => b.usd - a.usd).map((m) => (
                    <tr key={`${m.op}|${m.model}`}>
                      <td className="text-[13px]">{m.model}</td>
                      <td className="col-md">{COST_OPS[m.op as CostOp] ?? m.op}</td>
                      <td className="col-sm tabular-nums font-medium">{fmtMoney(m.usd)}</td>
                      <td className="col-sm tabular-nums">{fmtN(m.calls)}</td>
                      <td className="col-md help tabular-nums">{fmtN(m.inTok)} / {fmtN(m.outTok)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="help">
            Журнал ведётся с {firstAt ? firstAt.createdAt.toLocaleDateString("ru-RU", { timeZone: "Europe/Kyiv" }) : "—"}. Расход до 30.10 восстановлен из общего журнала портала: там склейка дублей учтена вместе с классификацией, а суть карточек, сделанная перед ТЗ, — вместе с ТЗ.
          </p>
        </div>
      )}
    </>
  );
}
