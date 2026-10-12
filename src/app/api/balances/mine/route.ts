import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { myKeyBalances } from "@/lib/balances";
import { canSeeBalances } from "@/lib/permissions";

export const dynamic = "force-dynamic";

/**
 * Остатки на ключах, которые обслуживают самого сотрудника в его инструментах, — любому вошедшему.
 * ?refresh=1 заново опрашивает провайдеров только у тех, кому открыты балансы; остальным хватает кэша на 5 минут.
 */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const force = canSeeBalances(me) && new URL(req.url).searchParams.get("refresh") === "1";
  return NextResponse.json(await myKeyBalances(me.id, force), { headers: { "Cache-Control": "no-store" } });
}
