import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { jobItems, requireJob } from "@/lib/deepl/jobs";

export const dynamic = "force-dynamic";

/** GET /api/deepl/jobs/:id → статус прогона и статьи без HTML (опрос живой страницы). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const job = await requireJob(me, id);
    return NextResponse.json(
      { job: { id: job.id, status: job.status, stopRequested: job.stopRequested, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt }, items: await jobItems(id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
