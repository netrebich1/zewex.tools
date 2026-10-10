/**
 * ИИ-клиент сервиса статей поверх прокси портала (resolveSlot → runSlot → UsageLog).
 * Ключ выбирается правилами портала для пользователя, запустившего статью; модель — из рецепта (`provider:model`),
 * если она совпадает по провайдеру с ключом, иначе модель правила. Расход пишется с refId = id статьи.
 * Один вызов = одна попытка на один ключ; повторы и фолбэки — по классу ошибки (transient → backoff в этапе).
 */
import { prisma } from "@/lib/db";
import { resolveSlot, runSlot, disableKey, type ResolvedSlot } from "@/lib/run";
import { AiError, classifyAiError } from "@/lib/pins/ai/errors";
import { acquire, DEFAULT_LIMITS } from "@/lib/pins/ai/limiter";
import { parseJsonLenient } from "@/lib/pins/ai/json";
import { PROJECT_SLUG, SLOTS, type SlotKey } from "./types";

export type AiCtx = { userId: string; teamId: string; articleId?: string; siteId?: string; signal?: AbortSignal };

/** Часть мультимодального сообщения: текст или картинка (data URL или https). */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export type ChatRequest = {
  /** Ключ слота: text_main / text_fast / vision */
  slot: SlotKey;
  /** Модель из рецепта (`provider:model`); пусто — модель правила */
  model?: string;
  system?: string;
  user: string | ContentPart[];
  /** Прежние реплики (для repair-вызовов) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Отключить рассуждения у моделей с reasoning (оригинал: effort none) */
  noReasoning?: boolean;
};

export type ChatResult = { text: string; json: unknown; costUsd: number | null; model: string | null; inputTokens: number; outputTokens: number; durationMs: number };

async function resolveOrThrow(userId: string, slotKey: string): Promise<ResolvedSlot> {
  const r = await resolveSlot(userId, PROJECT_SLUG, slotKey);
  if (!r.ok) throw new AiError({ code: r.status === 409 ? "no_binding" : "resolve", kind: "fatal_run", message: r.error }, r.status);
  return r.value;
}

async function handleFailure(res: { status: number; error?: string }, apiKeyId: string, keyLabel: string): Promise<never> {
  const cls = classifyAiError(res.status, res.error ?? "");
  if (cls.kind === "fatal_run" && (cls.code === "no_credits" || cls.code === "auth")) {
    await disableKey(apiKeyId, `Автоотключён: ${cls.code === "no_credits" ? "закончился баланс" : "ключ отклонён провайдером"} (${cls.message.slice(0, 120)})`);
    cls.message = `Ключ «${keyLabel}»: ${cls.message}`;
  }
  throw new AiError(cls, res.status);
}

function extractText(data: unknown): string {
  const d = data as { choices?: Array<{ message?: { content?: string | Array<{ text?: string; type?: string }> } }> };
  const raw = d?.choices?.[0]?.message?.content;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((p) => p?.text ?? "").join("");
  return "";
}

export async function aiChat(ctx: AiCtx, req: ChatRequest): Promise<ChatResult> {
  const resolved = await resolveOrThrow(ctx.userId, req.slot);
  const release = await acquire(resolved.binding.apiKey.id, DEFAULT_LIMITS.CHAT);
  try {
    const messages: Array<Record<string, unknown>> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const h of req.history ?? []) messages.push(h);
    messages.push({ role: "user", content: req.user });
    const payload: Record<string, unknown> = { messages, temperature: req.temperature ?? 0.7 };
    if (req.maxTokens) payload.max_tokens = req.maxTokens;
    if (req.json) payload.response_format = { type: "json_object" };
    if (req.noReasoning !== false) payload.reasoning = { effort: "none" };
    const res = await runSlot({
      userId: ctx.userId,
      projectSlug: PROJECT_SLUG,
      slotKey: req.slot,
      payload,
      model: req.model,
      timeoutMs: req.timeoutMs ?? 120_000,
      signal: ctx.signal,
      meta: { teamId: ctx.teamId, refId: ctx.articleId },
      pre: resolved,
    });
    if (!res.ok) await handleFailure(res, resolved.binding.apiKey.id, resolved.binding.apiKey.label);
    const text = extractText(res.data);
    if (!text.trim()) throw new AiError({ code: "empty", kind: "transient", message: "Модель вернула пустой ответ" }, 502);
    return {
      text,
      json: req.json ? parseJsonLenient(text) : null,
      costUsd: res.meta?.costUsd ?? null,
      model: res.meta?.model ?? null,
      inputTokens: res.meta?.inputTokens ?? 0,
      outputTokens: res.meta?.outputTokens ?? 0,
      durationMs: res.meta?.durationMs ?? 0,
    };
  } finally {
    release();
  }
}

/** Картинка как часть сообщения из буфера (JPEG/PNG/WebP). */
export function imagePart(bytes: Buffer, mime = "image/jpeg", detail: "low" | "high" | "auto" = "auto"): ContentPart {
  return { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}`, detail } };
}

export type ImageRequest = { prompt: string; size?: string; quality?: "low" | "medium" | "high"; model?: string; timeoutMs?: number; references?: Array<{ bytes: Buffer; mime: string; name: string }> };
export type ImageResult = { bytes: Buffer; mime: string; costUsd: number | null; model: string | null };

/** Генерация картинки (формат «ИИ-фото»). Референсы — multipart /images/edits в адаптере портала, если он их поддерживает. */
export async function aiImage(ctx: AiCtx, req: ImageRequest): Promise<ImageResult> {
  const resolved = await resolveOrThrow(ctx.userId, SLOTS.image);
  const release = await acquire(resolved.binding.apiKey.id, DEFAULT_LIMITS.IMAGE);
  try {
    const res = await runSlot({
      userId: ctx.userId,
      projectSlug: PROJECT_SLUG,
      slotKey: SLOTS.image,
      payload: { prompt: req.prompt, n: 1, size: req.size ?? "1024x1536", quality: req.quality ?? "low" },
      model: req.model,
      timeoutMs: req.timeoutMs ?? 240_000,
      signal: ctx.signal,
      meta: { teamId: ctx.teamId, refId: ctx.articleId },
      pre: resolved,
    });
    if (!res.ok) await handleFailure(res, resolved.binding.apiKey.id, resolved.binding.apiKey.label);
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

/** DataForSEO: произвольный endpoint v3 через слот photo_dfs. Возвращает тело ответа целиком. */
export async function dfsRequest(ctx: AiCtx, endpoint: string, body: unknown[], timeoutMs = 130_000): Promise<{ ok: boolean; status: number; data: unknown; error?: string; costUsd: number | null }> {
  const r = await resolveSlot(ctx.userId, PROJECT_SLUG, SLOTS.photoDfs);
  if (!r.ok) return { ok: false, status: r.status, data: null, error: r.error, costUsd: null };
  const res = await runSlot({ userId: ctx.userId, projectSlug: PROJECT_SLUG, slotKey: SLOTS.photoDfs, payload: { endpoint, body }, timeoutMs, signal: ctx.signal, meta: { teamId: ctx.teamId, refId: ctx.articleId }, pre: r.value });
  return { ok: res.ok, status: res.status, data: res.data, error: res.error, costUsd: res.meta?.costUsd ?? null };
}

/** SerpAPI: параметры запроса через слот photo_serp (ключ добавит адаптер). */
export async function serpRequest(ctx: AiCtx, params: Record<string, string | number | undefined>, timeoutMs = 60_000): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const r = await resolveSlot(ctx.userId, PROJECT_SLUG, SLOTS.photoSerp);
  if (!r.ok) return { ok: false, status: r.status, data: null, error: r.error };
  const res = await runSlot({ userId: ctx.userId, projectSlug: PROJECT_SLUG, slotKey: SLOTS.photoSerp, payload: params, timeoutMs, signal: ctx.signal, meta: { teamId: ctx.teamId, refId: ctx.articleId }, pre: r.value });
  return { ok: res.ok, status: res.status, data: res.data, error: res.error };
}

/** Есть ли у пользователя правило для слота (без вызова). */
export async function slotAvailable(userId: string, slot: SlotKey): Promise<boolean> {
  const r = await resolveSlot(userId, PROJECT_SLUG, slot);
  return r.ok;
}

/** Сумма расходов статьи по журналу портала. */
export async function articleCost(articleId: string): Promise<number> {
  const agg = await prisma.usageLog.aggregate({ _sum: { costUsd: true }, where: { refId: articleId } });
  return agg._sum.costUsd ?? 0;
}
