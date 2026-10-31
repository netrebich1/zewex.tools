import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { pinRunWhere } from "@/lib/sites/access";
import { runsOverview } from "@/lib/pins/runs/status";

export const dynamic = "force-dynamic";

/** Сводка по последним прогонам команд пользователя для живой доски на «Сегодня». */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const rows = await runsOverview(await pinRunWhere(me));
  return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
}
