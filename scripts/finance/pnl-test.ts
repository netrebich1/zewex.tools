/** Проверка P&L: npx tsx scripts/finance/pnl-test.ts */
import { pnlOf } from "../../src/lib/finance/report";

const cats = [
  { id: "rev", name: "Партнёрки", pnl: "REVENUE" }, { id: "ai", name: "ИИ и API", pnl: "COGS" },
  { id: "srv", name: "Сервисы", pnl: "OPEX" }, { id: "tax", name: "Комиссии", pnl: "TAX" }, { id: "oth", name: "Прочее", pnl: "OTHER" },
];
const per = new Map<string | null, { income: number; expense: number }>([
  ["rev", { income: 1000, expense: 0 }], ["ai", { income: 0, expense: 200 }], ["srv", { income: 0, expense: 150 }],
  ["tax", { income: 0, expense: 20 }], ["oth", { income: 10, expense: 40 }], [null, { income: 5, expense: 15 }],
]);
const r = pnlOf(per, cats);
// выручка 1000+5=1005; валовая 1005-200=805; операционная 805-(150+15)=640; чистая 640-20+(10-40)=590
const want = { revenue: 1005, gross: 805, operating: 640, net: 590 };
const got = { revenue: r.revenue, gross: r.gross, operating: r.operating, net: r.net };
const ok = JSON.stringify(got) === JSON.stringify(want);
console.log(ok ? "OK   P&L" : `FAIL P&L ${JSON.stringify(got)} ждали ${JSON.stringify(want)}`);
process.exit(ok ? 0 : 1);
