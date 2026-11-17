import { delta, fmtInt } from "@/lib/analytics/format";
import type { DimRow } from "@/lib/analytics/query";
import { CHANNEL_LABELS, DEVICE_LABELS, type DimKind } from "@/lib/analytics/types";
import { Delta } from "./Delta";

const label = (kind: DimKind, v: string) => (kind === "channel" ? CHANNEL_LABELS[v] ?? v : kind === "device" ? DEVICE_LABELS[v] ?? v : v === "(not set)" ? "не определено" : v);

/** Горизонтальные полосы долей по разрезу (каналы, страны, устройства, источники). */
export function DimBars({ kind, rows, total }: { kind: DimKind; rows: DimRow[]; total: number }) {
  if (!rows.length) return <p className="help">Нет данных за период.</p>;
  const max = Math.max(1, ...rows.map((r) => r.sessions));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.value}>
          <div className="flex items-center justify-between gap-3 text-[13.5px]">
            <span className="truncate">{label(kind, r.value)}</span>
            <span className="flex items-center gap-2 shrink-0 tabular-nums">
              <span className="text-muted text-[12px]">{total ? `${Math.round((r.sessions / total) * 100)} %` : ""}</span>
              <b>{fmtInt(r.sessions)}</b>
              <span className="w-14 text-right"><Delta d={delta(r.sessions, r.prevSessions)} /></span>
            </span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-ink/5 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${(r.sessions / max) * 100}%`, background: "var(--viz-1)" }} /></div>
        </li>
      ))}
    </ul>
  );
}
