import { prisma } from "@/lib/db";
import { resolveSlot, runSlot, disableKey, type ResolvedSlot } from "@/lib/run";
import { PROJECT_SLUG, SLOT_IMAGE_MAIN, SLOT_TEXT_FAST, SLOT_TEXT_MAIN } from "../types";
import { AiError, classifyAiError } from "./errors";
import { acquire, DEFAULT_LIMITS } from "./limiter";
import { parseJsonLenient } from "./json";

/**
 * Клиент ИИ для сервиса пинов поверх прокси портала (resolve → runSlot → UsageLog).
 * Ключ выбирается правилами портала для пользователя, запустившего прогон.
 */

export type AiCtx = { userId: string; teamId: string; runId?: string; siteId?: string; signal?: AbortSignal };

export type ChatRequest = {
  system?: string;
  user: string | Array<Record<string, unknown>>;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

export type ChatResult = { text: string; json: unknown; costUsd: number | null; model: string | null };

async function resolveOrThrow(userId: string, slotKey: string): Promise<ResolvedSlot> {
  const r = await resolveSlot(userId, PROJECT_SLUG, slotKey);
  if (!r.ok) throw new AiError({ code: r.status === 409 ? "no_binding" : "resolve", kind: "fatal_run", message: r.error }, r.status);
  return r.value;
}

async function handleFailure(ctx: AiCtx, res: { status: number; error?: string }, apiKeyId: string, keyLabel: string): Promise<never> {
  const cls = classifyAiError(res.status, res.error ?? "");
  if (cls.kind === "fatal_run" && (cls.code === "no_credits" || cls.code === "auth")) {
    await disableKey(apiKeyId, `Автоотключён: ${cls.code === "no_credits" ? "закончился баланс" : "ключ отклонён провайдером"} (${cls.message.slice(0, 120)})`);
    cls.message = `Ключ «${keyLabel}»: ${cls.message}`;
  }
  throw new AiError(cls, res.status);
}

export async function aiChat(ctx: AiCtx, slot: typeof SLOT_TEXT_MAIN | typeof SLOT_TEXT_FAST, req: ChatRequest): Promise<ChatResult> {
  const resolved = await resolveOrThrow(ctx.userId, slot);
  const release = await acquire(resolved.binding.apiKey.id, DEFAULT_LIMITS.CHAT);
  try {
    const messages: Array<Record<string, unknown>> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.user });
    const payload: Record<string, unknown> = { messages, temperature: req.temperature ?? 0.7 };
    if (req.maxTokens) payload.max_tokens = req.maxTokens;
    if (req.json) payload.response_format = { type: "json_object" };
    const res = await runSlot({
      userId: ctx.userId,
      projectSlug: PROJECT_SLUG,
      slotKey: slot,
      payload,
      timeoutMs: req.timeoutMs ?? 90_000,
      signal: ctx.signal,
      meta: { teamId: ctx.teamId, refId: ctx.runId },
      pre: resolved,
    });
    if (!res.ok) await handleFailure(ctx, res, resolved.binding.apiKey.id, resolved.binding.apiKey.label);
    const data = res.data as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
    const raw = data?.choices?.[0]?.message?.content;
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p) => p?.text ?? "").join("") : "";
    return { text, json: req.json ? parseJsonLenient(text) : null, costUsd: res.meta?.costUsd ?? null, model: res.meta?.model ?? null };
  } finally {
    release();
  }
}

export type ImageRequest = { prompt: string; size?: "1024x1536" | "1024x1024"; quality?: "low" | "medium" | "high"; timeoutMs?: number };
export type ImageResult = { bytes: Buffer; mime: string; costUsd: number | null; model: string | null };

export async function aiImage(ctx: AiCtx, req: ImageRequest): Promise<ImageResult> {
  const resolved = await resolveOrThrow(ctx.userId, SLOT_IMAGE_MAIN);
  const release = await acquire(resolved.binding.apiKey.id, DEFAULT_LIMITS.IMAGE);
  try {
    const res = await runSlot({
      userId: ctx.userId,
      projectSlug: PROJECT_SLUG,
      slotKey: SLOT_IMAGE_MAIN,
      payload: { prompt: req.prompt, n: 1, size: req.size ?? "1024x1536", quality: req.quality ?? "low" },
      timeoutMs: req.timeoutMs ?? 240_000,
      signal: ctx.signal,
      meta: { teamId: ctx.teamId, refId: ctx.runId },
      pre: resolved,
    });
    if (!res.ok) await handleFailure(ctx, res, resolved.binding.apiKey.id, resolved.binding.apiKey.label);
    const data = res.data as { data?: Array<{ b64_json?: string; url?: string }> };
    const first = data?.data?.[0];
    if (first?.b64_json) return { bytes: Buffer.from(first.b64_json, "base64"), mime: "image/png", costUsd: res.meta?.costUsd ?? null, model: res.meta?.model ?? null };
    if (first?.url) {
      const r = await fetch(first.url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new AiError(classifyAiError(r.status, `image download ${r.status}`), r.status);
      return { bytes: Buffer.from(await r.arrayBuffer()), mime: r.headers.get("content-type") || "image/png", costUsd: res.meta?.costUsd ?? null, model: res.meta?.model ?? null };
    }
    throw new AiError({ code: "empty", kind: "transient", message: "Провайдер вернул пустой ответ без картинки" }, 502);
  } finally {
    release();
  }
}

/** Сумма расходов прогона по журналу портала (для cost guard и карточки прогона). */
export async function runCost(runId: string): Promise<number> {
  const agg = await prisma.usageLog.aggregate({ _sum: { costUsd: true }, where: { refId: runId } });
  return agg._sum.costUsd ?? 0;
}
