import { prisma } from "@/lib/db";
import { financeUser } from "@/lib/finance/access";
import { opsWhere } from "@/lib/finance/filters";
import { loadRefs, userNames } from "@/lib/finance/report";
import { pnlLine } from "@/lib/finance/pnl";

export const dynamic = "force-dynamic";

const TYPE: Record<string, string> = { EXPENSE: "Расход", INCOME: "Доход", SETTLEMENT: "Возврат долга" };
const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const n = (v: unknown) => String(v).replace(".", ",");

/**
 * GET /api/finance/export?<фильтры журнала> → CSV (разделитель «;», открывается в Excel/Google Таблицах).
 * Плоская таблица под сводные и P&L: месяц, направление и подраздел отдельно, строка P&L, контрагент, EUR со знаком.
 */
export async function GET(req: Request) {
  if (!(await financeUser())) return new Response("Нет доступа", { status: 401 });
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const [ops, refs] = await Promise.all([
    prisma.finOp.findMany({ where: opsWhere(params), include: { counterparty: { select: { name: true } } }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] }),
    loadRefs(),
  ]);
  const names = await userNames(ops.flatMap((o) => [o.createdById, o.updatedById]));
  const dir = new Map(refs.dirOptions.map((d) => [d.id, d]));
  const cat = new Map(refs.cats.map((c) => [c.id, c]));
  const who = new Map(refs.partners.map((p) => [p.id, p.name]));
  const head = ["ID", "Дата", "Месяц", "Тип", "Сумма", "Валюта", "Курс (EUR за 1)", "Курс вручную", "Сумма EUR", "EUR со знаком", "Направление", "Подраздел", "Категория", "Строка P&L", "Контрагент", "Кто", "Кому", "Карта/кошелёк", "Комментарий", "Внёс", "Изменил", "Создано"];
  const rows = ops.map((o) => {
    const d = o.directionId ? dir.get(o.directionId) : undefined;
    const top = d?.parentId ? dir.get(d.parentId) : d;
    const c = o.categoryId ? cat.get(o.categoryId) : undefined;
    const eur = Number(o.amountEur);
    return [
      o.id, o.date.toISOString().slice(0, 10), o.date.toISOString().slice(0, 7), TYPE[o.type], n(o.amount), o.currency, n(o.rate), o.rateManual ? "да" : "",
      n(o.amountEur), n(o.type === "INCOME" ? eur : o.type === "EXPENSE" ? -eur : 0),
      top?.name ?? "", d?.parentId ? d.name : "", c?.name ?? "", o.type === "SETTLEMENT" ? "" : c ? pnlLine(c.pnl).label : o.type === "INCOME" ? "Выручка" : "Операционные расходы",
      o.counterparty?.name ?? "", who.get(o.partnerId), o.toPartnerId ? who.get(o.toPartnerId) : "", o.account, o.note,
      names.get(o.createdById) ?? "", o.updatedById ? names.get(o.updatedById) ?? "" : "", o.createdAt.toISOString(),
    ];
  });
  const csv = "﻿" + [head, ...rows].map((r) => r.map(cell).join(";")).join("\n");
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="wexora_finance_${new Date().toISOString().slice(0, 10)}.csv"` },
  });
}
