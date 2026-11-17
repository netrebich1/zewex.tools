"use client";
import { useState } from "react";
import { Field } from "@/components/ui";

export type KeyOwnerOption = { value: string; label: string };
type Option = { id: string; name: string; hint?: string };

/**
 * Чей ключ (личный / командный / общий) и где он работает. Личному ключу подключение не нужно,
 * командный подключается только к сервисам внутри своей команды, общий — к сервисам и/или командам.
 */
export function KeyOwnerFields({ owners, defaultOwner, projects, teams, global, defaultProjects = [], defaultTeams = [] }: {
  owners: KeyOwnerOption[];
  defaultOwner: string;
  projects: Option[];
  /** Команды, к которым пользователь вправе подключать ключи. */
  teams: Option[];
  /** Может подключать ключ к сервисам без команды (правило сервиса по умолчанию). */
  global: boolean;
  defaultProjects?: string[];
  defaultTeams?: string[];
}) {
  const [owner, setOwner] = useState(defaultOwner);
  const personal = owner === "personal";
  const teamKey = owner.startsWith("team:");
  const canAssign = !personal && (global || teams.length > 0 || teamKey);
  return (
    <>
      <Field label="Чей ключ" hint={personal ? "Работает только по вашим личным правилам." : teamKey ? "Виден участникам команды и работает только в её правилах." : "Можно подключить к любым сервисам и командам."}>
        <select name="owner" className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
          {owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      {canAssign && (
        <div className="rounded-xl border border-line p-3 sm:p-4 sm:col-span-2">
          <div className="font-medium mb-1">Где работает этот ключ</div>
          <p className="help mb-3">{teamKey ? "Отметьте сервисы: правила команды создадутся для их слотов. Без сервисов ключ станет ключом команды для всех инструментов." : "Отметьте сервисы и команды. Правила создаются сами, модель берётся из настроек провайдера."}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <span className="label">Сервисы</span>
              <div className="space-y-1.5">
                {projects.map((p) => <label key={p.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="projectIds" value={p.id} defaultChecked={defaultProjects.includes(p.id)} className="h-4 w-4" /> {p.name}{p.hint && <span className="help">· {p.hint}</span>}</label>)}
                {projects.length === 0 && <p className="help">Сервисов пока нет.</p>}
              </div>
            </div>
            {!teamKey && (
              <div>
                <span className="label">Команды</span>
                <div className="space-y-1.5">
                  {teams.map((t) => <label key={t.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="teamIds" value={t.id} defaultChecked={defaultTeams.includes(t.id)} className="h-4 w-4" /> {t.name}</label>)}
                </div>
                <p className="help mt-2">{global ? "Без команд ключ станет ключом сервиса по умолчанию для всех." : "Отметьте хотя бы одну команду: подключать ключ к сервисам для всех может только администратор."}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
