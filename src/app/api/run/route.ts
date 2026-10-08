import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runSlot } from "@/lib/run";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Browser requests must come from the portal itself (or a host explicitly allowed via API_ALLOWED_ORIGINS). */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser client (curl, server-to-server)
  const allowed = new Set<string>();
  if (process.env.APP_URL) allowed.add(new URL(process.env.APP_URL).origin);
  for (const o of (process.env.API_ALLOWED_ORIGINS ?? "").split(",")) if (o.trim()) allowed.add(o.trim());
  return allowed.has(origin);
}

/**
 * Internal AI/data proxy for tools.
 * POST /api/run  { project: "<slug>", slot: "<key>", payload: {...} }
 * Auth: the portal session cookie (tools run under the same domain).
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ ok: false, error: "Не авторизован" }, { status: 401 });
  if (!originAllowed(req)) return NextResponse.json({ ok: false, error: "Запрос с чужого домена" }, { status: 403 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return NextResponse.json({ ok: false, error: "Слишком большой запрос" }, { status: 413 });
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
