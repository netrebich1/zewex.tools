import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getRunForUser } from "@/lib/pins/runs/actions";
import { runStatus } from "@/lib/pins/runs/status";

export const dynamic = "force-dynamic";

/** Агрегированный статус прогона: один запрос вместо выгрузки элементов. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const { id } = await ctx.params;
  const run = await getRunForUser(me, id);
  if (!run) return NextResponse.json({ error: "Прогон не найден" }, { status: 404 });
  const view = await runStatus(id);
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
