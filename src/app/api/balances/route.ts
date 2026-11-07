import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { providerBalances } from "@/lib/balances";
import { canSeeBalances } from "@/lib/permissions";

export const dynamic = "force-dynamic";

/** Балансы OpenRouter / laozhang / OpenAI для меню — админам и сотрудникам с правом «балансы». ?refresh=1 сбрасывает кэш. */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  if (!canSeeBalances(me)) return NextResponse.json({ error: "Нет прав смотреть балансы" }, { status: 403 });
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const rows = await providerBalances(force);
  return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
}
