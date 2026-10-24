"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { delta, fmtDuration, fmtInt, fmtPct } from "@/lib/analytics/format";
import { Delta } from "./Delta";
import { Sparkline } from "./Sparkline";

export type SiteRow = {
  id: string;
  name: string;
  host: string | null;
  groups: { id: string; name: string; color: string }[];
  sessions: number;
  prevSessions: number | null;
  users: number;
  pageviews: number;
  bounce: number | null;
  duration: number | null;
  spark: number[];
  backfilling: boolean;
  error: string | null;
};

type SortKey = "sessions" | "users" | "pageviews" | "delta" | "name" | "online";

/** Таблица сайтов: поиск, сортировка по столбцам, «сейчас на сайте» подтягивается отдельно. `qs` — параметры периода для ссылок. */
export function SitesTable({ rows, qs }: { rows: SiteRow[]; qs: string }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("sessions");
  const [desc, setDesc] = useState(true);
  const [online, setOnline] = useState<Record<string, number | null>>({});

  useEffect(() => {
    if (!rows.length) return;
    const ctrl = new AbortController();
    const load = () => fetch(`/api/analytics/realtime?ids=${rows.map((r) => r.id).join(",")}`, { signal: ctrl.signal }).then((r) => (r.ok ? r.json() : {})).then(setOnline).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { clearInterval(t); ctrl.abort(); };
  }, [rows]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const f = s ? rows.filter((r) => r.name.toLowerCase().includes(s) || (r.host ?? "").toLowerCase().includes(s) || r.groups.some((g) => g.name.toLowerCase().includes(s))) : rows.slice();
    const val = (r: SiteRow): number | string => sort === "name" ? (r.host || r.name).toLowerCase() : sort === "delta" ? (delta(r.sessions, r.prevSessions) ?? -Infinity) : sort === "online" ? (online[r.id] ?? -1) : r[sort];
    f.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1); });
    return f;
  }, [rows, q, sort, desc, online]);

  const th = (key: SortKey, label: string, right = true, cls = "") => (
    <th className={`${right ? "text-right" : ""} ${cls} cursor-pointer select-none hover:text-ink`} onClick={() => { if (sort === key) setDesc((v) => !v); else { setSort(key); setDesc(key !== "name"); } }}>
      <span className="inline-flex items-center gap-1">{label}{sort === key && <svg width="9" height="9" viewBox="0 0 10 10" className={desc ? "rotate-180" : ""} aria-hidden><path d="M5 1l4 5H1z" fill="currentColor" /></svg>}</span>
    </th>
  );
  const totalOnline = Object.values(online).reduce<number>((s, v) => s + (v ?? 0), 0);
  const hasOnline = Object.keys(online).length > 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input className="input !w-64 !py-2 sm:!text-[13.5px]" placeholder="Найти сайт…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="help">{list.length} из {rows.length}</span>
        {hasOnline && <span className="ml-auto inline-flex items-center gap-1.5 text-[13px] text-ink-2"><i className="inline-block h-2 w-2 rounded-full bg-ok animate-pulse" /> Сейчас на сайтах: <b className="tabular-nums">{fmtInt(totalOnline)}</b></span>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {/* Сайт закреплён слева при прокрутке вбок; фон непрозрачный — как у шапки и при наведении. */}
              {th("name", "Сайт", false, "sticky left-0 z-10 !bg-[color-mix(in_oklab,var(--color-surface-2)_60%,var(--color-surface))]")}
              <th className="hidden md:table-cell"></th>
              {th("sessions", "Визиты")}
              {th("delta", "Изменение")}
              {th("users", "Посетители", true, "col-sm")}
              {th("pageviews", "Просмотры", true, "col-sm")}
              <th className="text-right hidden lg:table-cell">Отказы</th>
              <th className="text-right hidden lg:table-cell">Время</th>
              {th("online", "Сейчас")}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const d = delta(r.sessions, r.prevSessions);
              const href = `/analytics/sites/${r.id}${qs ? `?${qs}` : ""}`;
              return (
                <tr key={r.id} className="group">
                  <td className="sticky left-0 z-10 bg-surface group-hover:bg-[color-mix(in_oklab,var(--color-surface-2)_70%,var(--color-surface))] min-w-[140px] sm:min-w-[200px]">
                    <Link href={href} className="block">
                      <span className="font-semibold text-[14px] group-hover:text-brand transition">{r.host || r.name}</span>
                      <span className="block help truncate max-w-[160px] sm:max-w-[260px]">{r.host ? r.name : ""}{r.groups.length > 0 && <span className="inline-flex gap-1 ml-1 align-middle">{r.groups.map((g) => <i key={g.id} title={g.name} className="inline-block h-2 w-2 rounded-full" style={{ background: g.color }} />)}</span>}</span>
                      {r.error ? <span className="badge bg-danger-soft text-danger text-[11px] py-0 mt-0.5">ошибка синхронизации</span> : r.backfilling ? <span className="badge bg-info-soft text-info text-[11px] py-0 mt-0.5">история загружается</span> : null}
                    </Link>
                  </td>
                  <td className="hidden md:table-cell w-[120px]"><Sparkline values={r.spark} /></td>
                  <td className="text-right tabular-nums font-semibold">{fmtInt(r.sessions)}</td>
                  <td className="text-right"><Delta d={d} /></td>
                  <td className="col-sm text-right tabular-nums">{fmtInt(r.users)}</td>
                  <td className="col-sm text-right tabular-nums">{fmtInt(r.pageviews)}</td>
                  <td className="text-right tabular-nums hidden lg:table-cell">{fmtPct(r.bounce, 0)}</td>
                  <td className="text-right tabular-nums hidden lg:table-cell">{fmtDuration(r.duration)}</td>
                  <td className="text-right tabular-nums">{online[r.id] == null ? <span className="text-muted">{hasOnline ? "—" : "…"}</span> : <span className={online[r.id] ? "text-ok font-semibold" : "text-muted"}>{fmtInt(online[r.id])}</span>}</td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan={9} className="text-center text-muted py-8">Ничего не найдено</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
