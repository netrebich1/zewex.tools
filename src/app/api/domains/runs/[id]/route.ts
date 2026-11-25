import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { parseSettings, requireRun, runDomains } from "@/lib/domains/runs";

export const dynamic = "force-dynamic";

/** GET /api/domains/runs/:id → состояние подбора и все проверенные домены (для живой страницы). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const run = await requireRun(me, id);
    const domains = await runDomains(id);
    return NextResponse.json(
      {
        run: {
          id: run.id,
          name: run.name,
          status: run.status,
          progress: run.progress,
          totalChecked: run.totalChecked,
          totalAvailable: run.totalAvailable,
          incompleteBrands: run.incompleteBrands ?? [],
          error: run.error,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          settings: parseSettings(run.settings),
        },
        domains,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
