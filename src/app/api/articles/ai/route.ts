import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { AiModerationError, aiRunsOverview, insufficientAction, rerunArticles, resolveResult, startAiRun, stopAiRun, type AiResolveOp, type AiRunMode } from "@/lib/articles/aiModeration";
import { ModerationError } from "@/lib/articles/moderation";

export const dynamic = "force-dynamic";
/** Применение решения скачивает фото из резерва — даём маршруту время (standalone-сервер лимита не ставит). */
export const maxDuration = 300;

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** Данные экрана ИИ-модерации: сайты с ожидающими, запуски, решения, «Мало фото». */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  return NextResponse.json(await aiRunsOverview(me), NO_STORE);
}

type Body =
  | { action: "start"; siteId: string; limit?: number; mode?: AiRunMode; articleIds?: string[] }
  | { action: "stop"; runId: string }
  | { action: "resolve"; resultId: string; op: AiResolveOp }
  | { action: "rerun"; resultIds: string[] }
  | { action: "insufficient"; articleId: string; op: "topup" | "return" | "close" };

const OPS: AiResolveOp[] = ["approve", "human", "insufficient", "exclude"];

/**
 * POST {action: start|stop|resolve|rerun|insufficient, …} (оригинал: ai-photo-moderate actions :113-239).
 * Ошибки с кодом 200 (например, «нет свободных статей») возвращаются как {error} без HTTP-ошибки — это сообщение, не сбой.
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "start": {
        if (typeof body.siteId !== "string" || !body.siteId) return NextResponse.json({ error: "Укажите сайт" }, { status: 400 });
        const r = await startAiRun(me, { siteId: body.siteId, limit: Number(body.limit) || 10, mode: body.mode === "test" ? "test" : "auto", articleIds: Array.isArray(body.articleIds) ? body.articleIds.map(String) : undefined });
        return NextResponse.json({ ok: true, ...r }, NO_STORE);
      }
      case "stop": {
        await stopAiRun(me, String(body.runId || ""));
        return NextResponse.json({ ok: true }, NO_STORE);
      }
      case "resolve": {
        if (!OPS.includes(body.op)) return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
        const r = await resolveResult(me, String(body.resultId || ""), body.op);
        return NextResponse.json({ ok: true, ...r }, NO_STORE);
      }
      case "rerun": {
        const r = await rerunArticles(me, Array.isArray(body.resultIds) ? body.resultIds.map(String) : []);
        return NextResponse.json({ ok: true, ...r }, NO_STORE);
      }
      case "insufficient": {
        if (!["topup", "return", "close"].includes(body.op)) return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
        await insufficientAction(me, String(body.articleId || ""), body.op);
        return NextResponse.json({ ok: true }, NO_STORE);
      }
      default:
        return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof AiModerationError) return NextResponse.json({ error: e.message }, { status: e.status === 200 ? 200 : e.status });
    if (e instanceof ModerationError) return NextResponse.json({ error: e.message, stale: e.stale }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
