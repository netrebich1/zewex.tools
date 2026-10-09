import { prisma } from "./db";
import type { Adapter, AuthType, Binding, BindingScope, Capability, KeyStatus, ProviderKind } from "@prisma/client";

export type ResolveStep = {
  scope: BindingScope;
  label: string;
  matched: boolean;
  note?: string;
};

export type ResolvedBinding = {
  binding: (Binding & {
    provider: { id: string; slug: string; name: string; adapter: Adapter; authType: AuthType; baseUrl: string; kind: ProviderKind };
    model: { id: string; modelId: string; name: string; inputPrice: number | null; outputPrice: number | null; unitPrice: number | null } | null;
    apiKey: { id: string; label: string; secretHint: string; status: KeyStatus; monthlyLimitUsd: number | null; ownerId: string | null };
  }) | null;
  steps: ResolveStep[];
  slot: { id: string; key: string; name: string; capability: Capability; projectId: string };
  warnings: string[];
};

const include = {
  provider: { select: { id: true, slug: true, name: true, adapter: true, authType: true, baseUrl: true, kind: true } },
  model: { select: { id: true, modelId: true, name: true, inputPrice: true, outputPrice: true, unitPrice: true } },
  apiKey: { select: { id: true, label: true, secretHint: true, status: true, monthlyLimitUsd: true, ownerId: true } },
} as const;

/**
 * Finds the binding for a slot for a given user, from the most specific scope to the most general:
 * USER_PROJECT → TEAM_PROJECT → PROJECT → TEAM (by capability) → GLOBAL (by capability).
 */
export async function resolveBinding(userId: string, slotId: string): Promise<ResolvedBinding> {
  const slot = await prisma.slot.findUniqueOrThrow({
    where: { id: slotId },
    select: { id: true, key: true, name: true, capability: true, projectId: true, preferProviders: true },
  });
  const memberships = await prisma.teamMember.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { team: { select: { id: true, name: true } } },
  });
  const teamIds = memberships.map((m) => m.teamId);
  const steps: ResolveStep[] = [];
  const warnings: string[] = [];

  const pick = async (scope: BindingScope, where: Record<string, unknown>, label: string) => {
    const found = await prisma.binding.findMany({ where: { scope, ...where }, include, orderBy: { createdAt: "asc" } });
    const usable = found.filter((b) => b.apiKey.status === "ACTIVE");
    if (found.length && !usable.length) warnings.push(`${label}: ключ отключён, правило пропущено`);
    if (usable.length > 1 && (scope === "TEAM_PROJECT" || scope === "TEAM")) {
      const names = usable.map((b) => memberships.find((m) => m.teamId === b.teamId)?.team.name ?? "?").join(", ");
      warnings.push(`Пользователь состоит в нескольких командах с правилами (${names}); взято первое по дате вступления`);
      usable.sort((a, b) => teamIds.indexOf(a.teamId!) - teamIds.indexOf(b.teamId!));
    }
    steps.push({ scope, label, matched: usable.length > 0 });
    if (usable.length <= 1) return usable[0] ?? null;
    const firstTeam = usable[0].teamId;
    let sameLevel = scope === "TEAM_PROJECT" || scope === "TEAM" ? usable.filter((b) => b.teamId === firstTeam) : usable;
    // Разные провайдеры на одном уровне: берём предпочтительного для слота (например, картинки → OpenAI, тексты → OpenRouter)
    const prefer = (slot.preferProviders ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const rank = (slug: string) => { const i = prefer.indexOf(slug); return i === -1 ? prefer.length : i; };
    const best = Math.min(...sameLevel.map((b) => rank(b.provider.slug)));
    sameLevel = sameLevel.filter((b) => rank(b.provider.slug) === best);
    // Несколько ключей одного провайдера: нагрузка распределяется случайно между ними
    return sameLevel[Math.floor(Math.random() * sameLevel.length)] ?? null;
  };

  const b1 = await pick("USER_PROJECT", { slotId, userId }, "Личное правило для этого инструмента");
  if (b1) return { binding: b1, steps, slot, warnings };
  const b2 = teamIds.length
    ? await pick("TEAM_PROJECT", { slotId, teamId: { in: teamIds } }, "Правило команды для этого инструмента")
    : (steps.push({ scope: "TEAM_PROJECT", label: "Правило команды для этого инструмента", matched: false, note: "пользователь не в команде" }), null);
  if (b2) return { binding: b2, steps, slot, warnings };
  const b3 = await pick("PROJECT", { slotId }, "Правило инструмента по умолчанию");
  if (b3) return { binding: b3, steps, slot, warnings };
  const b4 = teamIds.length
    ? await pick("TEAM", { teamId: { in: teamIds }, capability: slot.capability }, "Правило команды по типу слота")
    : (steps.push({ scope: "TEAM", label: "Правило команды по типу слота", matched: false, note: "пользователь не в команде" }), null);
  if (b4) return { binding: b4, steps, slot, warnings };
  const b5 = await pick("GLOBAL", { capability: slot.capability }, "Глобальное правило по типу слота");
  return { binding: b5, steps, slot, warnings };
}
