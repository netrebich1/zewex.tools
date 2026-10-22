import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { addFinance, deleteFinance, importFinance } from "@/actions/projectsFinance";
import { FINANCE_CATEGORIES, financeCategoryLabel } from "@/lib/projects/steps";
import { projectCostByMonth, type ProjectSummary } from "@/lib/projects/summary";
import { fmtMoney } from "@/lib/utils";

const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const monthLabel = (m: string) => { const [y, mm] = m.split("-"); return `${MONTHS[Number(mm) - 1]} ${y}`; };

/** Вкладка «Финансы» (только главные админы): доходы и расходы вне ИИ, расход ИИ по месяцам, итог. */
export async function FinanceTab({ accessId, cardId, summary, userName }: { accessId: string; cardId: string; summary: ProjectSummary; userName: (id: string | null) => string | null }) {
  const [ops, aiMonths] = await Promise.all([
    prisma.prjFinance.findMany({ where: { cardId }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 500 }),
    projectCostByMonth(accessId),
  ]);
  const months = new Map<string, { income: number; expense: number; ai: number }>();
  const get = (m: string) => { const v = months.get(m) ?? { income: 0, expense: 0, ai: 0 }; months.set(m, v); return v; };
  for (const o of ops) { const m = o.date.toISOString().slice(0, 7); const v = get(m); if (o.kind === "income") v.income += Number(o.amountUsd); else v.expense += Number(o.amountUsd); }
  for (const a of aiMonths) get(a.month).ai += a.total;
  const rows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const tot = { income: ops.filter((o) => o.kind === "income").reduce((a, o) => a + Number(o.amountUsd), 0), expense: ops.filter((o) => o.kind === "expense").reduce((a, o) => a + Number(o.amountUsd), 0), ai: summary.cost.total };
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="kpi"><div className="help">Доход</div><div className="kpi-value text-ok">{fmtMoney(tot.income)}</div></div>
        <div className="kpi"><div className="help">Траты (руками)</div><div className="kpi-value">{fmtMoney(tot.expense)}</div></div>
        <div className="kpi"><div className="help">Расход ИИ</div><div className="kpi-value">{fmtMoney(tot.ai)}</div><div className="help">пины {fmtMoney(summary.cost.pins)} · статьи {fmtMoney(summary.cost.articles)} · блог {fmtMoney(summary.cost.blog)}</div></div>
        <div className="kpi"><div className="help">Итог</div><div className={`kpi-value ${tot.income - tot.expense - tot.ai >= 0 ? "text-ok" : "text-danger"}`}>{fmtMoney(tot.income - tot.expense - tot.ai)}</div></div>
      </div>

      <Card title="Добавить операцию" description="Одна строка — одна операция. Дата, сумма в долларах, доход или расход, категория, заметка.">
        <ActionForm action={addFinance} hidden={{ accessId }} className="grid gap-2 sm:grid-cols-[140px_120px_120px_1fr_1fr_auto]">
          <input type="date" name="date" className="input py-2" defaultValue={today} />
          <input name="amountUsd" className="input py-2" placeholder="Сумма $" inputMode="decimal" required />
          <select name="kind" className="input py-2" defaultValue="expense"><option value="expense">Расход</option><option value="income">Доход</option></select>
          <select name="category" className="input py-2" defaultValue="other">{FINANCE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
          <input name="note" className="input py-2" placeholder="Заметка" />
          <SubmitButton className="btn-primary" pendingText="…">Добавить</SubmitButton>
        </ActionForm>
      </Card>

      <Card title="По месяцам" description="Расход ИИ — из журнала расхода портала (UTC). Прогоны пинов чистятся через 90 дней, поэтому ИИ-расход пинов старше трёх месяцев может быть занижен.">
        {rows.length === 0 ? <p className="help">Пока нет ни операций, ни расхода ИИ.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Месяц</th><th>Доход</th><th>Траты</th><th>ИИ</th><th>Итог</th></tr></thead>
              <tbody>{rows.map(([m, v]) => { const net = v.income - v.expense - v.ai; return (
                <tr key={m}><td className="font-medium">{monthLabel(m)}</td><td className="tabular-nums text-ok">{v.income ? fmtMoney(v.income) : "—"}</td><td className="tabular-nums">{v.expense ? fmtMoney(v.expense) : "—"}</td><td className="tabular-nums">{v.ai ? fmtMoney(v.ai) : "—"}</td><td className={`tabular-nums font-medium ${net >= 0 ? "text-ok" : "text-danger"}`}>{fmtMoney(net)}</td></tr>
              ); })}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Операции" description={ops.length ? `Всего ${ops.length}.` : "Операций нет."}>
        {ops.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Дата</th><th>Вид</th><th>Сумма</th><th>Категория</th><th>Заметка</th><th>Кто</th><th></th></tr></thead>
              <tbody>{ops.map((o) => (
                <tr key={o.id}>
                  <td className="whitespace-nowrap">{o.date.toLocaleDateString("ru-RU", { timeZone: "UTC" })}</td>
                  <td>{o.kind === "income" ? <span className="text-ok">доход</span> : "расход"}</td>
                  <td className="tabular-nums font-medium">{fmtMoney(Number(o.amountUsd))}</td>
                  <td className="text-muted">{financeCategoryLabel(o.category)}</td>
                  <td className="text-muted">{o.note ?? ""}{o.source === "import" ? <span className="ml-1 text-[12px]">· импорт</span> : ""}</td>
                  <td className="text-muted text-[13px]">{userName(o.createdById) ?? ""}</td>
                  <td className="text-right"><ActionForm action={deleteFinance} hidden={{ accessId, id: o.id }} className="inline"><SubmitButton className="text-[12.5px] text-muted hover:text-danger" pendingText="…" confirm="Удалить операцию?">×</SubmitButton></ActionForm></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Импорт выгрузки" description="Вставьте строки из таблицы: дата; сумма; доход/расход; категория; заметка (разделитель — табуляция, «;» или «,»). Повторный импорт тех же строк дублей не создаёт.">
        <ActionForm action={importFinance} hidden={{ accessId }} className="space-y-2">
          <textarea name="text" className="input min-h-[120px] font-mono text-[13px]" placeholder={"2026-10-01\t120\tрасход\tхостинг\tFastVPS октябрь\n15.10.2026\t340.50\tдоход\tпартнёрки\tAmazon"} />
          <SubmitButton className="btn-primary btn-sm" pendingText="Импортирую…">Импортировать</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
