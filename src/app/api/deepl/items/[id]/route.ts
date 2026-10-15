import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireItem } from "@/lib/deepl/jobs";

export const dynamic = "force-dynamic";

/** GET /api/deepl/items/:id → все версии статьи по этапам (HTML) для просмотра и копирования. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const it = await requireItem(me, id);
    const stages = Array.isArray(it.stages) ? (it.stages as Array<{ key: string; label: string; html: string; chars: number; changedWords?: number; status?: string }>) : [];
    if (!stages.length && it.sourceHtml) stages.push({ key: "source", label: "Исходный", html: it.sourceHtml, chars: it.sourceHtml.length });
    if (it.finalHtml && !stages.some((s) => s.key === "final")) stages.push({ key: "final", label: "Итоговый", html: it.finalHtml, chars: it.finalHtml.length });
    return NextResponse.json({ id: it.id, title: it.title, stages, hasOriginal: !!it.originalWpHtml }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
