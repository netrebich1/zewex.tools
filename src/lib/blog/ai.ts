/**
 * ИИ-клиент сервиса инфо-статей поверх прокси портала (resolveSlot → runSlot → UsageLog) — копия клиента статей
 * (src/lib/articles/ai.ts) под проект `blog`: свои слоты и правила ключей, расход с refId = id поста.
 * Поведение то же: ключ по правилам портала для автора запуска, модель из рецепта (`provider:model`), «нет средств /
 * ключ отклонён» — ошибка класса fatal_run (пост ждёт рабочий ключ), автотормоз ключа при 429, явный кэш системного
 * промта для Gemini через OpenRouter (`cacheSystem`).
 */
import { prisma } from "@/lib/db";
import { resolveSlot, runSlot, disableKey, parseModelSpec, type ResolvedSlot } from "@/lib/run";
import { isOpenRouter } from "@/lib/adapters";
import { AiError, classifyAiError, type ClassifiedError } from "@/lib/pins/ai/errors";
import { acquire, DEFAULT_LIMITS } from "@/lib/pins/ai/limiter";
import { parseJsonLenient } from "@/lib/pins/ai/json";
import { PROJECT_SLUG, SLOTS, type SlotKey } from "./types";

export type AiCtx = { userId: string; teamId: string; postId?: string; siteId?: string; signal?: AbortSignal };

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export type ChatRequest = {
  slot: SlotKey;
  model?: string;
  system?: string;
  user: string | ContentPart[];
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  noReasoning?: boolean;
  cacheSystem?: boolean;
};

export type ChatResult = { text: string; json: unknown; costUsd: number | null; model: string | null; inputTokens: number; outputTokens: number; durationMs: number };

export class BlogAiError extends AiError {
  constructor(cls: ClassifiedError, status: number, public readonly provider?: string, public readonly keyLabel?: string) {
    super(cls, status);
    this.name = "BlogAiError";
  }
}

const BRAKE_MIN = 2;
const BRAKE_COOL_MS = 3 * 60_000;
const INPLACE_RETRY_MS = [3_000, 10_000];
const brakes = new Map<string, { limit: number; coolUntil: number }>();

function keyLimit(keyId: string): number {
  return brakes.get(keyId)?.limit ?? DEFAULT_LIMITS.CHAT;
}
function brakeOn(keyId: string): void {
  const cur = keyLimit(keyId);
  brakes.set(keyId, { limit: Math.max(BRAKE_MIN, Math.floor(cur / 2)), coolUntil: Date.now() + BRAKE_COOL_MS });
}
function brakeRelax(keyId: string): void {
  const b = brakes.get(keyId);
  if (!b || Date.now() < b.coolUntil) return;
  if (b.limit + 1 >= DEFAULT_LIMITS.CHAT) brakes.delete(keyId);
  else brakes.set(keyId, { ...b, limit: b.limit + 1 });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

const NO_CREDITS_COOLDOWN_MS = 5 * 60_000;
const noCredits = new Map<string, { until: number; err: BlogAiError }>();

async function resolveOrThrow(userId: string, slotKey: string): Promise<ResolvedSlot> {
  const r = await resolveSlot(userId, PROJECT_SLUG, slotKey);
  if (!r.ok) throw new BlogAiError({ code: r.status === 409 ? "no_binding" : "resolve", kind: "fatal_run", message: r.error }, r.status);
  return r.value;
}

function checkCooldown(apiKeyId: string): void {
  const c = noCredits.get(apiKeyId);
  if (!c) return;
  if (c.until > Date.now()) throw c.err;
  noCredits.delete(apiKeyId);
}

async function handleFailure(res: { status: number; error?: string }, resolved: ResolvedSlot): Promise<never> {
  const key = resolved.binding.apiKey;
  const provider = resolved.binding.provider.name;
  const text = res.error ?? "";
  let cls: ClassifiedError = classifyAiError(res.status, text);
  if (/исчерпал месячный лимит/i.test(text)) cls = { code: "month_limit", kind: "fatal_run", message: text.slice(0, 500) };
  else if (res.status === 409) cls = { code: "config", kind: "fatal_run", message: text.slice(0, 500) };
  if (cls.kind === "fatal_run" && cls.code === "auth") {
    await disableKey(key.id, `Автоотключён: ключ отклонён провайдером (${cls.message.slice(0, 120)})`).catch(() => {});
  }
  if (cls.kind === "fatal_run") cls = { ...cls, message: `Ключ «${key.label}»: ${cls.message}` };
  const err = new BlogAiError(cls, res.status, provider, key.label);
  if (cls.code === "no_credits" || cls.code === "month_limit") noCredits.set(key.id, { until: Date.now() + NO_CREDITS_COOLDOWN_MS, err });
  throw err;
}

function extractText(data: unknown): string {
  const d = data as { choices?: Array<{ message?: { content?: string | Array<{ text?: string; type?: string }> } }> };
  const raw = d?.choices?.[0]?.message?.content;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((p) => p?.text ?? "").join("");
  return "";
}

export async function aiChat(ctx: AiCtx, req: ChatRequest): Promise<ChatResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await aiChatOnce(ctx, req);
    } catch (e) {
      const keyId = (e as { keyId?: string }).keyId;
      const code = e instanceof AiError ? e.cls.code : "";
      const brake = code === "rate_limited" || code === "empty";
      if (!(e instanceof AiError) || !brake || !keyId) throw e;
      brakeOn(keyId);
      const maxRetries = code === "empty" ? 1 : INPLACE_RETRY_MS.length;
      if (attempt >= maxRetries || ctx.signal?.aborted) throw e;
      await sleep(INPLACE_RETRY_MS[attempt] + Math.floor(Math.random() * 1500), ctx.signal);
    }
  }
}

async function aiChatOnce(ctx: AiCtx, req: ChatRequest): Promise<ChatResult> {
  const resolved = await resolveOrThrow(ctx.userId, req.slot);
  const keyId = resolved.binding.apiKey.id;
  checkCooldown(keyId);
  const release = await acquire(keyId, keyLimit(keyId));
  try {
    const messages: Array<Record<string, unknown>> = [];
    if (req.system) {
      messages.push({
        role: "system",
        content: req.cacheSystem && cacheableSystem(resolved, req.model) ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] : req.system,
      });
    }
    for (const h of req.history ?? []) messages.push(h);
    messages.push({ role: "user", content: req.user });
    const payload: Record<string, unknown> = { messages, temperature: req.temperature ?? 0.7 };
    if (req.maxTokens) payload.max_tokens = req.maxTokens;
    if (req.json) payload.response_format = { type: "json_object" };
    if (req.noReasoning !== false && isOpenRouter(resolved.binding.provider)) payload.reasoning = { effort: "none" };
    const res = await runSlot({
      userId: ctx.userId,
      projectSlug: PROJECT_SLUG,
      slotKey: req.slot,
      payload,
      model: req.model,
      timeoutMs: req.timeoutMs ?? 120_000,
      signal: ctx.signal,
      meta: { teamId: ctx.teamId, refId: ctx.postId },
      pre: resolved,
    });
    if (!res.ok) await handleFailure(res, resolved).catch((e) => { throw Object.assign(e, { keyId }); });
    const text = extractText(res.data);
    if (!text.trim()) throw Object.assign(new BlogAiError({ code: "empty", kind: "transient", message: "Модель вернула пустой ответ" }, 502, resolved.binding.provider.name), { keyId });
    brakeRelax(keyId);
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

function cacheableSystem(resolved: ResolvedSlot, modelSpec?: string): boolean {
  const b = resolved.binding;
  if (!isOpenRouter(b.provider)) return false;
  const wanted = parseModelSpec(modelSpec);
  const model = wanted && (!wanted.provider || wanted.provider === b.provider.slug) ? wanted.model : b.model?.modelId ?? "";
  return /gemini|claude/i.test(model);
}

export type ImageRequest = { prompt: string; size?: string; quality?: "low" | "medium" | "high"; model?: string; timeoutMs?: number };
export type ImageResult = { bytes: Buffer; mime: string; costUsd: number | null; model: string | null };

/** Генерация картинки через слот image_main (копия aiImage статей под проект blog). */
export async function aiImage(ctx: AiCtx, req: ImageRequest): Promise<ImageResult> {
  const resolved = await resolveOrThrow(ctx.userId, SLOTS.image);
  const keyId = resolved.binding.apiKey.id;
  checkCooldown(keyId);
  const release = await acquire(keyId, DEFAULT_LIMITS.IMAGE);
  try {
    const res = await runSlot({
      userId: ctx.userId, projectSlug: PROJECT_SLUG, slotKey: SLOTS.image,
      payload: { prompt: req.prompt, n: 1, size: req.size ?? "1024x1536", quality: req.quality ?? "medium" },
      model: req.model, timeoutMs: req.timeoutMs ?? 240_000, signal: ctx.signal, meta: { teamId: ctx.teamId, refId: ctx.postId }, pre: resolved,
    });
    if (!res.ok) await handleFailure(res, resolved);
    const data = res.data as { data?: Array<{ b64_json?: string; url?: string }> };
    const first = data?.data?.[0];
    if (first?.b64_json) return { bytes: Buffer.from(first.b64_json.replace(/^data:[^,]*,/, ""), "base64"), mime: "image/png", costUsd: res.meta?.costUsd ?? null, model: res.meta?.model ?? null };
    if (first?.url?.startsWith("data:")) return { bytes: Buffer.from(first.url.replace(/^data:[^,]*,/, ""), "base64"), mime: "image/png", costUsd: res.meta?.costUsd ?? null, model: res.meta?.model ?? null };
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

export function imagePart(bytes: Buffer, mime = "image/jpeg", detail: "low" | "high" | "auto" = "auto"): ContentPart {
  return { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}`, detail } };
}

/** DataForSEO: произвольный endpoint v3 через слот photo_dfs. */
export async function dfsRequest(ctx: AiCtx, endpoint: string, body: unknown[], timeoutMs = 130_000): Promise<{ ok: boolean; status: number; data: unknown; error?: string; costUsd: number | null }> {
  const r = await resolveSlot(ctx.userId, PROJECT_SLUG, SLOTS.photoDfs);
  if (!r.ok) return { ok: false, status: r.status, data: null, error: r.error, costUsd: null };
  const res = await runSlot({ userId: ctx.userId, projectSlug: PROJECT_SLUG, slotKey: SLOTS.photoDfs, payload: { endpoint, body }, timeoutMs, signal: ctx.signal, meta: { teamId: ctx.teamId, refId: ctx.postId }, pre: r.value });
  return { ok: res.ok, status: res.status, data: res.data, error: res.error, costUsd: res.meta?.costUsd ?? null };
}

/** SerpAPI: параметры запроса через слот (photo_serp — картинки, serp_organic — органика). */
export async function serpRequest(ctx: AiCtx, params: Record<string, string | number | undefined>, slot: typeof SLOTS.photoSerp | typeof SLOTS.serpOrganic = SLOTS.photoSerp, timeoutMs = 60_000): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const r = await resolveSlot(ctx.userId, PROJECT_SLUG, slot);
  if (!r.ok) return { ok: false, status: r.status, data: null, error: r.error };
  const res = await runSlot({ userId: ctx.userId, projectSlug: PROJECT_SLUG, slotKey: slot, payload: params, timeoutMs, signal: ctx.signal, meta: { teamId: ctx.teamId, refId: ctx.postId }, pre: r.value });
  return { ok: res.ok, status: res.status, data: res.data, error: res.error };
}

/** Есть ли у пользователя правило для слота (без вызова). */
export async function slotAvailable(userId: string, slot: SlotKey): Promise<boolean> {
  const r = await resolveSlot(userId, PROJECT_SLUG, slot);
  return r.ok;
}

/** Сумма расходов поста по журналу портала. */
export async function postCost(postId: string): Promise<number> {
  const agg = await prisma.usageLog.aggregate({ _sum: { costUsd: true }, where: { refId: postId } });
  return agg._sum.costUsd ?? 0;
}
