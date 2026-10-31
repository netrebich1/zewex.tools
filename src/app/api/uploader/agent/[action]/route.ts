import { NextResponse } from "next/server";
import { authAgent, UploaderError, fail, finish, hello, next, profiles, progress, state, type Ctx } from "@/lib/uploader/agent";
import { agentLatestVersion, agentZipExists, agentZipRel } from "@/lib/uploader/release";
import { publicUrl } from "@/lib/pins/storage";

export const dynamic = "force-dynamic";

type Handler = (ctx: Ctx, body: Record<string, unknown>) => Promise<unknown>;
const ACTIONS: Record<string, Handler> = { hello, profiles, next, progress, finish, fail, state };

/**
 * API агента «Zewex Uploader»: POST /api/uploader/agent/{hello|profiles|next|progress|finish|fail|state}.
 * Вход — токен агента (Authorization: Bearer zxu_…), не сессия портала. Протокол — src/lib/uploader/agent.ts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const fn = ACTIONS[action];
  if (!fn) return NextResponse.json({ error: "Неизвестное действие", code: "bad_action" }, { status: 404 });
  try {
    const ctx = await authAgent(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const res = await fn(ctx, body && typeof body === "object" ? body : {});
    const latest = await agentLatestVersion();
    const latestUrl = (await agentZipExists(latest)) ? publicUrl(agentZipRel(latest)) : null;
    return NextResponse.json(res && typeof res === "object" ? { ...res, latest, latestUrl } : res);
  } catch (e) {
    if (e instanceof UploaderError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    console.error(`[uploader] agent ${action} failed`, e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), code: "server" }, { status: 500 });
  }
}
