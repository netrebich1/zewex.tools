import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { requireRun } from "@/lib/social/runs";

export const dynamic = "force-dynamic";

/** GET /api/social/runs/:id → статус и счётчики (опрос живой страницы прогона). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const run = await requireRun(me, id);
    const groups = await prisma.socialItem.groupBy({ by: ["status"], where: { runId: id }, _count: { _all: true } });
    const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    return NextResponse.json({ status: run.status, total: run.total, done: n("done"), error: n("error"), processing: n("processing") }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
