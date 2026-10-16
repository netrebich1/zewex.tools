import { prisma } from "./db";
import { decryptSecret } from "./crypto";
import { resolveBinding, type ResolvedBinding } from "./resolve";
import type { Capability } from "@prisma/client";
import { isOpenRouter, runProvider, type RunInput } from "./adapters";
import { monthStart } from "./utils";

export type RunRequest = {
  userId: string;
  projectSlug: string;
  slotKey: string;
  payload: Record<string, unknown>;
  /** Таймаут одного вызова провайдера (по умолчанию 180 с). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Привязка записи расхода к команде и объекту (например, прогону). */
  meta?: { teamId?: string; refId?: string };
  /** Уже выбранное правило (resolveSlot), чтобы не искать его второй раз. */
  pre?: ResolvedSlot;
  /**
   * Модель, заданная настройкой инструмента (например, рецептом статьи): `provider:model` или просто `model`.
   * Применяется, если провайдер правила совпадает с указанным (или провайдер не указан); иначе берётся модель правила.
   */
  model?: string;
};

export type ResolvedSlot = {
  project: { id: string; name: string; slug: string };
  slot: { id: string; key: string; name: string; capability: Capability };
  binding: NonNullable<ResolvedBinding["binding"]>;
  warnings: string[];
};

export type ResolveSlotResult = { ok: true; value: ResolvedSlot } | { ok: false; status: number; error: string };

/** Находит проект, слот и правило (ключ + модель) для пользователя. Без вызова провайдера. */
export async function resolveSlot(userId: string, projectSlug: string, slotKey: string): Promise<ResolveSlotResult> {
  const project = await prisma.project.findUnique({ where: { slug: projectSlug }, include: { slots: true } });
  if (!project) return { ok: false, status: 404, error: `Проект «${projectSlug}» не найден` };
  const slot = project.slots.find((s) => s.key === slotKey);
  if (!slot) return { ok: false, status: 404, error: `Слот «${slotKey}» не найден в проекте «${project.name}»` };
  const resolved = await resolveBinding(userId, slot.id);
  if (!resolved.binding) {
    return { ok: false, status: 409, error: `Для слота «${slot.name}» не настроено ни одного правила (ключ + модель). Откройте страницу проекта и добавьте привязку.` };
  }
  return { ok: true, value: { project: { id: project.id, name: project.name, slug: project.slug }, slot, binding: resolved.binding, warnings: resolved.warnings } };
}

/** Выключает ключ (нет баланса / отклонён провайдером); правила с ним пропускаются при следующем выборе. */
export async function disableKey(apiKeyId: string, note: string): Promise<void> {
  await prisma.apiKey.update({ where: { id: apiKeyId }, data: { status: "DISABLED", lastCheckedAt: new Date(), lastCheckOk: false, lastCheckNote: note.slice(0, 500) } });
}

export type RunResponse = {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
  meta?: { provider: string; model: string | null; key: string; scope: string; inputTokens: number; outputTokens: number; costUsd: number | null; durationMs: number };
};

/** `provider:model` → {provider, model}; строка без двоеточия (или с "/" слева от него) — только модель. */
export function parseModelSpec(spec?: string | null): { provider: string | null; model: string } | null {
  const s = (spec ?? "").trim();
  if (!s) return null;
  const i = s.indexOf(":");
  if (i > 0 && !s.slice(0, i).includes("/")) return { provider: s.slice(0, i).toLowerCase(), model: s.slice(i + 1) };
  return { provider: null, model: s };
}

function estimateCost(inT: number, outT: number, inPrice: number | null, outPrice: number | null): number | null {
  if (inPrice == null && outPrice == null) return null;
  return (inT * (inPrice ?? 0) + outT * (outPrice ?? 0)) / 1_000_000;
}

export async function monthSpendForKey(apiKeyId: string): Promise<number> {
  const agg = await prisma.usageLog.aggregate({ _sum: { costUsd: true }, where: { apiKeyId, createdAt: { gte: monthStart() } } });
  return agg._sum.costUsd ?? 0;
}

export async function runSlot(req: RunRequest): Promise<RunResponse> {
  let pre = req.pre;
  if (!pre) {
    const r = await resolveSlot(req.userId, req.projectSlug, req.slotKey);
    if (!r.ok) return { ok: false, status: r.status, error: r.error };
    pre = r.value;
  }
  const { project, slot } = pre;
  const b = pre.binding;
  if (b.provider.kind === "LLM" && !b.model) {
    return { ok: false, status: 409, error: `В правиле для слота «${slot.name}» не выбрана модель` };
  }
  if (b.apiKey.monthlyLimitUsd != null) {
    // A limit is only enforceable when every call's cost can be computed; refuse rather than silently bypass it.
    const priced = b.provider.adapter === "DATAFORSEO" || isOpenRouter(b.provider) || (b.model != null && (b.model.inputPrice != null || b.model.outputPrice != null || b.model.unitPrice != null));
    if (!priced) {
      const why = slot.capability === "SERP"
        ? "SerpAPI не сообщает стоимость запросов"
        : `у модели ${b.model?.modelId ?? "?"} не заданы цены`;
      return { ok: false, status: 409, error: `На ключе «${b.apiKey.label}» стоит месячный лимит, но ${why}. Укажите цены модели на странице провайдера или снимите лимит с ключа.` };
    }
    const spent = await monthSpendForKey(b.apiKey.id);
    if (spent >= b.apiKey.monthlyLimitUsd) {
      return { ok: false, status: 429, error: `Ключ «${b.apiKey.label}» исчерпал месячный лимит $${b.apiKey.monthlyLimitUsd}` };
    }
  }

  const keyRow = await prisma.apiKey.findUniqueOrThrow({ where: { id: b.apiKey.id }, select: { secretEnc: true } });
  const secret = decryptSecret(keyRow.secretEnc);

  // Модель из настройки инструмента: только для провайдера, который совпадает с правилом ключа.
  let modelId = b.model?.modelId ?? "";
  let modelRow = b.model;
  const wanted = parseModelSpec(req.model);
  if (wanted && (!wanted.provider || wanted.provider === b.provider.slug) && wanted.model !== modelId) {
    modelId = wanted.model;
    const known = await prisma.model.findUnique({ where: { providerId_modelId: { providerId: b.provider.id, modelId } }, select: { id: true, modelId: true, name: true, inputPrice: true, outputPrice: true, unitPrice: true } });
    modelRow = known ?? { id: "", modelId, name: modelId, inputPrice: null, outputPrice: null, unitPrice: null };
  }

  let input: RunInput;
  const payload = req.payload ?? {};
  switch (slot.capability) {
    case "CHAT":
      input = { kind: "chat", model: modelId, body: payload };
      break;
    case "IMAGE":
      input = { kind: "image", model: modelId, body: payload };
      break;
    case "EMBEDDING":
      input = { kind: "embedding", model: modelId, body: payload };
      break;
    case "SERP": {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(payload)) if (v != null) params[k] = String(v);
      input = { kind: "serp", params };
      break;
    }
    case "SEO_DATA":
      input = { kind: "seo_data", endpoint: String(payload.endpoint ?? ""), body: payload.body ?? [] };
      break;
  }

  const started = Date.now();
  const result = await runProvider(b.provider, secret, input, { timeoutMs: req.timeoutMs, signal: req.signal });
  const durationMs = Date.now() - started;
  let costUsd: number | null = null;
  if (result.ok && slot.capability !== "SERP") {
    if (result.exactCostUsd != null) costUsd = result.exactCostUsd;
    else if (slot.capability === "IMAGE" && modelRow?.unitPrice != null) costUsd = result.units * modelRow.unitPrice;
    else costUsd = estimateCost(result.inputTokens, result.outputTokens, modelRow?.inputPrice ?? null, modelRow?.outputPrice ?? null);
  }
  const dfsCost = slot.capability === "SEO_DATA" && result.ok ? ((result.data as { cost?: number })?.cost ?? null) : null;

  await prisma.usageLog.create({
    data: {
      userId: req.userId,
      projectId: project.id,
      slotId: slot.id,
      providerId: b.provider.id,
      modelId: modelRow?.id || null,
      apiKeyId: b.apiKey.id,
      scope: b.scope,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      units: result.units,
      costUsd: dfsCost ?? costUsd,
      durationMs,
      ok: result.ok,
      error: result.error != null ? String(result.error).slice(0, 2000) : null,
      teamId: req.meta?.teamId ?? null,
      refId: req.meta?.refId ?? null,
    },
  });

  return {
    ok: result.ok,
    status: result.ok ? 200 : result.status || 502,
    data: result.data,
    error: result.error,
    meta: {
      provider: b.provider.name,
      model: modelId || null,
      key: b.apiKey.label,
      scope: b.scope,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: dfsCost ?? costUsd,
      durationMs,
    },
  };
}
