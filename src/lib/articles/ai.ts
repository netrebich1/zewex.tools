/**
 * ИИ-клиент сервиса статей поверх прокси портала (resolveSlot → runSlot → UsageLog).
 * Ключ выбирается правилами портала для пользователя, запустившего статью; модель — из рецепта (`provider:model`),
 * если она совпадает по провайдеру с ключом, иначе модель правила. Расход пишется с refId = id статьи.
 * Один вызов = одна попытка на один ключ; повторы и фолбэки — по классу ошибки (transient → backoff в этапе).
 *
 * Нет средств / ключ отклонён / нет правила — ошибка класса fatal_run (ArticleAiError с провайдером и ключом): раннер
 * не роняет статью, а ставит её ждать рабочий ключ (src/lib/articles/errors.ts). Ключ при «нет средств» НЕ выключается
 * во всём портале: после пополнения статьи продолжат сами. Чтобы десятки ждущих статей не стучались к провайдеру,
 * отказ «нет средств» запоминается на ключ на NO_CREDITS_COOLDOWN_MS и следующие вызовы падают сразу, без запроса.
 * Ключ, отклонённый провайдером (401/403), по-прежнему выключается: дальше сработает запасное правило, если оно есть.
 *
 * Кэш промта (волна 3 п.3, замер 2026-10-16): неявный кэш Gemini через OpenRouter срабатывает только при полностью одинаковом
 * тексте запроса до картинок и после 2–3 повторов — в наших вызовах (разные темы, заголовки, фото) практически никогда.
 * Явный кэш (`cache_control` на системном сообщении) срабатывает всегда со второго вызова: 1711 из 1711 токенов
 * статичного промта оценки, −35 % цены вызова на flash-lite и −23 % на gemini-3-flash (2 фото в запросе).
 * Поэтому `cacheSystem: true` — системное сообщение уходит одним текстовым блоком с `cache_control: ephemeral`;
 * только для OpenRouter + Gemini (другие провайдеры поле не знают). Системный текст при этом должен быть ОДИНАКОВЫМ
 * между статьями (ниша — да, тема/ключ — нет): всё зависящее от статьи кладётся первым текстом в user.
 * Промт короче минимума (≈1024 токена) провайдер просто не кэширует, ошибки нет.
 */
import { prisma } from "@/lib/db";
import { resolveSlot, runSlot, disableKey, parseModelSpec, type ResolvedSlot } from "@/lib/run";
import { isOpenRouter } from "@/lib/adapters";
import { AiError, classifyAiError, type ClassifiedError } from "@/lib/pins/ai/errors";
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
  /** Системное сообщение неизменно между вызовами (нет значений статьи) — просить провайдера кэшировать его (см. шапку). */
  cacheSystem?: boolean;
};

export type ChatResult = { text: string; json: unknown; costUsd: number | null; model: string | null; inputTokens: number; outputTokens: number; durationMs: number };

/** Ошибка вызова ИИ сервиса статей: класс как у AiError плюс провайдер и подпись ключа (для понятной заметки статьи). */
export class ArticleAiError extends AiError {
  constructor(cls: ClassifiedError, status: number, public readonly provider?: string, public readonly keyLabel?: string) {
    super(cls, status);
    this.name = "ArticleAiError";
  }
}

/**
 * Автотормоз ключа (2026-10-21): при 429 или пустом ответе провайдера параллельность ключа в этом процессе
 * падает вдвое (не ниже BRAKE_MIN) на BRAKE_COOL_MS; после паузы каждый успешный вызов возвращает +1 до обычной.
 * Плюс короткие повторы на месте (429 бесплатен): статья не уходит в долгий повтор этапа из-за секундной волны.
 */
const BRAKE_MIN = 2;
const BRAKE_COOL_MS = 3 * 60_000;
const INPLACE_RETRY_MS = [3_000, 10_000];
const brakes = new Map<string, { limit: number; coolUntil: number }>();

function keyLimit(keyId: string): number {
  return brakes.get(keyId)?.limit ?? DEFAULT_LIMITS.CHAT;
}

function brakeOn(keyId: string): void {
  const cur = keyLimit(keyId);
  const limit = Math.max(BRAKE_MIN, Math.floor(cur / 2));
  brakes.set(keyId, { limit, coolUntil: Date.now() + BRAKE_COOL_MS });
}

function brakeRelax(keyId: string): void {
  const b = brakes.get(keyId);
  if (!b || Date.now() < b.coolUntil) return;
  if (b.limit + 1 >= DEFAULT_LIMITS.CHAT) brakes.delete(keyId);
  else brakes.set(keyId, { ...b, limit: b.limit + 1 });
}

/** Состояние автотормоза по ключам — для журнала и отладки. */
export function brakeStats(): Record<string, { limit: number; coolUntil: string }> {
  const out: Record<string, { limit: number; coolUntil: string }> = {};
  for (const [k, v] of brakes) out[k] = { limit: v.limit, coolUntil: new Date(v.coolUntil).toISOString() };
  return out;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Сколько помним «нет средств» на ключе: ждущие статьи не дёргают провайдера каждый раз. */
const NO_CREDITS_COOLDOWN_MS = 5 * 60_000;
const noCredits = new Map<string, { until: number; err: ArticleAiError }>();

async function resolveOrThrow(userId: string, slotKey: string): Promise<ResolvedSlot> {
  const r = await resolveSlot(userId, PROJECT_SLUG, slotKey);
  if (!r.ok) throw new ArticleAiError({ code: r.status === 409 ? "no_binding" : "resolve", kind: "fatal_run", message: r.error }, r.status);
  return r.value;
}

/** Ключ недавно ответил «нет средств» — сразу та же ошибка, без запроса к провайдеру. */
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
  // Отказы самого портала (run.ts) — тоже про ключ, а не временные: месячный лимит ключа, правило без модели/цен.
  if (/исчерпал месячный лимит/i.test(text)) cls = { code: "month_limit", kind: "fatal_run", message: text.slice(0, 500) };
  else if (res.status === 409) cls = { code: "config", kind: "fatal_run", message: text.slice(0, 500) };
  if (cls.kind === "fatal_run" && cls.code === "auth") {
    await disableKey(key.id, `Автоотключён: ключ отклонён провайдером (${cls.message.slice(0, 120)})`).catch(() => {});
  }
  if (cls.kind === "fatal_run") cls = { ...cls, message: `Ключ «${key.label}»: ${cls.message}` };
  const err = new ArticleAiError(cls, res.status, provider, key.label);
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
      // Пустой ответ мог стоить денег — повторяем один раз; 429 бесплатен — до двух раз.
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
    // Поле `reasoning` понимает только OpenRouter; OpenAI отвечает 400 «Unrecognized request argument supplied: reasoning»
    // (2026-10-21: у OpenRouter-ключа кончились деньги, правило команды переключилось на OpenAI — вся ИИ-модерация падала).
    if (req.noReasoning !== false && isOpenRouter(resolved.binding.provider)) payload.reasoning = { effort: "none" };
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
    if (!res.ok) await handleFailure(res, resolved).catch((e) => { throw Object.assign(e, { keyId }); });
    const text = extractText(res.data);
    if (!text.trim()) throw Object.assign(new ArticleAiError({ code: "empty", kind: "transient", message: "Модель вернула пустой ответ" }, 502, resolved.binding.provider.name), { keyId });
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

/** Явный кэш системного промта поддержан у OpenRouter для моделей Gemini (и Anthropic); остальным поле не шлём. */
function cacheableSystem(resolved: ResolvedSlot, modelSpec?: string): boolean {
  const b = resolved.binding;
  if (!isOpenRouter(b.provider)) return false;
  const wanted = parseModelSpec(modelSpec);
  const model = wanted && (!wanted.provider || wanted.provider === b.provider.slug) ? wanted.model : b.model?.modelId ?? "";
  return /gemini|claude/i.test(model);
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
  checkCooldown(resolved.binding.apiKey.id);
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
    if (!res.ok) await handleFailure(res, resolved);
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
