import { prisma } from "@/lib/db";
import { balances, settlePlan, type BalPartner } from "./balance";
import { PNL_LINES } from "./pnl";

/* ---------- Период ---------- */

export const PERIODS = [
  { key: "month", label: "Этот месяц" },
  { key: "prev", label: "Прошлый месяц" },
  { key: "quarter", label: "Квартал" },
  { key: "year", label: "Год" },
  { key: "all", label: "Всё время" },
] as const;
export type PeriodKey = (typeof PERIODS)[number]["key"];
export const asPeriod = (p: string | undefined, def: PeriodKey = "month"): PeriodKey => (PERIODS.some((x) => x.key === p) ? (p as PeriodKey) : def);

/** Границы периода [from, to) в UTC — даты операций хранятся без времени. */
export function periodRange(p: PeriodKey, now = new Date()): { from?: Date; to?: Date } {
  const y = now.getFullYear(), m = now.getMonth();
  const d = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 1));
  switch (p) {
    case "month": return { from: d(y, m), to: d(y, m + 1) };
    case "prev": return { from: d(y, m - 1), to: d(y, m) };
    case "quarter": { const q = Math.floor(m / 3) * 3; return { from: d(y, q), to: d(y, q + 3) }; }
    case "year": return { from: d(y, 0), to: d(y + 1, 0) };
    default: return {};
  }
}
export function dateWhere(r: { from?: Date; to?: Date }) {
  return r.from || r.to ? { date: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lt: r.to } : {}) } } : {};
}

/* ---------- Справочники ---------- */

export type DirOption = { id: string; name: string; label: string; parentId: string | null };

export async function loadRefs() {
  const [dirs, cats, partners, cps, usage] = await Promise.all([
    prisma.finDirection.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }] }),
    prisma.finCategory.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }] }),
    prisma.finPartner.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }] }),
    prisma.finCounterparty.findMany({ orderBy: { name: "asc" }, include: { categories: { select: { categoryId: true } } } }),
    prisma.finOp.groupBy({ by: ["counterpartyId"], where: { deletedAt: null, counterpartyId: { not: null } }, _count: true, _max: { date: true } }),
  ]);
  const use = new Map(usage.map((u) => [u.counterpartyId, { count: u._count, last: u._max.date?.getTime() ?? 0 }]));
  const parents = dirs.filter((d) => !d.parentId);
  // Плоский список для выбора: «Пинтерест», «Пинтерест · Кулинария», …
  const dirOptions: (DirOption & { archived: boolean })[] = [];
  for (const p of parents) {
    dirOptions.push({ id: p.id, name: p.name, label: p.name, parentId: null, archived: p.archived });
    for (const c of dirs.filter((x) => x.parentId === p.id)) dirOptions.push({ id: c.id, name: c.name, label: `${p.name} · ${c.name}`, parentId: p.id, archived: c.archived || p.archived });
  }
  return {
    dirs, parents, dirOptions,
    cats,
    partners: partners.map((p) => ({ id: p.id, name: p.name, userId: p.userId, sharePct: Number(p.sharePct), order: p.order })),
    // Контрагенты: чаще и недавно используемые — первыми (так их и показывает форма).
    counterparties: cps
      .map((c) => ({ id: c.id, name: c.name, archived: c.archived, categoryIds: c.categories.map((x) => x.categoryId), uses: use.get(c.id)?.count ?? 0, last: use.get(c.id)?.last ?? 0 }))
      .sort((a, b) => b.last - a.last || b.uses - a.uses || a.name.localeCompare(b.name)),
  };
}

/* ---------- Долги ---------- */

export async function debtState(partners: BalPartner[]) {
  const ops = await prisma.finOp.findMany({ where: { deletedAt: null }, select: { type: true, amountEur: true, partnerId: true, toPartnerId: true } });
  const bal = balances(partners, ops.map((o) => ({ ...o, amountEur: Number(o.amountEur) })));
  return { bal, plan: settlePlan(partners, bal) };
}

/* ---------- Сводка за период ---------- */

export type DirRow = { id: string | null; name: string; income: number; expense: number; children: DirRow[] };

/** Направление верхнего уровня и все его подразделы. */
export function dirFamily(dirs: { id: string; parentId: string | null }[], topId: string): string[] {
  return [topId, ...dirs.filter((d) => d.parentId === topId).map((d) => d.id)];
}

/** Итоги за период; `dirIds` — только эти направления (вкладка направления). */
export async function periodSummary(range: { from?: Date; to?: Date }, partners: BalPartner[], dirs: { id: string; name: string; parentId: string | null; order: number }[], dirIds?: string[]) {
  const ops = await prisma.finOp.findMany({
    where: { deletedAt: null, type: { in: ["EXPENSE", "INCOME"] }, ...dateWhere(range), ...(dirIds ? { directionId: { in: dirIds } } : {}) },
    select: { type: true, amountEur: true, directionId: true, partnerId: true, categoryId: true },
  });
  let income = 0, expense = 0;
  const perDir = new Map<string | null, { income: number; expense: number }>();
  const perPartner = new Map(partners.map((p) => [p.id, { paid: 0, received: 0 }]));
  const perCat = new Map<string | null, { income: number; expense: number }>();
  for (const o of ops) {
    const v = Number(o.amountEur);
    const k = o.type === "INCOME" ? "income" : "expense";
    if (k === "income") income += v; else expense += v;
    const row = perDir.get(o.directionId) ?? { income: 0, expense: 0 };
    row[k] += v;
    perDir.set(o.directionId, row);
    const cr = perCat.get(o.categoryId) ?? { income: 0, expense: 0 };
    cr[k] += v;
    perCat.set(o.categoryId, cr);
    const pp = perPartner.get(o.partnerId);
    if (pp) { if (k === "income") pp.received += v; else pp.paid += v; }
  }
  // Дерево: у родителя — свои операции + подразделы.
  const tree: DirRow[] = [];
  for (const p of dirs.filter((d) => !d.parentId && (!dirIds || dirIds.includes(d.id)))) {
    const own = perDir.get(p.id) ?? { income: 0, expense: 0 };
    const children: DirRow[] = dirs.filter((d) => d.parentId === p.id).map((c) => ({ id: c.id, name: c.name, ...(perDir.get(c.id) ?? { income: 0, expense: 0 }), children: [] }));
    const hasOwn = own.income || own.expense;
    const kids = children.filter((c) => c.income || c.expense);
    if (hasOwn && kids.length) kids.unshift({ id: null, name: "без подраздела", ...own, children: [] });
    tree.push({
      id: p.id, name: p.name,
      income: own.income + children.reduce((s, c) => s + c.income, 0),
      expense: own.expense + children.reduce((s, c) => s + c.expense, 0),
      children: kids,
    });
  }
  const none = perDir.get(null);
  if (none) tree.push({ id: null, name: "Без направления", ...none, children: [] });
  return { income, expense, profit: income - expense, tree, perPartner, perCat, count: ops.length };
}

/** Доходы и расходы по месяцам за последние 12 месяцев. */
export async function monthly(dirIds?: string[], now = new Date()) {
  const from = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 11, 1));
  const ops = await prisma.finOp.findMany({ where: { deletedAt: null, type: { in: ["EXPENSE", "INCOME"] }, date: { gte: from }, ...(dirIds ? { directionId: { in: dirIds } } : {}) }, select: { type: true, amountEur: true, date: true } });
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    return { key: d.toISOString().slice(0, 7), label: d.toLocaleString("ru-RU", { month: "short", timeZone: "UTC" }).replace(".", ""), income: 0, expense: 0 };
  });
  for (const o of ops) {
    const m = months.find((x) => x.key === o.date.toISOString().slice(0, 7));
    if (m) m[o.type === "INCOME" ? "income" : "expense"] += Number(o.amountEur);
  }
  return months;
}

/** Имена людей, которые вносили и меняли операции. */
export async function userNames(ids: (string | null)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const users = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
  return new Map(users.map((u) => [u.id, u.name]));
}

/** Кто может быть партнёром: владелец портала и люди с доступом к финансам. */
export async function financeUsers(ownerEmails: string[]) {
  return prisma.user.findMany({
    where: { isActive: true, OR: [{ email: { in: ownerEmails } }, { toolAccess: { some: { slug: "finance" } } }] },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
}

/* ---------- P&L ---------- */

export type PnlRow = { key: string; label: string; amount: number; cats: { name: string; amount: number }[] };

/**
 * P&L из сумм по категориям. Выручка и «Прочее» — доход минус расход; строки расходов — расход минус возвраты.
 * Операции без категории: доход — в выручку, расход — в операционные.
 */
export function pnlOf(perCat: Map<string | null, { income: number; expense: number }>, cats: { id: string; name: string; pnl: string }[]) {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const rows = new Map<string, PnlRow>(PNL_LINES.map((l) => [l.key, { key: l.key, label: l.label, amount: 0, cats: [] }]));
  for (const [id, v] of perCat) {
    const c = id ? byId.get(id) : undefined;
    const name = c?.name ?? "Без категории";
    const put = (key: string, amount: number) => {
      const r = rows.get(key)!;
      r.amount += amount;
      if (amount) r.cats.push({ name, amount });
    };
    if (!c) { if (v.income) put("REVENUE", v.income); if (v.expense) put("OPEX", v.expense); continue; }
    put(c.pnl, c.pnl === "REVENUE" || c.pnl === "OTHER" ? v.income - v.expense : v.expense - v.income);
  }
  for (const r of rows.values()) r.cats.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const g = (k: string) => rows.get(k)!.amount;
  const gross = g("REVENUE") - g("COGS");
  const operating = gross - g("OPEX");
  const net = operating - g("TAX") + g("OTHER");
  return { rows, gross, operating, net, revenue: g("REVENUE") };
}
