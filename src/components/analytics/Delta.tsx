import { fmtDelta } from "@/lib/analytics/format";

/** Изменение к прошлому периоду: зелёный рост, красное падение; `invert` — когда меньше значит лучше (отказы). */
export function Delta({ d, invert = false, size = "sm" }: { d: number | null; invert?: boolean; size?: "sm" | "md" }) {
  if (d == null) return null;
  const good = d === 0 ? null : (d > 0) !== invert;
  const cls = d === 0 ? "text-muted" : good ? "text-ok" : "text-danger";
  const bg = d === 0 ? "bg-ink/5" : good ? "bg-ok-soft" : "bg-danger-soft";
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-md ${bg} ${cls} font-semibold tabular-nums ${size === "md" ? "px-1.5 py-0.5 text-[12.5px]" : "px-1 py-px text-[11.5px]"}`}>
      {Number.isFinite(d) && d !== 0 && <svg width="9" height="9" viewBox="0 0 10 10" className={d < 0 ? "rotate-180" : ""} aria-hidden><path d="M5 1l4 5H1z" fill="currentColor" /></svg>}
      {fmtDelta(d)}
    </span>
  );
}
