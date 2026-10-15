import { delta, fmtDecimal, fmtDuration, fmtInt, fmtPct } from "@/lib/analytics/format";
import { derive, type Totals } from "@/lib/analytics/query";
import { Delta } from "./Delta";

/** Шесть главных показателей периода с изменением к сравнению. */
export function Kpis({ cur, prev }: { cur: Totals; prev: Totals | null }) {
  const d = derive(cur);
  const p = prev ? derive(prev) : null;
  const tiles: Array<{ label: string; value: string; d: number | null; invert?: boolean; hint?: string }> = [
    { label: "Визиты", value: fmtInt(cur.sessions), d: delta(cur.sessions, prev?.sessions) },
    { label: "Посетители", value: fmtInt(cur.users), d: delta(cur.users, prev?.users) },
    { label: "Просмотры", value: fmtInt(cur.pageviews), d: delta(cur.pageviews, prev?.pageviews) },
    { label: "Отказы", value: fmtPct(d.bounce), d: d.bounce != null && p?.bounce != null ? d.bounce - p.bounce : null, invert: true, hint: "доля визитов без вовлечения (GA4)" },
    { label: "Время на сайте", value: fmtDuration(d.duration), d: d.duration != null && p?.duration != null ? delta(d.duration, p.duration) : null },
    { label: "Глубина", value: fmtDecimal(d.depth, 1), d: d.depth != null && p?.depth != null ? delta(d.depth, p.depth) : null, hint: "просмотров за визит" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6 mb-4">
      {tiles.map((t) => (
        <div key={t.label} className="kpi">
          <span className="text-[12.5px] font-semibold uppercase tracking-wider text-muted">{t.label}</span>
          <span className="kpi-value tabular-nums">{t.value}</span>
          <span className="flex items-center gap-2 min-h-[20px]">
            {t.label === "Отказы" ? <BounceDelta d={t.d} /> : <Delta d={t.d} invert={t.invert} size="md" />}
            {t.hint && <span className="help truncate">{t.hint}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Отказы сравниваем в процентных пунктах, а не в процентах. */
function BounceDelta({ d }: { d: number | null }) {
  if (d == null) return null;
  const pp = d * 100;
  const good = pp < 0;
  const cls = Math.abs(pp) < 0.05 ? "text-muted bg-ink/5" : good ? "text-ok bg-ok-soft" : "text-danger bg-danger-soft";
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[12.5px] font-semibold tabular-nums ${cls}`}>{pp > 0 ? "+" : pp < 0 ? "−" : ""}{Math.abs(pp).toFixed(1).replace(".", ",")} п.п.</span>;
}
