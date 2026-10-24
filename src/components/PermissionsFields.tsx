"use client";
import { useState } from "react";
import { Field } from "@/components/ui";
import { PERMISSION_FIELDS, PERMISSION_PRESETS, parsePermissions, presetOf, type Permissions } from "@/lib/permissions";

/**
 * Поля прав сотрудника: выбор готового профиля заполняет все селекты, любое поле можно подправить —
 * тогда профиль становится «Свои настройки». Значения уходят в форму по именам полей `Permissions`.
 */
export function PermissionsFields({ value, compact }: { value?: Permissions; compact?: boolean }) {
  const [perms, setPerms] = useState<Permissions>(value ?? PERMISSION_PRESETS.member.value);
  const preset = presetOf(perms) ?? "custom";
  const set = (key: string, raw: string) => setPerms((p) => parsePermissions({ ...p, [key]: raw }));

  return (
    <div className="space-y-3">
      <Field label="Профиль прав" hint={preset === "custom" ? "Поля настроены вручную." : PERMISSION_PRESETS[preset].hint}>
        <select className="input" value={preset} onChange={(e) => { const k = e.target.value; if (PERMISSION_PRESETS[k]) setPerms(PERMISSION_PRESETS[k].value); }}>
          {Object.entries(PERMISSION_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          <option value="custom">Свои настройки</option>
        </select>
      </Field>
      <div className={compact ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"}>
        {PERMISSION_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <select className="input" name={f.key} value={String(perms[f.key])} onChange={(e) => set(f.key, e.target.value)}>
              {f.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
            </select>
          </Field>
        ))}
      </div>
    </div>
  );
}
