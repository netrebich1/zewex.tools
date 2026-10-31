/** Проверка расчёта долга: npx tsx scripts/finance/balance-test.ts */
import { balances, settlePlan, type BalOp } from "../../src/lib/finance/balance";

const P = [{ id: "a", name: "Антон", sharePct: 50 }, { id: "n", name: "Никита", sharePct: 50 }];
let fails = 0;
function check(name: string, ops: BalOp[], want: string) {
  const plan = settlePlan(P, balances(P, ops));
  const got = plan.map((t) => `${t.from}→${t.to} ${t.amount}`).join(", ") || "в расчёте";
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${got}${ok ? "" : ` (ждали ${want})`}`);
}
const e = (p: string, v: number): BalOp => ({ type: "EXPENSE", amountEur: v, partnerId: p, toPartnerId: null });
const i = (p: string, v: number): BalOp => ({ type: "INCOME", amountEur: v, partnerId: p, toPartnerId: null });
const s = (from: string, to: string, v: number): BalOp => ({ type: "SETTLEMENT", amountEur: v, partnerId: from, toPartnerId: to });

check("пусто", [], "в расчёте");
check("Антон заплатил 100", [e("a", 100)], "Никита→Антон 50");
check("100 / 40 / доход 50 у Никиты", [e("a", 100), e("n", 40), i("n", 50)], "Никита→Антон 55");
check("…и возврат 55", [e("a", 100), e("n", 40), i("n", 50), s("n", "a", 55)], "в расчёте");
// Прибыль 200 пополам; Никита ещё и вложил 20 — ему 100 + 20.
check("прибыль у Антона", [e("n", 20), i("a", 220)], "Антон→Никита 120");
check("переплата возвратом", [e("a", 100), s("n", "a", 80)], "Антон→Никита 30");
const P3 = [{ id: "a", name: "A", sharePct: 70 }, { id: "n", name: "N", sharePct: 30 }];
const b = balances(P3, [e("a", 100)]);
console.log(b.get("a") === 30 && b.get("n") === -30 ? "OK   доли 70/30" : (fails++, `FAIL доли 70/30: ${[...b]}`));
process.exit(fails ? 1 : 0);
