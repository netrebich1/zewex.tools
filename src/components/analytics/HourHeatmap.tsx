import { fmtInt } from "@/lib/analytics/format";
import { WEEKDAYS_SHORT } from "@/lib/analytics/period";

/** Средние визиты по часам и дням недели: один оттенок, темнее — больше. */
export function HourHeatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat());
  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((s, row) => s + row[h], 0) / 7);
  const peak = byHour.indexOf(Math.max(...byHour));
  if (!grid.flat().some((v) => v > 0)) return <p className="help">Нет данных по часам за период.</p>;
  return (
    <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <div className="min-w-[640px]">
        <div className="grid gap-[2px]" style={{ gridTemplateColumns: "32px repeat(24, minmax(0, 1fr))" }}>
          <div />
          {Array.from({ length: 24 }, (_, h) => <div key={h} className={`text-center text-[10.5px] tabular-nums ${h === peak ? "text-ink font-semibold" : "text-muted"}`}>{h}</div>)}
          {grid.map((row, wd) => (
            <Row key={wd} label={WEEKDAYS_SHORT[wd]} row={row} max={max} />
          ))}
        </div>
        <p className="help mt-2">Среднее число визитов за час в этот день недели. Пик суток — {peak}:00.</p>
      </div>
    </div>
  );
}

function Row({ label, row, max }: { label: string; row: number[]; max: number }) {
  return (
    <>
      <div className="text-[11.5px] text-muted flex items-center">{label}</div>
      {row.map((v, h) => (
        <div key={h} title={`${label}, ${h}:00 — ${fmtInt(Math.round(v))} визитов`} className="h-6 rounded-[4px] border border-line/60" style={{ background: `color-mix(in oklab, var(--viz-1) ${Math.round((v / max) * 100)}%, var(--color-surface))` }} />
      ))}
    </>
  );
}
