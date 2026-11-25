import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireFinance } from "@/lib/finance/access";
import { financeContext } from "@/lib/finance/page";
import { asPeriod, dateWhere, incomeSummary, PERIODS, periodRange, userNames, type IncomeRow } from "@/lib/finance/report";
import { fmtAmount } from "@/lib/finance/currency";
import { FinanceNav } from "@/components/finance/FinanceNav";
import { OpForm } from "@/components/finance/OpForm";
import { OpsList } from "@/components/finance/OpsList";
import { Card, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";
const PAGE = 200;

/** Доходы: сколько пришло по направлениям и категориям, кому на счёт, и сами поступления. По умолчанию — за всё время. */
export default async function FinanceIncome({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireFinance();
  const params = await searchParams;
  const ctx = await financeContext(me);
  const { refs, cur } = ctx;
  const period = asPeriod(sp(params, "p"), "all");
  const range = periodRange(period);
  const [sum, ops] = await Promise.all([
    incomeSummary(range, refs.partners, refs.dirs, refs.cats),
    prisma.finOp.findMany({ where: { deletedAt: null, type: "INCOME", ...dateWhere(range) }, include: { counterparty: { select: { name: true } } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: PAGE }),
  ]);
  const names = await userNames(ops.flatMap((o) => [o.createdById, o.updatedById]));
  const f = (eur: number) => fmtAmount(eur * ctx.factor, cur);
  const back = period === "all" ? "/finance/income" : `/finance/income?p=${period}`;

  const Table = ({ head, rows }: { head: string; rows: IncomeRow[] }) => (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>{head}</th>{refs.partners.map((p) => <th key={p.id} className="text-right">{p.name}</th>)}<th className="text-right">Всего</th></tr></thead>
      <tbody>
        {rows.flatMap((r) => [r, ...r.children].map((x, i) => (
          <tr key={`${r.id}-${x.id}-${i}`}>
            <td className={i ? "pl-7 text-ink-2" : "font-medium"}>{x.name}</td>
            {refs.partners.map((p) => <td key={p.id} className="text-right tabular-nums">{x.per[p.id] ? f(x.per[p.id]) : "—"}</td>)}
            <td className={`text-right tabular-nums ${i ? "" : "font-medium"}`}>{f(x.total)}</td>
          </tr>
        )))}
        <tr className="font-semibold"><td>Всего</td>{refs.partners.map((p) => <td key={p.id} className="text-right tabular-nums">{f(sum.all.per[p.id] ?? 0)}</td>)}<td className="text-right tabular-nums text-ok">{f(sum.all.total)}</td></tr>
      </tbody>
    </table></div>
  );

  return (
    <>
      <FinanceNav cur={cur} />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {PERIODS.map((p) => <Link key={p.key} href={p.key === "all" ? "/finance/income" : `/finance/income?p=${p.key}`} className={`tab ${p.key === period ? "active" : ""}`}>{p.label}</Link>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        <div className="space-y-4 min-w-0">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="kpi min-w-0"><span className="help">Доходы всего</span><span className="kpi-value tabular-nums text-ok">{f(sum.all.total)}</span><span className="help">поступлений: {sum.all.count}</span></div>
            {refs.partners.map((p) => (
              <div key={p.id} className="kpi min-w-0"><span className="help">Пришло на счёт: {p.name}</span><span className="kpi-value tabular-nums">{f(sum.all.per[p.id] ?? 0)}</span></div>
            ))}
          </div>
          {sum.all.count === 0 ? (
            <Card><p className="help">За этот период доходов нет. Чтобы записать поступление, выберите «Доход» в форме{period === "all" ? "" : " или откройте период «Всё время»"}.</p></Card>
          ) : (
            <>
              <Card title="Доходы по направлениям" description="В столбцах — кому деньги пришли на счёт. Эти суммы учтены в расчёте между партнёрами на «Обзоре».">
                <Table head="Направление" rows={sum.tree} />
              </Card>
              <Card title="Доходы по категориям">
                <Table head="Категория" rows={sum.cats} />
              </Card>
              <Card title={`Поступления: ${sum.all.count}`} description={sum.all.count > PAGE ? `Показаны последние ${PAGE}.` : undefined} actions={<Link href={`/finance/ops?type=INCOME&p=${period}`} className="btn-ghost btn-sm">В журнале</Link>}>
                <OpsList ops={ops} refs={refs} cur={cur} factor={ctx.factor} names={names} back={back} />
              </Card>
            </>
          )}
        </div>
        <div className="lg:sticky lg:top-20 self-start">
          <Card title="Добавить доход"><OpForm refs={ctx.form} myPartnerId={ctx.myPartnerId} initial={{ type: "INCOME" }} /></Card>
        </div>
      </div>
    </>
  );
}
