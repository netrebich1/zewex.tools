import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { loadProjectFor } from "@/lib/news/access";

export const dynamic = "force-dynamic";

/** GET /api/news/state?project= → идущий прогон и отметка последнего изменения ленты (опрос живой страницы). */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("project") ?? "";
  try {
    const p = await loadProjectFor(me, id);
    const [active, lastDone, lastCluster] = await Promise.all([
      prisma.newsRun.findFirst({ where: { projectId: p.id, status: { in: ["queued", "running"] } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, step: true, kind: true, startedAt: true, stats: true } }),
      prisma.newsRun.findFirst({ where: { projectId: p.id, status: { in: ["done", "failed"] } }, orderBy: { finishedAt: "desc" }, select: { id: true, finishedAt: true } }),
      prisma.newsCluster.findFirst({ where: { projectId: p.id }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    ]);
    const st = (active?.stats ?? {}) as { fetched?: number; fresh?: number; classified?: number };
    return NextResponse.json(
      {
        active: active ? { status: active.status, step: active.step, kind: active.kind, startedAt: active.startedAt, fetched: st.fetched ?? 0, fresh: st.fresh ?? 0, classified: st.classified ?? 0 } : null,
        version: `${lastDone?.id ?? ""}:${lastCluster?.updatedAt.toISOString() ?? ""}`,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
