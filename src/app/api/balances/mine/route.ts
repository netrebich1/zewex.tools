import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { myKeyBalances } from "@/lib/balances";
import { canSeeBalances, showsBalances } from "@/lib/permissions";

export const dynamic = "force-dynamic";

/**
 * Остатки на ключах команды сотрудника в открытых ему инструментах — всем, у кого балансы не скрыты.
 * ?refresh=1 заново опрашивает провайдеров только у тех, кому открыты балансы; остальным хватает кэша на 5 минут.
 */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  if (!showsBalances(me)) return NextResponse.json({ error: "Нет прав смотреть балансы" }, { status: 403 });
  const force = canSeeBalances(me) && new URL(req.url).searchParams.get("refresh") === "1";
  return NextResponse.json(await myKeyBalances(me.id, me.perms.tools, force), { headers: { "Cache-Control": "no-store" } });
}
