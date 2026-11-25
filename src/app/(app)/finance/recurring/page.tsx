import { prisma } from "@/lib/db";
import { requireFinance } from "@/lib/finance/access";
import { financeContext } from "@/lib/finance/page";
import { fmtAmount } from "@/lib/finance/currency";
import { rateToEur } from "@/lib/finance/rates";
import { todayYmd } from "@/lib/finance/currency";
import { saveRecurring } from "@/actions/finance";
import { FinanceNav } from "@/components/finance/FinanceNav";
import { OpForm } from "@/components/finance/OpForm";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Badge, Card } from "@/components/ui";

export const dynamic = "force-dynamic";
const ru = (d: Date | null) => (d ? d.toISOString().slice(0, 10).split("-").reverse().join(".") : "—");

/** Регулярные операции: что система вносит сама каждый месяц. Сумма и день правятся, правило можно поставить на паузу или удалить. */
export default async function FinanceRecurring() {
  const me = await requireFinance();
  const ctx = await financeContext(me);
  const { refs, cur } = ctx;
  const rules = await prisma.finRecurring.findMany({ orderBy: [{ active: "desc" }, { day: "asc" }, { createdAt: "asc" }], include: { _count: { select: { ops: true } } } });
  const dir = new Map(refs.dirOptions.map((d) => [d.id, d.label]));
  const cat = new Map(refs.cats.map((c) => [c.id, c.name]));
  const cp = new Map(refs.counterparties.map((c) => [c.id, c.name]));
  const who = new Map(refs.partners.map((p) => [p.id, p.name]));
  // Сумма в месяц по сегодняшнему курсу — ориентир, сами операции пишутся по курсу своего дня.
  const today = todayYmd();
  const eurOf = new Map<string, number>();
  for (const c of new Set(rules.map((r) => r.currency))) eurOf.set(c, (await rateToEur(c, today))?.rate ?? 0);
  const eur = (r: (typeof rules)[number]) => Number(r.amount) * (eurOf.get(r.currency) ?? 0);
  const active = rules.filter((r) => r.active);
  const monthly = (type: string, partnerId?: string) => active.filter((r) => r.type === type && (!partnerId || r.partnerId === partnerId)).reduce((s, r) => s + eur(r), 0);
  const f = (v: number) => fmtAmount(v * ctx.factor, cur, { digits: 2 });

  return (
    <>
      <FinanceNav cur={cur} />
      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        <div className="space-y-4 min-w-0">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="kpi min-w-0"><span className="help">Регулярные расходы в месяц</span><span className="kpi-value tabular-nums">{f(monthly("EXPENSE"))}</span><span className="help">правил: {active.filter((r) => r.type === "EXPENSE").length}{monthly("INCOME") ? ` · доходы ${f(monthly("INCOME"))}` : ""}</span></div>
            {refs.partners.map((p) => <div key={p.id} className="kpi min-w-0"><span className="help">Из них платит {p.name}</span><span className="kpi-value tabular-nums">{f(monthly("EXPENSE", p.id))}</span></div>)}
          </div>

          <Card title={`Регулярные операции: ${rules.length}`} description="Каждый месяц в свой день система сама записывает операцию по курсу на этот день — вносить вручную не нужно. Изменение суммы действует на будущие операции, уже внесённые не меняются.">
            {rules.length === 0 ? (
              <p className="help">Пока ни одной. Заполните форму справа — галочка «повторять каждый месяц» уже стоит. Ту же галочку можно поставить в любой форме операции или при правке уже внесённой.</p>
            ) : (
              <ul className="space-y-2">
                {rules.map((r) => {
                  const title = (r.counterpartyId && cp.get(r.counterpartyId)) || (r.categoryId && cat.get(r.categoryId)) || r.note || "Без названия";
                  const sub = [r.directionId ? dir.get(r.directionId) : "Без направления", r.categoryId ? cat.get(r.categoryId) : null, r.note, r.account].filter(Boolean).join(" · ");
                  return (
                    <li key={r.id} className={`rounded-xl border border-line p-3 ${r.active ? "" : "opacity-60"}`}>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={r.type === "INCOME" ? "ok" : "neutral"}>{r.type === "INCOME" ? "доход" : "расход"}</Badge>
                          <span className="font-semibold">{title}</span>
                          {!r.active && <Badge tone="warn">на паузе</Badge>}
                        </div>
                        <span className="font-semibold tabular-nums whitespace-nowrap">{fmtAmount(Number(r.amount), r.currency, { digits: 2 })}{r.currency !== cur ? <span className="help font-normal"> ≈ {f(eur(r))}</span> : null}</span>
                      </div>
                      <p className="help mt-0.5 [overflow-wrap:anywhere]">{sub}</p>
                      <p className="mt-1 text-[14px]">
                        {r.type === "INCOME" ? "Получает" : "Платит"} <b>{who.get(r.partnerId) ?? "?"}</b> · каждый месяц <b>{r.day}-го</b> числа ·{" "}
                        {r.active ? <>следующая <b className="tabular-nums">{ru(r.nextDate)}</b></> : "не вносится"} · последняя {ru(r.lastDate)} · всего внесено: {r._count.ops}
                      </p>
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <ActionForm action={saveRecurring} hidden={{ id: r.id }} className="flex flex-wrap items-end gap-2">
                          <label className="block"><span className="label">Сумма, {r.currency}</span><input name="amount" className="input w-[120px]" inputMode="decimal" defaultValue={Number(r.amount)} /></label>
                          <label className="block"><span className="label">День месяца</span><input name="day" className="input w-[90px]" inputMode="numeric" defaultValue={r.day} /></label>
                          <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить</SubmitButton>
                        </ActionForm>
                        <ActionForm action={saveRecurring} hidden={{ id: r.id, active: r.active ? "0" : "1" }} className="inline">
                          <SubmitButton className="btn-ghost btn-sm" pendingText="…">{r.active ? "Пауза" : "Включить"}</SubmitButton>
                        </ActionForm>
                        <ActionForm action={saveRecurring} hidden={{ id: r.id, delete: "1" }} className="inline">
                          <SubmitButton className="btn-ghost btn-sm text-danger" confirm={`Удалить регулярную операцию «${title}»? Уже внесённые операции останутся, новые вноситься не будут.`} pendingText="…">Удалить</SubmitButton>
                        </ActionForm>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="lg:sticky lg:top-20 self-start">
          <Card title="Добавить регулярную операцию" description="Первая операция запишется выбранной датой, следующие — в тот же день каждого месяца.">
            <OpForm refs={ctx.form} myPartnerId={ctx.myPartnerId} recurDefault />
          </Card>
        </div>
      </div>
    </>
  );
}
