import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { resolveBinding } from "@/lib/resolve";
import { prisma } from "@/lib/db";
import { routeCheckScope } from "@/lib/permissions";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const url = new URL(req.url);
  const slotId = url.searchParams.get("slotId") ?? "";
  let userId = url.searchParams.get("userId") ?? me.id;
  // За другого человека: «любые правила» — за кого угодно, уровень команды — за участников своих команд.
  if (userId !== me.id) {
    const scope = routeCheckScope(me);
    if (scope !== "all") {
      const shared = scope.length ? await prisma.teamMember.count({ where: { userId, teamId: { in: scope } } }) : 0;
      if (!shared) userId = me.id;
    }
  }
  if (!slotId) return NextResponse.json({ error: "slotId обязателен" }, { status: 400 });
  try {
    const r = await resolveBinding(userId, slotId);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
