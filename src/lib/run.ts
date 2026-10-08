import { prisma } from "./db";
import { decryptSecret } from "./crypto";
import { resolveBinding } from "./resolve";
import { runProvider, type RunInput } from "./adapters";
import { monthStart } from "./utils";

export type RunRequest = {
  userId: string;
  projectSlug: string;
  slotKey: string;
  payload: Record<string, unknown>;
};

export type RunResponse = {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
  meta?: { provider: string; model: string | null; key: string; scope: string; inputTokens: number; outputTokens: number; costUsd: number | null; durationMs: number };
};

function estimateCost(inT: number, outT: number, inPrice: number | null, outPrice: number | null): number | null {
  if (inPrice == null && outPrice == null) return null;
  return (inT * (inPrice ?? 0) + outT * (outPrice ?? 0)) / 1_000_000;
}

export async function monthSpendForKey(apiKeyId: string): Promise<number> {
  const agg = await prisma.usageLog.aggregate({ _sum: { costUsd: true }, where: { apiKeyId, createdAt: { gte: monthStart() } } });
  return agg._sum.costUsd ?? 0;
}

export async function runSlot(req: RunRequest): Promise<RunResponse> {
  const project = await prisma.project.findUnique({ where: { slug: req.projectSlug }, include: { slots: true } });
  if (!project) return { ok: false, status: 404, error: `Проект «${req.projectSlug}» не найден` };
  const slot = project.slots.find((s) => s.key === req.slotKey);
  if (!slot) return { ok: false, status: 404, error: `Слот «${req.slotKey}» не найден в проекте «${project.name}»` };

  const resolved = await resolveBinding(req.userId, slot.id);
  if (!resolved.binding) {
    return { ok: false, status: 409, error: `Для слота «${slot.name}» не настроено ни одного правила (ключ + модель). Откройте страницу проекта и добавьте привязку.` };
  }
  const b = resolved.binding;
  if (b.provider.kind === "LLM" && !b.model) {
    return { ok: false, status: 409, error: `В правиле для слота «${slot.name}» не выбрана модель` };
  }
  if (b.apiKey.monthlyLimitUsd != null) {
    const spent = await monthSpendForKey(b.apiKey.id);
    if (spent >= b.apiKey.monthlyLimitUsd) {
      return { ok: false, status: 429, error: `Ключ «${b.apiKey.label}» исчерпал месячный лимит $${b.apiKey.monthlyLimitUsd}` };
    }
  }

  const keyRow = await prisma.apiKey.findUniqueOrThrow({ where: { id: b.apiKey.id }, select: { secretEnc: true } });
  const secret = decryptSecret(keyRow.secretEnc);

  let input: RunInput;
  const payload = req.payload ?? {};
  switch (slot.capability) {
    case "CHAT":
      input = { kind: "chat", model: b.model!.modelId, body: payload };
      break;
    case "IMAGE":
      input = { kind: "image", model: b.model!.modelId, body: payload };
      break;
    case "EMBEDDING":
      input = { kind: "embedding", model: b.model!.modelId, body: payload };
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
  const result = await runProvider(b.provider, secret, input);
  const durationMs = Date.now() - started;
  const costUsd = result.ok
    ? slot.capability === "SERP"
      ? null
      : estimateCost(result.inputTokens, result.outputTokens, b.model?.inputPrice ?? null, b.model?.outputPrice ?? null)
    : null;
  const dfsCost = slot.capability === "SEO_DATA" && result.ok ? ((result.data as { cost?: number })?.cost ?? null) : null;

  await prisma.usageLog.create({
    data: {
      userId: req.userId,
      projectId: project.id,
      slotId: slot.id,
      providerId: b.provider.id,
      modelId: b.model?.id ?? null,
      apiKeyId: b.apiKey.id,
      scope: b.scope,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      units: result.units,
      costUsd: dfsCost ?? costUsd,
      durationMs,
      ok: result.ok,
      error: result.error != null ? String(result.error).slice(0, 2000) : null,
    },
  });

  return {
    ok: result.ok,
    status: result.ok ? 200 : result.status || 502,
    data: result.data,
    error: result.error,
    meta: {
      provider: b.provider.name,
      model: b.model?.modelId ?? null,
      key: b.apiKey.label,
      scope: b.scope,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: dfsCost ?? costUsd,
      durationMs,
    },
  };
}
