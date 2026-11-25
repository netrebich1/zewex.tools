/**
 * Кто кому должен. Чистые функции, суммы в EUR (зафиксированы в операциях).
 *
 * Вклад партнёра: оплаченные им расходы − полученные им доходы + отданные возвраты − полученные возвраты.
 * Справедливо каждый несёт свою долю от (расходы − доходы). Баланс = вклад − доля:
 * плюс — ему должны, минус — он должен. Сумма балансов всегда 0.
 */
export type BalOp = { type: "EXPENSE" | "INCOME" | "SETTLEMENT"; amountEur: number; partnerId: string; toPartnerId: string | null };
export type BalPartner = { id: string; name: string; sharePct: number };
export type Transfer = { fromId: string; from: string; toId: string; to: string; amount: number };

const round2 = (x: number) => Math.round(x * 100) / 100;

export function balances(partners: BalPartner[], ops: BalOp[]): Map<string, number> {
  const net = new Map(partners.map((p) => [p.id, 0]));
  const add = (id: string | null, v: number) => { if (id && net.has(id)) net.set(id, net.get(id)! + v); };
  let pool = 0; // расходы − доходы
  for (const o of ops) {
    if (o.type === "EXPENSE") { add(o.partnerId, o.amountEur); pool += o.amountEur; }
    else if (o.type === "INCOME") { add(o.partnerId, -o.amountEur); pool -= o.amountEur; }
    else { add(o.partnerId, o.amountEur); add(o.toPartnerId, -o.amountEur); }
  }
  const shares = partners.reduce((s, p) => s + Math.max(0, p.sharePct), 0) || 1;
  const out = new Map<string, number>();
  for (const p of partners) out.set(p.id, round2(net.get(p.id)! - (pool * Math.max(0, p.sharePct)) / shares));
  return out;
}

/** Из чего сложился баланс партнёра: баланс = paid − received + gave − got − lossShare. */
export type BalLine = { id: string; name: string; sharePct: number; paid: number; received: number; gave: number; got: number; lossShare: number; balance: number };

/** Расшифровка расчёта по каждому партнёру + общие расходы и доходы. Баланс — тот же, что в `balances`. */
export function breakdown(partners: BalPartner[], ops: BalOp[]): { lines: BalLine[]; expense: number; income: number } {
  const row = new Map(partners.map((p) => [p.id, { paid: 0, received: 0, gave: 0, got: 0 }]));
  let expense = 0, income = 0;
  for (const o of ops) {
    const a = row.get(o.partnerId);
    if (o.type === "EXPENSE") { expense += o.amountEur; if (a) a.paid += o.amountEur; }
    else if (o.type === "INCOME") { income += o.amountEur; if (a) a.received += o.amountEur; }
    else { if (a) a.gave += o.amountEur; const b = o.toPartnerId ? row.get(o.toPartnerId) : undefined; if (b) b.got += o.amountEur; }
  }
  const bal = balances(partners, ops);
  const shares = partners.reduce((s, p) => s + Math.max(0, p.sharePct), 0) || 1;
  const lines = partners.map((p) => {
    const r = row.get(p.id)!;
    return { id: p.id, name: p.name, sharePct: p.sharePct, paid: round2(r.paid), received: round2(r.received), gave: round2(r.gave), got: round2(r.got), lossShare: round2(((expense - income) * Math.max(0, p.sharePct)) / shares), balance: bal.get(p.id) ?? 0 };
  });
  return { lines, expense: round2(expense), income: round2(income) };
}

/** Операция с датой — для разбивки по месяцам и истории возвратов. `at` — порядок внутри одного дня. */
export type DatedOp = BalOp & { date: string; at?: number };
export type MonthLine = {
  month: string; // 2026-11
  paid: Record<string, number>; received: Record<string, number>;
  settled: Transfer[];
  /** Кто кому должен только за операции этого месяца (возвраты не считаются). */
  own: Transfer[];
  /** Долг на конец месяца нарастающим итогом, с возвратами. */
  end: Transfer[];
};
export type SettleLine = { date: string; fromId: string; from: string; toId: string; to: string; amount: number; /** Долг сразу после этого возврата; пусто — в расчёте. */ after: Transfer[] };

/**
 * Расчёт по месяцам и история возвратов. Долг «за всё время» = сумма месячных итогов минус возвраты,
 * поэтому большой перекос одного месяца может гаситься перекосом другого.
 */
export function ledger(partners: BalPartner[], ops: DatedOp[]): { months: MonthLine[]; settlements: SettleLine[]; closedAt: string | null; firstDate: string | null } {
  const name = new Map(partners.map((p) => [p.id, p.name]));
  const sorted = [...ops].sort((a, b) => a.date.localeCompare(b.date) || (a.at ?? 0) - (b.at ?? 0));
  const months: MonthLine[] = [];
  const settlements: SettleLine[] = [];
  let closedAt: string | null = null;
  const upTo: DatedOp[] = [];
  let cur: MonthLine | null = null;
  let own: DatedOp[] = [];
  const close = () => {
    if (!cur) return;
    cur.own = settlePlan(partners, balances(partners, own));
    cur.end = settlePlan(partners, balances(partners, upTo));
    for (const k in cur.paid) { cur.paid[k] = round2(cur.paid[k]); cur.received[k] = round2(cur.received[k]); }
  };
  for (const o of sorted) {
    const m = o.date.slice(0, 7);
    if (!cur || cur.month !== m) {
      close();
      cur = { month: m, paid: Object.fromEntries(partners.map((p) => [p.id, 0])), received: Object.fromEntries(partners.map((p) => [p.id, 0])), settled: [], own: [], end: [] };
      own = [];
      months.push(cur);
    }
    upTo.push(o);
    if (o.type === "SETTLEMENT") {
      const t = { fromId: o.partnerId, from: name.get(o.partnerId) ?? "?", toId: o.toPartnerId ?? "", to: name.get(o.toPartnerId ?? "") ?? "?", amount: round2(o.amountEur) };
      cur.settled.push(t);
      const after = settlePlan(partners, balances(partners, upTo));
      settlements.push({ date: o.date, ...t, after });
      if (!after.length) closedAt = o.date;
    } else {
      own.push(o);
      if (o.partnerId in cur.paid) cur[o.type === "EXPENSE" ? "paid" : "received"][o.partnerId] += o.amountEur;
    }
  }
  close();
  return { months, settlements, closedAt, firstDate: sorted[0]?.date ?? null };
}

/** Как выйти в ноль минимальным числом переводов (для двух партнёров — одна строка). */
export function settlePlan(partners: BalPartner[], bal: Map<string, number>): Transfer[] {
  const name = new Map(partners.map((p) => [p.id, p.name]));
  const debt = [...bal].filter(([, v]) => v < -0.005).map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
  const cred = [...bal].filter(([, v]) => v > 0.005).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
  const res: Transfer[] = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i].v, cred[j].v);
    if (x >= 0.01) res.push({ fromId: debt[i].id, from: name.get(debt[i].id) ?? "?", toId: cred[j].id, to: name.get(cred[j].id) ?? "?", amount: round2(x) });
    debt[i].v -= x; cred[j].v -= x;
    if (debt[i].v < 0.005) i++;
    if (cred[j].v < 0.005) j++;
  }
  return res;
}
