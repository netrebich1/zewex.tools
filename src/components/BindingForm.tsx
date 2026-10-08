"use client";
import { useMemo, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { createBinding } from "@/actions/admin";
import { Field } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { CAPABILITY_LABELS, SCOPE_LABELS } from "@/lib/utils";

export type ProviderOption = {
  id: string; name: string; kind: string;
  models: { id: string; modelId: string; name: string; capabilities: string }[];
  keys: { id: string; label: string; secretHint: string; ownerId: string | null; status: string }[];
};
export type Option = { id: string; name: string };

export function BindingForm({ providers, teams, users, slots, isAdmin, meId, leadTeamIds = [], fixedScope, fixedSlotId, fixedTeamId, compact }: {
  providers: ProviderOption[];
  teams: Option[];
  users: Option[];
  slots: { id: string; name: string; capability: string }[];
  isAdmin: boolean;
  meId: string;
  /** Teams the current user leads: they may add TEAM / TEAM_PROJECT rules for those teams. */
  leadTeamIds?: string[];
  fixedScope?: string;
  fixedSlotId?: string;
  fixedTeamId?: string;
  compact?: boolean;
}) {
  const scopes = isAdmin ? Object.keys(SCOPE_LABELS) : leadTeamIds.length ? ["USER_PROJECT", "TEAM_PROJECT", "TEAM"] : ["USER_PROJECT"];
  const teamOptions = isAdmin ? teams : teams.filter((t) => leadTeamIds.includes(t.id));
  const [scope, setScope] = useState(fixedScope ?? (isAdmin ? "PROJECT" : "USER_PROJECT"));
  const [slotId, setSlotId] = useState(fixedSlotId ?? slots[0]?.id ?? "");
  const [userId, setUserId] = useState(meId);
  const slot = slots.find((s) => s.id === slotId);
  const [capability, setCapability] = useState(slot?.capability ?? "CHAT");
  const needCap = scope === "TEAM" || scope === "GLOBAL";
  const effectiveCap = needCap ? capability : (slot?.capability ?? "CHAT");

  const usableProviders = useMemo(() => {
    const dataCaps = ["SERP", "SEO_DATA"];
    return providers.filter((p) => {
      if (dataCaps.includes(effectiveCap)) return p.kind === "DATA";
      return p.kind === "LLM";
    });
  }, [providers, effectiveCap]);
  const [providerId, setProviderId] = useState(usableProviders[0]?.id ?? "");
  const provider = usableProviders.find((p) => p.id === providerId) ?? usableProviders[0];
  const models = (provider?.models ?? []).filter((m) => m.capabilities.split(",").includes(effectiveCap) || provider?.kind === "DATA");
  // Shared keys are always available; a personal key only inside its owner's personal rule.
  const ruleUser = scope === "USER_PROJECT" ? (isAdmin ? userId : meId) : null;
  const keys = (provider?.keys ?? []).filter((k) => k.status === "ACTIVE" && (!k.ownerId || k.ownerId === ruleUser));

  return (
    <ActionForm action={createBinding} className={compact ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3" : "grid gap-3 sm:grid-cols-2"}>
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="providerId" value={provider?.id ?? ""} />
      {!fixedScope && (
        <Field label="Уровень правила">
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
            {scopes.map((s) => <option key={s} value={s}>{SCOPE_LABELS[s]}</option>)}
          </select>
        </Field>
      )}
      {!needCap && !fixedSlotId && (
        <Field label="Слот">
          <select className="input" name="slotId" value={slotId} onChange={(e) => setSlotId(e.target.value)}>
            {slots.map((s) => <option key={s.id} value={s.id}>{s.name} · {CAPABILITY_LABELS[s.capability]}</option>)}
          </select>
        </Field>
      )}
      {fixedSlotId && !needCap && <input type="hidden" name="slotId" value={fixedSlotId} />}
      {needCap && (
        <Field label="Тип слота">
          <select className="input" name="capability" value={capability} onChange={(e) => setCapability(e.target.value)}>
            {Object.entries(CAPABILITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      )}
      {(scope === "TEAM" || scope === "TEAM_PROJECT") && (
        fixedTeamId ? <input type="hidden" name="teamId" value={fixedTeamId} /> : (
          <Field label="Команда" hint={teamOptions.length ? undefined : "Нет команд, которыми вы управляете"}>
            <select className="input" name="teamId" defaultValue={teamOptions[0]?.id}>
              {teamOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        )
      )}
      {scope === "USER_PROJECT" && (
        isAdmin ? (
          <Field label="Пользователь">
            <select className="input" name="userId" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        ) : <input type="hidden" name="userId" value={meId} />
      )}
      <Field label="Провайдер">
        <select className="input" value={provider?.id ?? ""} onChange={(e) => setProviderId(e.target.value)}>
          {usableProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      {provider?.kind === "LLM" && (
        <Field label="Модель" hint={models.length ? undefined : "У провайдера нет включённых моделей этого типа"}>
          <select className="input" name="modelId" defaultValue={models[0]?.id} key={provider.id + effectiveCap}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.modelId})</option>)}
          </select>
        </Field>
      )}
      <Field label="Ключ" hint={keys.length ? undefined : "Нет подходящих активных ключей: личные ключи доступны только в личном правиле владельца"}>
        <select className="input" name="apiKeyId" defaultValue={keys[0]?.id} key={`${provider?.id}-${scope}-${ruleUser}`}>
          {keys.map((k) => <option key={k.id} value={k.id}>{k.label} · {k.secretHint}{k.ownerId ? " · личный" : ""}</option>)}
        </select>
      </Field>
      <div className="flex items-end">
        <SubmitButton className="btn-primary w-full sm:w-auto" pendingText="Сохраняю…">Сохранить правило</SubmitButton>
      </div>
    </ActionForm>
  );
}
