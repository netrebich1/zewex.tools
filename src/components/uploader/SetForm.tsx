"use client";
import { useActionState, useState } from "react";
import { saveSetAction, type FormState } from "@/actions/uploader";
import { Messages } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";

export type SetSite = { id: string; name: string; mapped: boolean };

/** Набор сайтов: название + галочки по всем видимым сайтам, поиск, «все / с профилем / снять». */
export function SetForm({ sites, initial }: { sites: SetSite[]; initial?: { id: string; name: string; siteIds: string[] } }) {
  const [state, action] = useActionState<FormState, FormData>(saveSetAction, {});
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initial?.siteIds ?? []));
  const [q, setQ] = useState("");
  const toggle = (id: string) => setChecked((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const list = q ? sites.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())) : sites;
  return (
    <form action={action} className="space-y-3">
      <Messages error={state.error} ok={state.ok} />
      {initial && <input type="hidden" name="id" value={initial.id} />}
      {[...checked].map((id) => <input key={id} type="hidden" name="site" value={id} />)}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block"><span className="label">Название набора</span><input name="name" className="input w-[240px]" defaultValue={initial?.name ?? ""} placeholder="например: В работе" required maxLength={120} /></label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="поиск сайта…" className="input w-[200px]" />
        <button type="button" className="btn-ghost btn-sm" onClick={() => setChecked(new Set(sites.map((s) => s.id)))}>Все</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setChecked(new Set(sites.filter((s) => s.mapped).map((s) => s.id)))}>Только с профилем</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setChecked(new Set())}>Снять все</button>
        <span className="help">Выбрано: {checked.size} из {sites.length}</span>
      </div>
      <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((s) => (
          <label key={s.id} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px]">
            <input type="checkbox" checked={checked.has(s.id)} onChange={() => toggle(s.id)} />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {!s.mapped && <span className="help">без профиля</span>}
          </label>
        ))}
      </div>
      <SubmitButton className="btn-primary" pendingText="Сохраняю…">{initial ? "Сохранить набор" : "Создать набор"}</SubmitButton>
    </form>
  );
}
