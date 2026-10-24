"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setPropertyEnabled, setPropertyGroups } from "@/actions/analytics";

export type PropertyItem = {
  id: string;
  name: string;
  host: string | null;
  url: string | null;
  gaAccountName: string;
  timezone: string;
  enabled: boolean;
  removed: boolean;
  groupIds: string[];
  lastSyncAt: string | null;
  lastSyncError: string | null;
  backfilling: boolean;
};
export type GroupItem = { id: string; name: string; color: string };

/** Сайты одного Google-аккаунта: переключатель «показывать», группы, состояние синхронизации. */
export function PropertiesTable({ items, groups }: { items: PropertyItem[]; groups: GroupItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const toggle = (p: PropertyItem) => {
    setBusy(p.id);
    start(async () => {
      const r = await setPropertyEnabled(p.id, !p.enabled);
      setError(r.error ?? null);
      setBusy(null);
      router.refresh();
    });
  };
  const toggleGroup = (p: PropertyItem, gid: string) => {
    const next = p.groupIds.includes(gid) ? p.groupIds.filter((x) => x !== gid) : [...p.groupIds, gid];
    setBusy(p.id);
    start(async () => {
      const r = await setPropertyGroups(p.id, next);
      setError(r.error ?? null);
      setBusy(null);
      router.refresh();
    });
  };
  const s = q.trim().toLowerCase();
  const list = s ? items.filter((p) => p.name.toLowerCase().includes(s) || (p.host ?? "").includes(s) || p.gaAccountName.toLowerCase().includes(s)) : items;
  const byGa = new Map<string, PropertyItem[]>();
  for (const p of list) byGa.set(p.gaAccountName, [...(byGa.get(p.gaAccountName) ?? []), p]);

  return (
    <div>
      {error && <p className="mb-3 rounded-xl border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-[14px] text-danger">{error}</p>}
      {items.length > 8 && <input className="input !w-72 !py-2 sm:!text-[13.5px] mb-3" placeholder="Найти сайт или аккаунт GA…" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Показывать</th>
              <th>Сайт</th>
              <th className="hidden md:table-cell">Группы</th>
              <th className="hidden lg:table-cell">Данные</th>
            </tr>
          </thead>
          <tbody>
            {[...byGa.entries()].map(([ga, rows]) => (
              <GaBlock key={ga} ga={ga} rows={rows} groups={groups} busy={busy} pending={pending} onToggle={toggle} onGroup={toggleGroup} multi={byGa.size > 1} />
            ))}
            {!list.length && <tr><td colSpan={4} className="text-center text-muted py-8">Сайтов нет</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GaBlock({ ga, rows, groups, busy, pending, onToggle, onGroup, multi }: { ga: string; rows: PropertyItem[]; groups: GroupItem[]; busy: string | null; pending: boolean; onToggle: (p: PropertyItem) => void; onGroup: (p: PropertyItem, gid: string) => void; multi: boolean }) {
  return (
    <>
      {multi && <tr><td colSpan={4} className="!py-1.5 !bg-surface-2/60 text-[12px] font-semibold uppercase tracking-wider text-muted">Аккаунт GA: {ga}</td></tr>}
      {rows.map((p) => (
        <tr key={p.id} className={p.removed ? "opacity-60" : ""}>
          <td className="w-[110px]">
            <button type="button" role="switch" aria-checked={p.enabled} disabled={pending && busy === p.id || p.removed} onClick={() => onToggle(p)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${p.enabled ? "bg-ok" : "bg-ink/20"} disabled:opacity-50`} title={p.enabled ? "Выключить: данные останутся, обновляться не будут" : "Включить: история загрузится за несколько минут"}>
              <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${p.enabled ? "translate-x-5" : "translate-x-0.5"}`} />
            </button>
          </td>
          <td>
            <div className="font-medium text-[14px]">{p.enabled ? <Link href={`/analytics/sites/${p.id}`} className="hover:underline">{p.host || p.name}</Link> : p.host || p.name}</div>
            <div className="help">{p.host ? p.name : ""}{p.url ? "" : " · адрес сайта не указан в GA"} · {p.timezone}{p.removed ? " · больше нет в GA" : ""}</div>
          </td>
          <td className="hidden md:table-cell">
            {groups.length ? (
              <div className="flex flex-wrap gap-1">
                {groups.map((g) => {
                  const on = p.groupIds.includes(g.id);
                  return <button key={g.id} type="button" disabled={pending && busy === p.id} onClick={() => onGroup(p, g.id)} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition ${on ? "border-transparent text-white" : "border-line text-muted hover:text-ink"}`} style={on ? { background: g.color } : undefined}>{g.name}</button>;
                })}
              </div>
            ) : <span className="help">Группы создаются ниже</span>}
          </td>
          <td className="hidden lg:table-cell text-[13px]">
            {!p.enabled ? <span className="text-muted">выключен</span>
              : p.lastSyncError ? <span className="text-danger" title={p.lastSyncError}>ошибка: {p.lastSyncError.slice(0, 80)}</span>
              : p.backfilling ? <span className="text-info">история загружается…</span>
              : p.lastSyncAt ? <span className="text-muted">обновлено {new Date(p.lastSyncAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</span>
              : <span className="text-muted">в очереди</span>}
          </td>
        </tr>
      ))}
    </>
  );
}
