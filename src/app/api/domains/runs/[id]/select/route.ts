import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { setSelection } from "@/lib/domains/runs";

export const dynamic = "force-dynamic";

/** POST /api/domains/runs/:id/select { changes: [{ id, selected }] } → ручной выбор доменов. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const { id } = await ctx.params;
  let body: { changes?: Array<{ id?: string; selected?: boolean }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса должно быть JSON" }, { status: 400 });
  }
  const changes = (body.changes ?? []).filter((c) => typeof c.id === "string").map((c) => ({ id: String(c.id), selected: Boolean(c.selected) })).slice(0, 5000);
  try {
    const n = await setSelection(me, id, changes);
    return NextResponse.json({ ok: true, updated: n });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
