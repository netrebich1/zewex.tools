import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireFinance } from "@/lib/finance/access";
import { financeContext } from "@/lib/finance/page";
import { asPeriod, debtState, dirFamily, monthly, PERIODS, periodRange, periodSummary, pnlOf, type DirRow } from "@/lib/finance/report";
import { fmtAmount } from "@/lib/finance/currency";
import { FinanceNav } from "@/components/finance/FinanceNav";
import { DirTabs } from "@/components/finance/DirTabs";
import { OpForm } from "@/components/finance/OpForm";
import { OpsList } from "@/components/finance/OpsList";
import { Card, Empty, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

type Fmt = (v: number, o?: { sign?: boolean }) => string;
// На телефоне плитка — строка «подпись … сумма». `!` нужен: .kpi/.kpi-value вне слоёв и перебивают утилиты.
const KPI = "kpi min-w-0 !flex-row items-baseline justify-between gap-3 sm:!flex-col sm:items-stretch sm:justify-start sm:gap-1";
const KPI_VALUE = "kpi-value tabular-nums !text-[22px] sm:!text-[30px]";

/**
 * Обзор. Вкладка «Вся Wexora»: кто кому должен, итоги по направлениям. Вкладка направления (`?d=`):
 * итоги только по нему — подразделы, категории, кто сколько внёс, его операции, форма сразу с этим направлением.
 */
export default async function FinanceHome({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireFinance();
  const params = await searchParams;
  const ctx = await financeContext(me);
  const { refs, cur, money } = ctx;
  const period = asPeriod(sp(params, "p"));
  const tops = refs.parents.filter((d) => !d.archived);
  const dir = tops.find((d) => d.id === sp(params, "d"));

  if (refs.partners.length < 2) {
    return (
      <>
        <FinanceNav cur={cur} />
        <Empty title="Сначала укажите партнёров" hint="Кто вносит деньги и делит расходы (например, вы и Никита, 50/50). Это делается один раз." action={<Link href="/finance/settings#partners" className="btn-brand">Указать партнёров</Link>} />
      </>
    );
  }

  const family = dir ? dirFamily(refs.dirs, dir.id) : undefined;
  const [debt, sum, months, recent] = await Promise.all([
    dir ? null : debtState(refs.partners),
    periodSummary(periodRange(period), refs.partners, refs.dirs, family),
    monthly(family),
    prisma.finOp.findMany({ where: { deletedAt: null, ...(family ? { directionId: { in: family } } : {}) }, include: { counterparty: { select: { name: true } } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: dir ? 15 : 10 }),
  ]);
  const f: Fmt = (eur, o = {}) => fmtAmount(money(eur), cur, o);
  const settle = debt?.plan[0];
  const settling = !dir && !!sp(params, "settle") && !!settle;
  const link = (q: Record<string, string | undefined>) => {
    const s = new URLSearchParams(Object.entries({ d: dir?.id, p: period === "month" ? undefined : period, ...q }).filter(([, v]) => v) as [string, string][]).toString();
    return s ? `/finance?${s}` : "/finance";
  };
  const subs = sum.tree[0]?.children ?? [];
  const pnl = pnlOf(sum.perCat, refs.cats);
  const catName = new Map(refs.cats.map((c) => [c.id, c.name]));
  const cats = [...sum.perCat].map(([id, v]) => ({ name: id ? catName.get(id) ?? "?" : "Без категории", ...v })).sort((a, b) => b.expense + b.income - a.expense - a.income);

  return (
    <>
      <FinanceNav cur={cur} />
      <DirTabs dirs={tops} active={dir?.id} href={(id) => link({ d: id })} />
      {/* Форма на телефоне в самом низу — ссылка к ней сверху. */}
      <a href="#add" className="btn-brand w-full mb-4 lg:!hidden">Добавить операцию</a>
      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        <div className="space-y-4 min-w-0">
          {debt && (
            <section className={`card p-5 sm:p-6 ${settle ? "border-warn/40" : ""}`}>
              <p className="text-[12.5px] font-semibold uppercase tracking-wider text-muted">Расчёт между партнёрами · за всё время</p>
              {settle ? (
                <>
                  {debt.plan.map((t) => (
                    <p key={t.fromId + t.toId} className="mt-2 text-[22px] sm:text-[28px] font-bold tracking-tight leading-tight">
                      {t.from} должен {t.to} <span className="text-warn whitespace-nowrap">{f(t.amount)}</span>
                    </p>
                  ))}
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Link href={`${link({ settle: "1" })}#add`} className="btn-primary btn-sm">Записать возврат</Link>
                    <span className="help">{refs.partners.map((p) => `${p.name}: ${f(debt.bal.get(p.id) ?? 0, { sign: true })}`).join(" · ")}</span>
                  </div>
                </>
              ) : (
                <p className="mt-2 text-[22px] sm:text-[28px] font-bold tracking-tight text-ok">Все в расчёте</p>
              )}
              <p className="help mt-3">Плюс — человек вложил больше своей доли, ему должны. Доходы, полученные на свой кошелёк, считаются деньгами компании у этого человека.</p>
            </section>
          )}

          <div className="flex flex-wrap gap-1.5">
            {PERIODS.map((p) => <Link key={p.key} href={link({ p: p.key === "month" ? undefined : p.key })} className={`tab ${p.key === period ? "active" : ""}`}>{p.label}</Link>)}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className={KPI}><span className="help">Доходы</span><span className={`${KPI_VALUE} text-ok`}>{f(sum.income)}</span></div>
            <div className={KPI}><span className="help">Расходы</span><span className={KPI_VALUE}>{f(sum.expense)}</span></div>
            <div className={KPI}><span className="help">{sum.profit < 0 ? "Убыток" : "Прибыль"}</span><span className={`${KPI_VALUE} ${sum.profit < 0 ? "text-danger" : "text-ok"}`}>{f(sum.profit, { sign: true })}</span></div>
          </div>

          <Pnl pnl={pnl} f={f} />

          {!dir && (
            <Card title="По направлениям" description={cur === "EUR" ? "Нажмите на направление, чтобы открыть его вкладку." : "Пересчёт из EUR по сегодняшнему курсу."}>
              {sum.count === 0 ? <p className="help">За этот период операций нет.</p> : (
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Направление</th><th className="text-right">Доход</th><th className="text-right">Расход</th><th className="text-right">Итог</th></tr></thead>
                  <tbody>
                    {sum.tree.filter((r) => r.income || r.expense).flatMap((r) => [
                      <Line key={r.id ?? "none"} row={r} f={f} strong href={r.id ? link({ d: r.id }) : undefined} />,
                      ...r.children.map((c) => <Line key={`${r.id}-${c.id}-${c.name}`} row={c} f={f} />),
                    ])}
                    <tr className="font-semibold"><td>Wexora всего</td><td className="text-right tabular-nums">{f(sum.income)}</td><td className="text-right tabular-nums">{f(sum.expense)}</td><td className={`text-right tabular-nums ${sum.profit < 0 ? "text-danger" : "text-ok"}`}>{f(sum.profit, { sign: true })}</td></tr>
                  </tbody>
                </table></div>
              )}
            </Card>
          )}

          {dir && subs.length > 0 && (
            <Card title="По подразделам">
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Подраздел</th><th className="text-right">Доход</th><th className="text-right">Расход</th><th className="text-right">Итог</th></tr></thead>
                <tbody>{subs.map((c) => <Line key={`${c.id}-${c.name}`} row={c} f={f} strong />)}</tbody>
              </table></div>
            </Card>
          )}

          {dir && (
            <Card title="По категориям">
              {cats.length === 0 ? <p className="help">За этот период операций нет.</p> : (
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Категория</th><th className="text-right">Доход</th><th className="text-right">Расход</th></tr></thead>
                  <tbody>{cats.map((c) => (
                    <tr key={c.name}><td className="font-medium">{c.name}</td><td className="text-right tabular-nums">{c.income ? f(c.income) : "—"}</td><td className="text-right tabular-nums">{c.expense ? f(c.expense) : "—"}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
          )}

          <Card title={dir ? `Кто сколько внёс в «${dir.name}»` : "Кто сколько внёс за период"} description="Оплаченные расходы и доходы, которые пришли человеку на его кошелёк.">
            <div className="grid gap-3 sm:grid-cols-2">
              {refs.partners.map((p) => {
                const pp = sum.perPartner.get(p.id) ?? { paid: 0, received: 0 };
                return (
                  <div key={p.id} className="rounded-xl border border-line p-3">
                    <div className="font-semibold">{p.name} <span className="help">· доля {p.sharePct}%</span></div>
                    <div className="mt-1 text-[14px]">Оплатил расходов: <b className="tabular-nums">{f(pp.paid)}</b></div>
                    <div className="text-[14px]">Получил доходов: <b className="tabular-nums">{f(pp.received)}</b></div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Months months={months} f={f} />

          <Card title={dir ? `Операции · ${dir.name}` : "Последние операции"} actions={<Link href={dir ? `/finance/ops?dir=${dir.id}` : "/finance/ops"} className="btn-ghost btn-sm">Все операции</Link>}>
            <OpsList ops={recent} refs={refs} cur={cur} factor={ctx.factor} compact back={dir ? `/finance?d=${dir.id}` : "/finance"} />
          </Card>
        </div>

        <div id="add" className="lg:sticky lg:top-20 self-start scroll-mt-16">
          <Card title={settling ? "Возврат долга" : dir ? `Добавить в «${dir.name}»` : "Добавить операцию"}>
            <OpForm
              key={`${dir?.id ?? "all"}-${settling ? "settle" : "new"}`}
              refs={ctx.form}
              myPartnerId={ctx.myPartnerId}
              lockDirection={dir?.id}
              initial={settling && settle ? { type: "SETTLEMENT", partnerId: settle.fromId, toPartnerId: settle.toId, amount: String(settle.amount), currency: "EUR" } : undefined}
            />
          </Card>
        </div>
      </div>
    </>
  );
}

function Line({ row, f, strong, href }: { row: DirRow; f: Fmt; strong?: boolean; href?: string }) {
  const net = row.income - row.expense;
  return (
    <tr>
      <td className={strong ? "font-medium" : "pl-7 text-ink-2"}>{href ? <Link href={href} className="hover:underline">{row.name}</Link> : row.name}</td>
      <td className="text-right tabular-nums">{row.income ? f(row.income) : "—"}</td>
      <td className="text-right tabular-nums">{row.expense ? f(row.expense) : "—"}</td>
      <td className={`text-right tabular-nums ${net < 0 ? "text-danger" : net > 0 ? "text-ok" : ""}`}>{f(net, { sign: true })}</td>
    </tr>
  );
}

function Months({ months, f }: { months: { key: string; label: string; income: number; expense: number }[]; f: Fmt }) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.income, m.expense)));
  return (
    <Card title="По месяцам" description="Последние 12 месяцев: зелёный — доходы, серый — расходы.">
      <div className="flex items-end gap-1.5 h-36">
        {months.map((m, i) => (
          <div key={m.key} className="flex-1 min-w-0 flex flex-col items-center gap-1" title={`${m.key}: доход ${f(m.income)}, расход ${f(m.expense)}`}>
            <div className="flex w-full items-end justify-center gap-0.5 h-28">
              <div className="w-1/2 max-w-3 rounded-t bg-ok" style={{ height: `${(m.income / max) * 100}%` }} />
              <div className="w-1/2 max-w-3 rounded-t bg-ink/30" style={{ height: `${(m.expense / max) * 100}%` }} />
            </div>
            {/* На телефоне подпись через месяц: 12 подписей не помещаются. */}
            <span className={`text-[10.5px] text-muted truncate ${(months.length - 1 - i) % 2 ? "invisible sm:visible" : ""}`}>{m.label}</span>
          </div>
        ))}
      </div>
      {/* Суммы на телефоне: всплывающая подсказка (title) пальцем не открывается. */}
      <ul className="mt-3 space-y-1 text-[13.5px] sm:hidden">
        {months.filter((m) => m.income || m.expense).map((m) => (
          <li key={m.key} className="flex items-baseline justify-between gap-3">
            <span className="text-muted">{m.label}</span>
            <span className="tabular-nums"><span className="text-ok">{f(m.income)}</span> / {f(m.expense)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Pnl({ pnl, f }: { pnl: ReturnType<typeof pnlOf>; f: Fmt }) {
  const line = (k: string) => pnl.rows.get(k)!;
  const pct = (v: number) => (pnl.revenue > 0 ? ` · ${Math.round((v / pnl.revenue) * 100)}%` : "");
  const Row = ({ k, minus }: { k: string; minus?: boolean }) => {
    const r = line(k);
    if (!r.amount && !r.cats.length) return null;
    return (
      <>
        <tr><td className="font-medium">{minus ? "− " : ""}{r.label}</td><td className="text-right tabular-nums font-medium">{f(r.amount)}</td></tr>
        {r.cats.map((c) => <tr key={k + c.name}><td className="pl-7 text-ink-2">{c.name}</td><td className="text-right tabular-nums text-ink-2">{f(c.amount)}</td></tr>)}
      </>
    );
  };
  const Total = ({ label, v }: { label: string; v: number }) => (
    <tr className="font-semibold"><td>{label}</td><td className={`text-right tabular-nums ${v < 0 ? "text-danger" : "text-ok"}`}>{f(v, { sign: true })}<span className="help font-normal">{pct(v)}</span></td></tr>
  );
  return (
    <Card title="P&L за период" description="Строка отчёта задаётся у категории в настройках. Возвраты долга между партнёрами сюда не входят.">
      <details>
        <summary className="cursor-pointer select-none">
          <span className="inline-flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
            <span>Выручка <b className="tabular-nums">{f(pnl.revenue)}</b></span>
            <span>Валовая <b className={`tabular-nums ${pnl.gross < 0 ? "text-danger" : ""}`}>{f(pnl.gross, { sign: true })}</b></span>
            <span>Чистая <b className={`tabular-nums ${pnl.net < 0 ? "text-danger" : "text-ok"}`}>{f(pnl.net, { sign: true })}</b></span>
          </span>
          <span className="help ml-2">подробно</span>
        </summary>
        <div className="table-wrap mt-3"><table className="table"><tbody>
          <Row k="REVENUE" />
          <Row k="COGS" minus />
          <Total label="Валовая прибыль" v={pnl.gross} />
          <Row k="OPEX" minus />
          <Total label="Операционная прибыль" v={pnl.operating} />
          <Row k="TAX" minus />
          <Row k="OTHER" />
          <Total label="Чистая прибыль" v={pnl.net} />
        </tbody></table></div>
      </details>
    </Card>
  );
}
