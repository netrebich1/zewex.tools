"use client";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { startRunAction, type StartState } from "@/actions/uploader";
import { Messages } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";

export type StartSite = { id: string; name: string; count: number; ready: boolean; why: string | null; uploaded: boolean };
export type StartAgent = { id: string; name: string; status: string; parallel: number };
export type StartSet = { id: string; name: string; siteIds: string[] };

/** Кнопка «Запустить»: выбор агента, сайтов (по умолчанию все готовые без отметки), параллельности. */
export function StartRunForm({ sites, agents, day, sets = [] }: { sites: StartSite[]; agents: StartAgent[]; day: string; sets?: StartSet[] }) {
  const router = useRouter();
  const [state, action] = useActionState<StartState, FormData>(async (p, f) => { const r = await startRunAction(p, f); if (r.runId) router.push(`/pinterest/uploader/runs/${r.runId}`); return r; }, {});
  const online = agents.filter((a) => a.status !== "offline");
  const [agentId, setAgentId] = useState(online[0]?.id ?? agents[0]?.id ?? "");
  const agent = agents.find((a) => a.id === agentId);
  const defaultChecked = (s: StartSite) => s.ready && !s.uploaded;
  const [checked, setChecked] = useState<Set<string>>(() => new Set(sites.filter(defaultChecked).map((s) => s.id)));
  const toggle = (id: string) => setChecked((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const readyIds = sites.filter((s) => s.ready).map((s) => s.id);
  const pins = sites.filter((s) => checked.has(s.id)).reduce((n, s) => n + s.count, 0);

  if (!agents.length) return <p className="help">Сначала добавьте агента на странице «Агенты» и запустите его на ПК с Dolphin Anty.</p>;
  return (
    <form action={action} className="space-y-3">
      <Messages error={state.error} ok={state.ok} />
      {state.skipped && state.skipped.length > 0 && (
        <div className="rounded-lg bg-warn-soft px-3 py-2 text-[13px]">
          Пропущено: {state.skipped.map((s) => `${s.siteName} — ${s.reason}`).join("; ")}
        </div>
      )}
      <input type="hidden" name="day" value={day} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">Агент (ПК с Dolphin)</span>
          <select name="agentId" className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status === "offline" ? " — не на связи" : a.status === "busy" ? " — работает" : ""}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">Профилей одновременно</span>
          <input name="parallel" type="number" min={1} max={5} className="input w-[110px]" defaultValue={agent?.parallel ?? 1} key={agentId} />
        </label>
        {sets.length > 0 && (
          <label className="block">
            <span className="label">Набор сайтов</span>
            <select className="input" defaultValue="" onChange={(e) => { const st = sets.find((x) => x.id === e.target.value); if (st) setChecked(new Set(sites.filter((s) => s.ready && st.siteIds.includes(s.id)).map((s) => s.id))); }}>
              <option value="">— вручную —</option>
              {sets.map((st) => <option key={st.id} value={st.id}>{st.name} ({st.siteIds.length})</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-[13px] pb-2"><input type="checkbox" name="force" /> Заливать и уже отмеченные залитыми</label>
      </div>
      {agent?.status === "offline" && <p className="text-[13px] text-warn">Агент «{agent.name}» сейчас не на связи: запуск встанет в очередь и начнётся, когда агент выйдет на связь.</p>}
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <button type="button" className="btn-ghost btn-sm" onClick={() => setChecked(new Set(readyIds))}>Все готовые ({readyIds.length})</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setChecked(new Set(sites.filter(defaultChecked).map((s) => s.id)))}>Только не залитые</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setChecked(new Set())}>Снять все</button>
        <span className="help">Выбрано сайтов: {checked.size}, пинов: {pins}</span>
      </div>
      <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {sites.map((s) => (
          <label key={s.id} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] ${s.ready ? "" : "opacity-60"}`}>
            <input type="checkbox" name="site" value={s.id} checked={checked.has(s.id)} onChange={() => toggle(s.id)} />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="help max-w-full">{s.count ? `${s.count} пин.` : "нет файла"}{s.uploaded ? " · залито" : ""}{s.why ? ` · ${s.why}` : ""}</span>
          </label>
        ))}
      </div>
      <SubmitButton className="btn-brand" pendingText="Создаю запуск…">Запустить заливку</SubmitButton>
    </form>
  );
}
