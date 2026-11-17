"use client";
import { useEffect, useRef, useState } from "react";
import { FIELD } from "@/lib/keywords/fields";
import type { TableRow } from "@/lib/keywords/query";
import { flagLabel, nicheLabel, seasonLabel, verdictLabel } from "@/lib/keywords/types";
import { fmt, Hint, useQueryNav } from "./kwui";

const VERDICT_CLS: Record<string, string> = {
  easy: "bg-ok-soft text-ok", medium: "bg-warn-soft text-warn", hard: "bg-danger-soft text-danger",
  commercial: "bg-danger-soft text-danger", low_volume: "bg-ink/5 text-muted",
};
export const verdictCls = (v: string | null | undefined) => VERDICT_CLS[v ?? ""] ?? "bg-ink/5 text-muted";

/** Оценка 0–100 полоской: цвет по порогам, цифра всегда рядом. */
export function Bar({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted">—</span>;
  const tone = v >= 60 ? "bg-ok" : v >= 35 ? "bg-warn" : "bg-danger";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-7 text-right font-bold tabular-nums">{v}</span>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-ink/8"><span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, v))}%` }} /></span>
    </span>
  );
}

const BAR_KEYS = new Set(["score", "entryNew", "entryOld"]);
const DELTA_KEYS = new Set(["scoreDelta", "comDelta"]);

function Cell({ k, r }: { k: string; r: TableRow }) {
  const f = FIELD.get(k)!;
  const v = r.v[k];
  if (k === "volume") return <span className="font-semibold">{r.volNone ? <span className="font-normal text-muted">≈0</span> : fmt(v)}</span>;
  if (BAR_KEYS.has(k)) return <Bar v={v} />;
  if (v == null) return <span className="text-muted">—</span>;
  if (DELTA_KEYS.has(k)) {
    // Δ оценки: рост — хорошо; Δ коммерции: рост — плохо.
    const good = k === "scoreDelta" ? v > 0 : v < 0;
    return <span className={`font-semibold ${v === 0 ? "text-muted" : good ? "text-ok" : "text-danger"}`}>{v > 0 ? "+" : ""}{fmt(v, 1)}</span>;
  }
  if (f.unit === "%") {
    const c = f.count ? r.counts[f.count] : null;
    return c != null ? <span><b className="font-semibold">{c}</b><span className="text-muted"> · {Math.round(v)}%</span></span> : <span>{Math.round(v)}%</span>;
  }
  return <span>{fmt(v, f.unit === "мес" ? 1 : 0)}</span>;
}

/**
 * Таблица ключей: прокрутка внутри окна (полосы сверху и снизу), шапка и колонка «Ключ» закреплены,
 * ключ показывается целиком. Клик по строке открывает карточку ключа справа.
 */
export function DataTable({ rows, columns, selected, onOpen }: { rows: TableRow[]; columns: string[]; selected: string | null; onOpen: (id: string) => void }) {
  const { sp, apply } = useQueryNav();
  const box = useRef<HTMLDivElement>(null);
  const topBar = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.scrollWidth));
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    setW(el.scrollWidth);
    return () => ro.disconnect();
  }, [columns, rows]);
  const sync = (from: "top" | "box") => {
    const a = topBar.current, b = box.current;
    if (!a || !b) return;
    if (from === "top") { if (b.scrollLeft !== a.scrollLeft) b.scrollLeft = a.scrollLeft; }
    else if (a.scrollLeft !== b.scrollLeft) a.scrollLeft = b.scrollLeft;
  };
  const cur = sp.get("sort") ?? "score";
  const dir = sp.get("dir") ?? (cur === "phrase" ? "asc" : "desc");
  const sortBy = (k: string) => apply({ sort: k, dir: cur === k ? (dir === "desc" ? "asc" : "desc") : k === "phrase" ? "asc" : "desc" });
  const th = "sticky top-0 z-20 border-b border-line bg-surface-2 px-2.5 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted whitespace-nowrap";
  const arrow = (k: string) => (cur === k ? <span aria-hidden> {dir === "desc" ? "↓" : "↑"}</span> : null);
  return (
    <div className="rounded-xl border border-line">
      <div ref={topBar} onScroll={() => sync("top")} className="hidden sm:block overflow-x-auto overflow-y-hidden border-b border-line" style={{ height: 14 }} aria-hidden>
        <div style={{ width: w, height: 1 }} />
      </div>
      <div ref={box} onScroll={() => sync("box")} className="max-h-[70dvh] min-h-[240px] sm:max-h-[calc(100vh-230px)] sm:min-h-[320px] overflow-auto">
        <table className="w-max min-w-full border-separate border-spacing-0 text-[13.5px]">
          <thead>
            <tr>
              <th className={`${th} left-0 z-30 min-w-[150px] max-w-[170px] sm:min-w-[240px] sm:max-w-[320px] border-r`}>
                <button type="button" onClick={() => sortBy("phrase")} className="hover:text-ink">Ключ{arrow("phrase")}</button>
              </th>
              <th className={th}>Вердикт</th>
              {columns.map((k) => {
                const f = FIELD.get(k);
                if (!f) return null;
                return (
                  <th key={k} className={`${th} text-right`} title={f.desc}>
                    <button type="button" onClick={() => sortBy(k)} className={`hover:text-ink ${cur === k ? "text-ink" : ""}`}>{f.short ?? f.label}{f.unit && f.unit !== "%" ? `, ${f.unit}` : ""}{arrow(k)}</button>
                    {f.desc && <Hint text={f.desc} className="sm:hidden" />}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const on = selected === r.id;
              const fl = r.flags ? r.flags.split(",") : [];
              const bg = on ? "bg-brand-soft" : "bg-surface group-hover:bg-surface-2";
              return (
                <tr key={r.id} onClick={() => onOpen(r.id)} className="group cursor-pointer">
                  <td className={`sticky left-0 z-10 min-w-[150px] max-w-[170px] sm:min-w-[240px] sm:max-w-[320px] border-b border-r border-line px-2.5 py-2 align-top ${bg}`}>
                    <div className="font-semibold leading-snug break-words">{r.phrase}</div>
                    <div className="mt-0.5 text-[12px] leading-snug text-muted">
                      {nicheLabel(r.niche)}{r.season !== "none" ? ` · ${seasonLabel(r.season).toLowerCase()}` : ""}{r.account ? ` · ${r.account}` : ""}
                      {r.status === "picked" && <span className="ml-1 rounded bg-brand-soft px-1 font-semibold text-ink">в работе</span>}
                      {r.status === "rejected" && <span className="ml-1 rounded bg-ink/5 px-1">отклонён</span>}
                    </div>
                    {fl.length > 0 && <div className="mt-0.5 text-[12px]" title={fl.map(flagLabel).join("\n")}>{fl.map((f) => flagLabel(f).split(" ")[0]).join(" ")}</div>}
                  </td>
                  <td className={`border-b border-line px-2.5 py-2 align-top whitespace-nowrap ${bg}`}>
                    {r.verdict ? <span className={`badge ${verdictCls(r.verdict)}`}>{verdictLabel(r.verdict)}</span> : <span className="help">нет выдачи</span>}
                    {r.verdictChanged && r.prevVerdict && <div className="mt-1 text-[11.5px] text-muted" title="Вердикт сменился с прошлого снимка">было: {verdictLabel(r.prevVerdict)}</div>}
                  </td>
                  {columns.map((k) => FIELD.has(k) && <td key={k} className={`border-b border-line px-2.5 py-2 text-right align-top tabular-nums whitespace-nowrap ${bg}`}><Cell k={k} r={r} /></td>)}
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={columns.length + 2} className="py-12 text-center text-muted">Под эти фильтры ключей нет</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
