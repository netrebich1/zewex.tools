"use client";
import { useMemo, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { createBinding } from "@/actions/admin";
import { Field } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { CAPABILITY_LABELS, SCOPE_LABELS } from "@/lib/utils";
import { keyFitsRule, type TeamScope } from "@/lib/permissions";

export type ProviderOption = {
  id: string; name: string; kind: string;
  models: { id: string; modelId: string; name: string; capabilities: string }[];
  keys: { id: string; label: string; secretHint: string; ownerId: string | null; teamId: string | null; status: string }[];
};
export type Option = { id: string; name: string };
export type UserOption = { id: string; name: string; teamIds: string[] };

/** Что может текущий пользователь (из src/lib/permissions.ts): любые правила, или правила перечисленных команд. */
export type BindingAbility = { meId: string; myTeamIds: string[]; assign: TeamScope };

export function BindingForm({ providers, teams, users, slots, can, fixedScope, fixedSlotId, fixedTeamId, compact }: {
  providers: ProviderOption[];
  teams: Option[];
  users: UserOption[];
  slots: { id: string; name: string; capability: string }[];
  can: BindingAbility;
  fixedScope?: string;
  fixedSlotId?: string;
  fixedTeamId?: string;
  compact?: boolean;
}) {
  const global = can.assign === "all";
  const teamOptions = global ? teams : teams.filter((t) => can.assign.includes(t.id));
  const scopes = global ? Object.keys(SCOPE_LABELS) : teamOptions.length ? ["USER_PROJECT", "TEAM_PROJECT", "TEAM"] : ["USER_PROJECT"];
  const [scope, setScope] = useState(fixedScope ?? (global ? "PROJECT" : "USER_PROJECT"));
  const [slotId, setSlotId] = useState(fixedSlotId ?? slots[0]?.id ?? "");
  const [userId, setUserId] = useState(can.meId);
  const [teamId, setTeamId] = useState(fixedTeamId ?? teamOptions[0]?.id ?? "");
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
  // Ключ должен подходить правилу: личный — только владельцу, командный — своей команде, общий — куда угодно.
  const ruleUser = scope === "USER_PROJECT" ? (global ? userId : can.meId) : null;
  const ruleTeam = scope === "TEAM" || scope === "TEAM_PROJECT" ? teamId : null;
  const ruleUserTeams = ruleUser === can.meId ? can.myTeamIds : (users.find((u) => u.id === ruleUser)?.teamIds ?? []);
  const keys = (provider?.keys ?? []).filter((k) => k.status === "ACTIVE" && !keyFitsRule(k, { scope, teamId: ruleTeam, userId: ruleUser, userTeamIds: ruleUserTeams }));

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
            <select className="input" name="teamId" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {teamOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        )
      )}
      {scope === "USER_PROJECT" && (
        global ? (
          <Field label="Пользователь">
            <select className="input" name="userId" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        ) : <input type="hidden" name="userId" value={can.meId} />
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
      <Field label="Ключ" hint={keys.length ? undefined : "Нет подходящих активных ключей: личные ключи работают только в личном правиле владельца, командные — в правилах своей команды"}>
        <select className="input" name="apiKeyId" defaultValue={keys[0]?.id} key={`${provider?.id}-${scope}-${ruleUser}-${ruleTeam}`}>
          {keys.map((k) => <option key={k.id} value={k.id}>{k.label} · {k.secretHint}{k.ownerId ? " · личный" : k.teamId ? " · командный" : ""}</option>)}
        </select>
      </Field>
      <div className="flex items-end">
        <SubmitButton className="btn-primary w-full sm:w-auto" pendingText="Сохраняю…">Сохранить правило</SubmitButton>
      </div>
    </ActionForm>
  );
}
