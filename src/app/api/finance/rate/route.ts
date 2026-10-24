import { NextResponse } from "next/server";
import { financeUser } from "@/lib/finance/access";
import { rateToEur } from "@/lib/finance/rates";
import { normCur, todayYmd } from "@/lib/finance/currency";

export const dynamic = "force-dynamic";

/** GET /api/finance/rate?cur=USD&date=YYYY-MM-DD → { rate: EUR за 1 единицу, date, stale } — подсказка в форме операции. */
export async function GET(req: Request) {
  if (!(await financeUser())) return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
  const u = new URL(req.url);
  const cur = normCur(u.searchParams.get("cur") ?? "");
  const date = u.searchParams.get("date") ?? "";
  if (!cur) return NextResponse.json({ error: "Укажите валюту" }, { status: 400 });
  const r = await rateToEur(cur, /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayYmd());
  return r ? NextResponse.json(r) : NextResponse.json({ error: `Нет курса ${cur}` }, { status: 404 });
}
