import type { FinOp } from "@prisma/client";
import { Badge } from "@/components/ui";
import { fmtAmount, rateLabel } from "@/lib/finance/currency";
import type { loadRefs } from "@/lib/finance/report";
import { OpActions } from "./OpActions";

type Refs = Awaited<ReturnType<typeof loadRefs>>;
const TYPE = { EXPENSE: { label: "расход", tone: "neutral" }, INCOME: { label: "доход", tone: "ok" }, SETTLEMENT: { label: "возврат", tone: "brand" } } as const;

/** Таблица операций: сумма в валюте операции и в валюте показа, кто платил, кто внёс. */
export type OpRow = FinOp & { counterparty?: { name: string } | null };

export function OpsList({ ops, refs, cur, factor, compact, names, back }: { ops: OpRow[]; refs: Refs; cur: string; factor: number; compact?: boolean; names?: Map<string, string>; back?: string }) {
  if (!ops.length) return <p className="help">Операций пока нет.</p>;
  const dir = new Map(refs.dirOptions.map((d) => [d.id, d.label]));
  const cat = new Map(refs.cats.map((c) => [c.id, c.name]));
  const who = new Map(refs.partners.map((p) => [p.id, p.name]));
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr>
        <th className="col-sm">Дата</th><th>Операция</th><th className="text-right">Сумма</th><th className="col-sm">Кто</th>
        {!compact && <th className="col-sm">Внёс</th>}<th className="col-sm" />
      </tr></thead>
      <tbody>
        {ops.map((o) => {
          const t = TYPE[o.type];
          const amount = Number(o.amount), eur = Number(o.amountEur);
          // Главное — кому платили (контрагент), под ним направление, категория, комментарий, кошелёк.
          const where = o.type === "SETTLEMENT" ? "" : [o.directionId ? dir.get(o.directionId) : "Без направления", o.categoryId ? cat.get(o.categoryId) : null].filter(Boolean).join(" · ");
          const title = o.type === "SETTLEMENT" ? "Возврат долга" : o.counterparty?.name ?? (o.categoryId ? cat.get(o.categoryId) : null) ?? where;
          const sub = [o.type !== "SETTLEMENT" && o.counterparty ? where : o.type !== "SETTLEMENT" && o.categoryId ? (o.directionId ? dir.get(o.directionId) : "Без направления") : null, o.note, o.account].filter(Boolean).join(" · ");
          const sign = o.type === "INCOME" ? 1 : o.type === "EXPENSE" ? -1 : 0;
          const date = o.date.toISOString().slice(0, 10).split("-").reverse().join(".");
          const payer = `${who.get(o.partnerId)}${o.toPartnerId ? ` → ${who.get(o.toPartnerId)}` : ""}`;
          const actions = <OpActions id={o.id} back={back} label={`${fmtAmount(amount, o.currency, { digits: 2 })}, ${title}`} />;
          return (
            <tr key={o.id}>
              <td className="col-sm whitespace-nowrap tabular-nums text-ink-2">{date}</td>
              <td className="min-w-[180px]">
                <div className="flex items-center gap-1.5"><Badge tone={t.tone}>{t.label}</Badge><span className="font-medium">{title}</span></div>
                {sub && <div className="help mt-0.5 [overflow-wrap:anywhere]">{sub}</div>}
                {/* На телефоне дата, кто платил и кнопки — под названием: их колонки скрыты. */}
                <div className="help mt-0.5 tabular-nums sm:hidden">{date} · {payer}</div>
                <div className="mt-1.5 flex justify-start sm:hidden">{actions}</div>
              </td>
              <td className="text-right whitespace-nowrap">
                <div className={`font-semibold tabular-nums ${sign > 0 ? "text-ok" : ""}`}>{fmtAmount(sign < 0 ? -amount : amount, o.currency, { sign: sign > 0, digits: 2 })}</div>
                {(o.currency !== cur || o.rateManual) && (
                  <div className="help tabular-nums" title={o.currency !== "EUR" ? rateLabel(o.currency, Number(o.rate)) + (o.rateManual ? " (вручную)" : "") : undefined}>
                    ≈ {fmtAmount(eur * factor, cur, { digits: 2 })}{o.rateManual ? " · курс вручную" : ""}
                  </div>
                )}
              </td>
              <td className="col-sm whitespace-nowrap">{payer}</td>
              {!compact && (
                <td className="col-sm help whitespace-nowrap">
                  {names?.get(o.createdById) ?? "—"}
                  {o.updatedById && <div title={`изменено ${o.updatedAt.toLocaleString("ru-RU")}`}>изм.: {names?.get(o.updatedById) ?? "—"}, {o.updatedAt.toLocaleDateString("ru-RU")}</div>}
                </td>
              )}
              <td className="col-sm">{actions}</td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
  );
}
