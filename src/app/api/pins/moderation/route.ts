import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { applyDecisions, approveAllInScope, moderationBatch, type Decision } from "@/lib/pins/runs/moderation";

export const dynamic = "force-dynamic";

/** GET: пачка непроверенных пинов. Параметры: site, run, engine, cursor, limit. */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const u = new URL(req.url);
  const r = await moderationBatch(me, {
    siteId: u.searchParams.get("site") || undefined,
    runId: u.searchParams.get("run") || undefined,
    engine: u.searchParams.get("engine") || undefined,
    cursor: u.searchParams.get("cursor") || undefined,
    limit: Math.min(200, Math.max(1, Number(u.searchParams.get("limit")) || 60)),
    view: u.searchParams.get("view") === "post" ? "post" : "pre",
  });
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}

/** POST: пакет решений { decisions: [{ id, moderation }] }. */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  let body: { decisions?: Decision[]; post?: boolean; all?: { siteId?: string; runId?: string; engine?: string; reject?: string[] } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Нужен JSON" }, { status: 400 });
  }
  // «Одобрить все»: вся очередь в рамках фильтра одним запросом.
  if (body.all) {
    const a = body.all;
    const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const reject = Array.isArray(a.reject) ? a.reject.filter((x): x is string => typeof x === "string") : [];
    return NextResponse.json(await approveAllInScope(me, { siteId: s(a.siteId), runId: s(a.runId), engine: s(a.engine), view: body.post === true ? "post" : "pre" }, reject));
  }
  const decisions = (body.decisions ?? []).filter((d) => typeof d?.id === "string" && (d.moderation === "APPROVED" || d.moderation === "REJECTED"));
  const r = await applyDecisions(me, decisions, { post: body.post === true });
  return NextResponse.json(r);
}
