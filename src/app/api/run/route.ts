import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runSlot } from "@/lib/run";

/**
 * Internal AI/data proxy for tools.
 * POST /api/run  { project: "<slug>", slot: "<key>", payload: {...} }
 * Auth: the portal session cookie (tools run under the same domain).
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ ok: false, error: "Не авторизован" }, { status: 401 });
  let body: { project?: string; slot?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Тело запроса должно быть JSON" }, { status: 400 });
  }
  if (!body.project || !body.slot) return NextResponse.json({ ok: false, error: "Укажите project и slot" }, { status: 400 });
  const r = await runSlot({ userId: me.id, projectSlug: body.project, slotKey: body.slot, payload: body.payload ?? {} });
  return NextResponse.json(r, { status: r.status });
}
