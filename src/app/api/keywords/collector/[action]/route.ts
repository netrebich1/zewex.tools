import { NextResponse } from "next/server";
import { authCollector, CollectorError, fail, finish, hello, next, search, state, volume, type Ctx } from "@/lib/keywords/collector";
import { extensionVersion } from "@/lib/keywords/extension";

export const dynamic = "force-dynamic";

type Handler = (ctx: Ctx, body: Record<string, unknown>) => Promise<unknown>;
const ACTIONS: Record<string, Handler> = { hello, next, search, finish, volume, fail, state };

/**
 * API расширения «Zewex Collector»: POST /api/keywords/collector/{hello|next|search|finish|volume|fail|state}.
 * Вход — токен расширения (Authorization: Bearer zxc_…), не сессия портала. Протокол — src/lib/keywords/collector.ts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const fn = ACTIONS[action];
  if (!fn) return NextResponse.json({ error: "Неизвестное действие", code: "bad_action" }, { status: 404 });
  try {
    const ctx = await authCollector(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const res = await fn(ctx, body && typeof body === "object" ? body : {});
    // Актуальная версия расширения в каждом ответе: окно расширения подскажет обновиться.
    return NextResponse.json(res && typeof res === "object" ? { ...res, latest: await extensionVersion() } : res);
  } catch (e) {
    if (e instanceof CollectorError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    console.error(`[keywords] collector ${action} failed`, e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), code: "server" }, { status: 500 });
  }
}
