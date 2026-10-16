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
