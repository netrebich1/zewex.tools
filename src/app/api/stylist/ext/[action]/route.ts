import { NextResponse } from "next/server";
import { ExtError, authExt, extVersion, handleItem, looksFor } from "@/lib/stylist/ext";

export const dynamic = "force-dynamic";

/**
 * API расширения «Zewex Стилист»: POST /api/stylist/ext/{hello|item}.
 * Вход — токен расширения (Authorization: Bearer zxs_…), не сессия портала. Протокол — src/lib/stylist/ext.ts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  try {
    const ctx = await authExt(req);
    const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const latest = await extVersion();
    if (action === "hello") return NextResponse.json({ ok: true, user: ctx.userName, looks: await looksFor(ctx), latest });
    if (action === "item") return NextResponse.json({ ...(await handleItem(ctx, body)), latest });
    return NextResponse.json({ error: "Неизвестное действие" }, { status: 404 });
  } catch (e) {
    if (e instanceof ExtError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error(`[stylist] ext ${action} failed`, e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
