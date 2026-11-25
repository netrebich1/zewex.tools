import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireFinance } from "@/lib/finance/access";
import { financeContext } from "@/lib/finance/page";
import { asPeriod, debtState, dirFamily, monthly, PERIODS, periodRange, periodSummary, pnlOf, type DirRow } from "@/lib/finance/report";
import { balances, settlePlan, type BalOp, type Transfer } from "@/lib/finance/balance";
import { fmtAmount } from "@/lib/finance/currency";
import { FinanceNav } from "@/components/finance/FinanceNav";
import { DirTabs } from "@/components/finance/DirTabs";
import { OpForm } from "@/components/finance/OpForm";
import { OpsList } from "@/components/finance/OpsList";
import { Card, Empty, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

type Fmt = (v: number, o?: { sign?: boolean; digits?: number }) => string;
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
  // Итог только выбранного периода: кто кому должен за его операции, без прошлых периодов и возвратов.
  const periodPlan = settlePlan(refs.partners, balances(refs.partners, refs.partners.flatMap((p): BalOp[] => {
    const pp = sum.perPartner.get(p.id) ?? { paid: 0, received: 0 };
    return [{ type: "EXPENSE", amountEur: pp.paid, partnerId: p.id, toPartnerId: null }, { type: "INCOME", amountEur: pp.received, partnerId: p.id, toPartnerId: null }];
  })));
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
                      {t.from} должен {dative(t.to)} <span className="text-warn whitespace-nowrap">{f(t.amount)}</span>
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
              <DebtDetail detail={debt.detail} f={f} />
              <DebtLedger ledger={debt.ledger} partners={refs.partners} f={f} />
              <p className="help mt-3">Плюс — человек вложил больше своей доли, ему должны. Доходы, полученные на свой кошелёк, считаются деньгами компании у этого человека: они уменьшают его вклад.</p>
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
            {!dir && (
              <p className="mt-3 text-[14px]">
                Итог только этого периода: <b>{periodPlan.length ? periodPlan.map((t) => `${t.from} должен ${dative(t.to)} ${f(t.amount, { digits: 2 })}`).join(", ") : "поровну, никто никому не должен"}</b>.{" "}
                <span className="help">Это половина разницы между вкладами. Общий долг вверху страницы — сумма таких итогов за все месяцы минус возвраты.</span>
              </p>
            )}
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

/** Из чего сложился долг: оплаченные расходы, полученные доходы, возвраты и доля каждого — за всё время. */
function DebtDetail({ detail, f: f0 }: { detail: Awaited<ReturnType<typeof debtState>>["detail"]; f: Fmt }) {
  // До копеек: по округлённым до евро числам строки таблицы не складываются в итог.
  const f: Fmt = (v, o = {}) => f0(v, { digits: 2, ...o });
  const { lines, expense, income } = detail;
  // Вклад = оплатил − получил доходов ± возвраты. Для двоих с равными долями долг — ровно половина разницы вкладов.
  const contrib = (l: (typeof lines)[number]) => l.paid - l.received + l.gave - l.got;
  const [a, b] = lines.length === 2 && lines[0].sharePct === lines[1].sharePct ? [...lines].sort((x, y) => contrib(y) - contrib(x)) : [];
  const gap = a && b ? contrib(a) - contrib(b) : 0;
  const settled = lines.some((l) => l.gave || l.got);
  const net = expense - income;
  const cell = "text-right tabular-nums whitespace-nowrap";
  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-[13.5px] text-ink-2">
        За всё время: расходы <b className="tabular-nums">{f(expense)}</b>, доходы <b className="tabular-nums text-ok">{f(income)}</b>{" "}
        <Link href="/finance/income" className="underline hover:text-ink">по направлениям</Link>. {net >= 0 ? "Убыток" : "Прибыль"} <b className="tabular-nums">{f(Math.abs(net))}</b> делится по долям.
      </p>
      <div className="table-wrap mt-2"><table className="table">
        <thead><tr><th />{lines.map((l) => <th key={l.id} className="text-right">{l.name}</th>)}</tr></thead>
        <tbody>
          <tr><td>Оплатил расходов</td>{lines.map((l) => <td key={l.id} className={cell}>{f(l.paid)}</td>)}</tr>
          <tr><td>Получил доходов на свой счёт</td>{lines.map((l) => <td key={l.id} className={cell}>{l.received ? `−${f(l.received)}` : "—"}</td>)}</tr>
          {settled && <tr><td>Возвраты: отдал − получил</td>{lines.map((l) => <td key={l.id} className={cell}>{f(l.gave - l.got, { sign: true })}</td>)}</tr>}
          <tr className="font-medium"><td>Вклад своими деньгами <span className="help">· оплатил − доходы у него{settled ? " ± возвраты" : ""}</span></td>{lines.map((l) => <td key={l.id} className={cell}>{f(contrib(l))}</td>)}</tr>
          <tr><td>{net >= 0 ? "Его доля убытка" : "Его доля прибыли"} <span className="help">· {lines.map((l) => `${l.sharePct}%`).join(" / ")}</span></td>{lines.map((l) => <td key={l.id} className={cell}>{f(-l.lossShare, { sign: true })}</td>)}</tr>
          <tr className="font-semibold"><td>Итог</td>{lines.map((l) => <td key={l.id} className={`${cell} ${l.balance < -0.005 ? "text-warn" : l.balance > 0.005 ? "text-ok" : ""}`}>{Math.abs(l.balance) < 0.005 ? "в расчёте" : `${l.balance > 0 ? "ему должны" : "должен"} ${f(Math.abs(l.balance))}`}</td>)}</tr>
        </tbody>
      </table></div>
      {a && b && gap > 0.01 && (
        <p className="mt-2 text-[14px]">
          Проще: {a.name} вложил своими деньгами на <b className="tabular-nums">{f(gap)}</b> больше, чем {b.name} ({f(contrib(a))} против {f(contrib(b))}). Чтобы стало поровну, {b.name} отдаёт половину разницы: <b className="tabular-nums">{f(gap)} ÷ 2 = {f(gap / 2)}</b>.
          {lines.some((l) => l.received > 0) && <span className="help"> Доход, который лежит у человека на счету, — общие деньги: на эту сумму его вклад меньше, чем он оплатил расходов.</span>}
        </p>
      )}
    </div>
  );
}

const ruDate = (ymd: string) => ymd.split("-").reverse().join(".");
const ruMonth = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).replace(" г.", "");
/** «Никита» → «Никите», «Ярослав» → «Ярославу»: имена партнёров в дательном падеже. */
const dative = (n: string) => (/[ая]$/i.test(n) ? n.slice(0, -1) + "е" : /[йь]$/i.test(n) ? n.slice(0, -1) + "ю" : /[бвгджзклмнпрстфхцчшщ]$/i.test(n) ? n + "у" : n);
const owes = (plan: Transfer[], f: Fmt) => (plan.length ? plan.map((t) => `${t.from} должен ${dative(t.to)} ${f(t.amount)}`).join(", ") : "никто никому не должен");

/** История расчёта словами: возвраты (последний, закрывался ли долг) и по каждому месяцу — кто сколько оплатил и кто кому должен. */
function DebtLedger({ ledger, partners, f: f0 }: { ledger: Awaited<ReturnType<typeof debtState>>["ledger"]; partners: { id: string; name: string; sharePct: number }[]; f: Fmt }) {
  const f: Fmt = (v, o = {}) => f0(v, { digits: 2, ...o });
  const { months, settlements, closedAt } = ledger;
  if (!months.length) return null;
  const last = settlements.at(-1);
  const ret = (t: Transfer) => `${t.from} вернул ${dative(t.to)} ${f(t.amount)}`;
  return (
    <div className="mt-4 border-t border-line pt-3 space-y-4">
      <div>
        <p className="text-[13.5px] font-semibold">Возвраты долга</p>
        {!last ? (
          <p className="mt-1 text-[14px]">Возвратов ещё не было. Долг копится с первой операции ({ruDate(ledger.firstDate ?? "")}). Когда кто-то переведёт деньги другому — нажмите «Записать возврат», и он появится здесь.</p>
        ) : (
          <>
            <p className="mt-1 text-[14px]">
              Последний возврат — <b>{ruDate(last.date)}</b>: {ret(last)}. {closedAt ? <>Долг был полностью закрыт <b>{ruDate(closedAt)}</b>.</> : "Полностью долг ещё ни разу не закрывался."}
            </p>
            <ul className="mt-2 space-y-1 text-[14px]">
              {[...settlements].reverse().map((s, i) => (
                <li key={`${s.date}-${i}`} className="rounded-lg bg-ink/5 px-3 py-2">
                  <b className="tabular-nums">{ruDate(s.date)}</b> — {ret(s)}. <span className="text-ink-2">После этого: {s.after.length ? owes(s.after, f) : "долг закрыт, никто никому не должен"}.</span>
                </li>
              ))}
            </ul>
            <Link href="/finance/ops?type=SETTLEMENT" className="help mt-1 inline-block underline hover:text-ink">Изменить или удалить возврат — в журнале</Link>
          </>
        )}
      </div>
      <div>
        <p className="text-[13.5px] font-semibold">История по месяцам</p>
        <ul className="mt-2 space-y-2">
          {[...months].reverse().map((m, i) => {
            const first = i === months.length - 1;
            return (
              <li key={m.month} className="rounded-xl border border-line p-3 text-[14px]">
                <p className="font-semibold capitalize">{ruMonth(m.month)}</p>
                <ul className="mt-1 space-y-0.5">
                  {partners.map((p) => (
                    <li key={p.id}>{p.name} оплатил расходов: <b className="tabular-nums">{f(m.paid[p.id] ?? 0)}</b></li>
                  ))}
                  {(() => {
                    // Доход общий, кому бы он ни пришёл: показываем, кто получил и чья в нём какая доля.
                    const income = partners.reduce((s, p) => s + (m.received[p.id] ?? 0), 0);
                    if (!income) return <li>Общий доход за месяц: не было</li>;
                    const shares = partners.reduce((s, p) => s + Math.max(0, p.sharePct), 0) || 1;
                    return (
                      <li className="my-1 rounded-lg bg-ink/5 px-3 py-2">
                        Общий доход за месяц: <b className="tabular-nums">{f(income)}</b> — делится по долям и уже учтён в итоге месяца.
                        <ul className="mt-1 space-y-0.5">
                          {partners.map((p) => {
                            const got = m.received[p.id] ?? 0, own = (income * Math.max(0, p.sharePct)) / shares, extra = got - own;
                            return (
                              <li key={p.id}>
                                {p.name}: получил на свой счёт <b className="tabular-nums">{f(got)}</b>, его доля ({p.sharePct}%) — <b className="tabular-nums">{f(own)}</b>.{" "}
                                {Math.abs(extra) < 0.005 ? "Ровно своя доля." : extra > 0 ? <>Из полученного <b className="tabular-nums">{f(extra)}</b> — чужая доля, она засчитана как его долг.</> : <>Ему причитается ещё <b className="tabular-nums">{f(-extra)}</b> из дохода, который лежит у партнёра, — засчитано в его пользу.</>}
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    );
                  })()}
                  <li>Итог только этого месяца: <b>{owes(m.own, f)}</b></li>
                  <li>Возвраты за месяц: {m.settled.length ? <b>{m.settled.map(ret).join("; ")}</b> : "не было"}</li>
                  {!(first && !m.settled.length) && <li>{first ? "Долг на конец месяца" : "Долг на конец месяца, вместе с прошлыми месяцами и возвратами"}: <b>{owes(m.end, f)}</b></li>}
                </ul>
                <MonthMath m={m} prev={months[months.length - 2 - i]?.end ?? []} partners={partners} f={f} />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Число с подсказкой: при наведении (на телефоне — по нажатию) показывает, что это за сумма. */
function Hint({ tip, strong, children }: { tip: string; strong?: boolean; children: React.ReactNode }) {
  return (
    <span tabIndex={0} className={`group relative inline-block cursor-help whitespace-nowrap tabular-nums underline decoration-dotted decoration-muted underline-offset-4 outline-none ${strong ? "font-bold" : ""}`}>
      {children}
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 hidden w-max max-w-[260px] -translate-x-1/2 whitespace-normal rounded-lg bg-ink px-2.5 py-1.5 text-left text-[12.5px] font-normal leading-snug text-bg shadow-lg group-hover:block group-focus:block">{tip}</span>
    </span>
  );
}

/**
 * Расчёт месяца формулами, у каждого числа — подсказка. Только для двух партнёров с равными долями
 * (там долг = половина разницы вкладов): вклад каждого, разница, пополам, долг на конец.
 */
function MonthMath({ m, prev, partners, f }: { m: Awaited<ReturnType<typeof debtState>>["ledger"]["months"][number]; prev: Transfer[]; partners: { id: string; name: string; sharePct: number }[]; f: Fmt }) {
  if (partners.length !== 2 || partners[0].sharePct !== partners[1].sharePct) return null;
  const month = ruMonth(m.month);
  const c = (p: { id: string }) => (m.paid[p.id] ?? 0) - (m.received[p.id] ?? 0);
  const [hi, lo] = c(partners[0]) >= c(partners[1]) ? partners : [partners[1], partners[0]];
  const gap = c(hi) - c(lo);
  const anyIncome = partners.some((p) => m.received[p.id]);
  // Долг на конец: слагаемые со знаком относительно того, кто должен в итоге.
  const debtor = (m.end[0] ?? m.own[0] ?? prev[0])?.fromId;
  const terms = [
    ...m.own.map((t) => ({ tip: `Долг за ${month}: ${t.from} должен ${dative(t.to)} — результат строки «Долг за месяц».`, v: t.fromId === debtor ? t.amount : -t.amount })),
    ...prev.map((t) => ({ tip: `Долг, который остался с прошлых месяцев: ${t.from} должен ${dative(t.to)}. Его не возвращали деньгами, поэтому он ${t.fromId === debtor ? "прибавляется" : "вычитается (взаимозачёт)"}.`, v: t.fromId === debtor ? t.amount : -t.amount })),
    ...m.settled.map((t) => ({ tip: `Возврат долга за ${month}: ${t.from} перевёл ${dative(t.to)} деньги.`, v: t.fromId === debtor ? -t.amount : t.amount })),
  ].sort((x, y) => y.v - x.v);
  const row = "flex flex-wrap items-baseline gap-x-1.5";
  const lbl = "w-[112px] shrink-0 text-ink-2";
  return (
    <div className="mt-2 rounded-lg border border-dashed border-line px-3 py-2 text-[14px]">
      <p className="font-semibold">Расчёт <span className="help font-normal">· наведите или нажмите на число, чтобы увидеть, что это</span></p>
      <div className="mt-1 space-y-1">
        {partners.map((p) => (
          <div key={p.id} className={row}>
            <span className={lbl}>{p.name}:</span>
            <Hint tip={`Расходы, которые ${p.name} оплатил со своих денег за ${month}. Операций: ${m.paidN[p.id] ?? 0}.`}>{f(m.paid[p.id] ?? 0)}</Hint>
            {anyIncome && <>−<Hint tip={m.received[p.id] ? `Общий доход, который за ${month} пришёл на счёт: ${p.name} (операций: ${m.receivedN[p.id] ?? 0}). Это деньги компании у него на руках, поэтому они вычитаются из его вклада.` : `${p.name} за ${month} общих доходов на свой счёт не получал.`}>{f(m.received[p.id] ?? 0)}</Hint></>}
            =<Hint strong tip={`Вклад: сколько своих денег ${p.name} вложил в общее дело за ${month} (оплаченные расходы минус общий доход у него на счету).`}>{f(c(p))}</Hint>
          </div>
        ))}
        <div className={row}>
          <span className={lbl}>Разница:</span>
          <Hint tip={`Вклад: ${hi.name} — у кого он больше.`}>{f(c(hi))}</Hint>−<Hint tip={`Вклад: ${lo.name} — у кого он меньше.`}>{f(c(lo))}</Hint>
          =<Hint strong tip={`На столько ${hi.name} вложил своих денег больше, чем ${lo.name}, за ${month}.`}>{f(gap)}</Hint>
        </div>
        <div className={row}>
          <span className={lbl}>Долг за месяц:</span>
          <Hint tip="Разница вкладов из строки выше.">{f(gap)}</Hint>÷<Hint tip={`Доли ${partners[0].sharePct}/${partners[1].sharePct}: расходы и доходы делятся пополам. Чтобы вклады сравнялись, отстающий отдаёт половину разницы, а не всю.`}>2</Hint>
          =<Hint strong tip={gap / 2 >= 0.01 ? `Столько ${lo.name} должен ${dative(hi.name)} только за ${month}, без прошлых месяцев и возвратов.` : `За ${month} вклады равны.`}>{f(gap / 2)}</Hint>
          <span className="text-ink-2">{gap / 2 >= 0.01 ? `→ ${lo.name} должен ${dative(hi.name)}` : "→ никто никому не должен"}</span>
        </div>
        {(prev.length > 0 || m.settled.length > 0) && terms.length > 0 && (
          <div className={row}>
            <span className={lbl}>Долг на конец:</span>
            {terms.map((t, i) => <span key={i} className="inline-flex items-baseline gap-x-1.5">{i ? (t.v < 0 ? "−" : "+") : t.v < 0 ? "−" : ""}<Hint tip={t.tip}>{f(Math.abs(t.v))}</Hint></span>)}
            =<Hint strong tip={`Общий долг на конец месяца (${month}): все месяцы с начала учёта и все возвраты.`}>{f(m.end[0]?.amount ?? 0)}</Hint>
            <span className="text-ink-2">→ {m.end.length ? `${m.end[0].from} должен ${dative(m.end[0].to)}` : "долг закрыт"}</span>
          </div>
        )}
      </div>
    </div>
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
