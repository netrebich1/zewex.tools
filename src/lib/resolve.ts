import { prisma } from "./db";
import type { Adapter, AuthType, Binding, BindingScope, Capability, KeyStatus, ProviderKind } from "@prisma/client";

export type ResolveStep = {
  scope: BindingScope;
  label: string;
  matched: boolean;
  note?: string;
};

/**
 * Слоты, которым разрешены только указанные провайдеры (решение владельца 2026-10-24): картинки пинов рисует
 * только OpenAI. Правила с другими провайдерами пропускаются, даже если ключ OpenAI выключен — тогда слот не находится,
 * и прогон встаёт с понятной причиной, а не переходит молча на ключ в 3–6 раз дороже (прогон bellaromakitchen 23.10).
 * Ключ — `<slug проекта>:<ключ слота>`. Задано в коде, а не в `Slot.preferProviders`: сид перезаписывает его при деплое.
 */
export const ONLY_PROVIDERS: Record<string, string[]> = {
  "pins:image_main": ["openai"],
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
  /** Слоту разрешены только эти провайдеры (`ONLY_PROVIDERS`); null — любые. */
  onlyProviders: string[] | null;
};

const include = {
  provider: { select: { id: true, slug: true, name: true, adapter: true, authType: true, baseUrl: true, kind: true } },
  model: { select: { id: true, modelId: true, name: true, inputPrice: true, outputPrice: true, unitPrice: true } },
  apiKey: { select: { id: true, label: true, secretHint: true, status: true, monthlyLimitUsd: true, ownerId: true } },
} as const;

/**
 * Правила одного уровня, между которыми делится нагрузка: у командных уровней — только первая команда
 * по дате вступления, затем предпочтительный провайдер слота (например, картинки → OpenAI, тексты → OpenRouter).
 */
export function levelCandidates<T extends { teamId: string | null; provider: { slug: string } }>(usable: T[], scope: BindingScope, teamIds: string[], preferProviders: string | null): T[] {
  if (usable.length <= 1) return usable;
  let list = usable;
  if (scope === "TEAM_PROJECT" || scope === "TEAM") {
    list = [...usable].sort((a, b) => teamIds.indexOf(a.teamId!) - teamIds.indexOf(b.teamId!));
    const firstTeam = list[0].teamId;
    list = list.filter((b) => b.teamId === firstTeam);
  }
  const prefer = (preferProviders ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const rank = (slug: string) => { const i = prefer.indexOf(slug); return i === -1 ? prefer.length : i; };
  const best = Math.min(...list.map((b) => rank(b.provider.slug)));
  return list.filter((b) => rank(b.provider.slug) === best);
}

/**
 * Finds the binding for a slot for a given user, from the most specific scope to the most general:
 * USER_PROJECT → TEAM_PROJECT → PROJECT → TEAM (by capability) → GLOBAL (by capability).
 *
 * `teamId` — команда, за счёт которой идёт работа (команда сайта / прогона). Если задана, уровни «команда»
 * смотрят только её правила, даже если сотрудник состоит в нескольких командах: деньги списываются строго
 * с ключей этой команды. Без неё — все команды сотрудника, первая по дате вступления.
 */
export async function resolveBinding(userId: string, slotId: string, teamId?: string | null): Promise<ResolvedBinding> {
  const slotRow = await prisma.slot.findUniqueOrThrow({
    where: { id: slotId },
    select: { id: true, key: true, name: true, capability: true, projectId: true, preferProviders: true, project: { select: { slug: true } } },
  });
  const { project, ...slot } = slotRow;
  const onlyProviders = ONLY_PROVIDERS[`${project.slug}:${slot.key}`] ?? null;
  const memberships = await prisma.teamMember.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { team: { select: { id: true, name: true } } },
  });
  const teamIds = teamId ? [teamId] : memberships.map((m) => m.teamId);
  const steps: ResolveStep[] = [];
  const warnings: string[] = [];

  const pick = async (scope: BindingScope, where: Record<string, unknown>, label: string) => {
    const all = await prisma.binding.findMany({ where: { scope, ...where }, include, orderBy: { createdAt: "asc" } });
    const found = onlyProviders ? all.filter((b) => onlyProviders.includes(b.provider.slug)) : all;
    if (found.length < all.length) warnings.push(`${label}: правила не ${onlyProviders!.join("/")} пропущены — этому слоту разрешён только ${onlyProviders!.join(", ")}`);
    const usable = found.filter((b) => b.apiKey.status === "ACTIVE");
    if (found.length && !usable.length) warnings.push(`${label}: ключ отключён, правило пропущено`);
    if (!teamId && usable.length > 1 && (scope === "TEAM_PROJECT" || scope === "TEAM")) {
      const names = usable.map((b) => memberships.find((m) => m.teamId === b.teamId)?.team.name ?? "?").join(", ");
      warnings.push(`Пользователь состоит в нескольких командах с правилами (${names}); взято первое по дате вступления`);
    }
    steps.push({ scope, label, matched: usable.length > 0 });
    const sameLevel = levelCandidates(usable, scope, teamIds, slot.preferProviders);
    // Несколько ключей одного провайдера: нагрузка распределяется случайно между ними
    return sameLevel[Math.floor(Math.random() * sameLevel.length)] ?? null;
  };

  const b1 = await pick("USER_PROJECT", { slotId, userId }, "Личное правило для этого инструмента");
  if (b1) return { binding: b1, steps, slot, warnings, onlyProviders };
  const b2 = teamIds.length
    ? await pick("TEAM_PROJECT", { slotId, teamId: { in: teamIds } }, "Правило команды для этого инструмента")
    : (steps.push({ scope: "TEAM_PROJECT", label: "Правило команды для этого инструмента", matched: false, note: teamId ? "у работы нет команды" : "пользователь не в команде" }), null);
  if (b2) return { binding: b2, steps, slot, warnings, onlyProviders };
  const b3 = await pick("PROJECT", { slotId }, "Правило инструмента по умолчанию");
  if (b3) return { binding: b3, steps, slot, warnings, onlyProviders };
  const b4 = teamIds.length
    ? await pick("TEAM", { teamId: { in: teamIds }, capability: slot.capability }, "Правило команды по типу слота")
    : (steps.push({ scope: "TEAM", label: "Правило команды по типу слота", matched: false, note: teamId ? "у работы нет команды" : "пользователь не в команде" }), null);
  if (b4) return { binding: b4, steps, slot, warnings, onlyProviders };
  const b5 = await pick("GLOBAL", { capability: slot.capability }, "Глобальное правило по типу слота");
  return { binding: b5, steps, slot, warnings, onlyProviders };
}
