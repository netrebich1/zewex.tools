"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtCompact, fmtDelta, fmtInt } from "@/lib/analytics/format";
import { METRICS, pointLabel, type Grain, type Metric } from "@/lib/analytics/period";
import type { Point } from "@/lib/analytics/query";

/**
 * График периода: одна ось, текущий период — линия с заливкой, сравнение — пунктир.
 * Наведение: вертикаль, точки и подсказка со значениями обоих периодов и изменением.
 */
export function TimeChart({ cur, prev, grain, metric: initial, prevLabel }: { cur: Point[]; prev: Point[] | null; grain: Grain; metric: Metric; prevLabel?: string }) {
  const [metric, setMetric] = useState<Metric>(initial);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 260;
  const PAD = { l: 46, r: 12, t: 14, b: 28 };
  const iw = width - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const a = cur.map((p) => p[metric]);
  const b = prev ? prev.map((p) => p[metric]) : null;
  const max = Math.max(1, ...a, ...(b ?? []));
  const ticks = useMemo(() => niceTicks(max), [max]);
  const top = ticks[ticks.length - 1] || max;
  const n = a.length;
  const x = (i: number) => PAD.l + (n > 1 ? (i / (n - 1)) * iw : iw / 2);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const line = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = n > 1 ? `${line(a)} L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z` : "";
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(iw / 90))));
  const total = a.reduce((s, v) => s + v, 0);
  const totalPrev = b ? b.reduce((s, v) => s + v, 0) : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - PAD.l;
    const i = n > 1 ? Math.round((px / iw) * (n - 1)) : 0;
    setHover(Math.min(n - 1, Math.max(0, i)));
  };
  const hv = hover != null ? hover : null;
  const tipLeft = hv != null ? Math.min(Math.max(x(hv), 120), width - 120) : 0;

  return (
    <div ref={box} className="relative">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex gap-1 rounded-xl bg-ink/5 p-1">
          {METRICS.map((m) => (
            <button key={m.key} type="button" onClick={() => setMetric(m.key)} className={`rounded-lg px-3 py-1.5 text-[13.5px] font-semibold transition ${metric === m.key ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>{m.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-4 text-[13px]">
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-[3px] w-4 rounded-full" style={{ background: "var(--viz-1)" }} /> <b className="tabular-nums">{fmtInt(total)}</b> <span className="text-muted">этот период</span></span>
          {b && <span className="inline-flex items-center gap-1.5"><i className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: "var(--viz-prev)" }} /> <b className="tabular-nums">{fmtInt(totalPrev ?? 0)}</b> <span className="text-muted">{prevLabel ?? "сравнение"}</span></span>}
        </div>
      </div>
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} className="block select-none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="График по периодам">
        <defs>
          <linearGradient id="vizFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--viz-1)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--viz-1)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth="1" />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--color-muted)" className="tabular-nums">{fmtCompact(t)}</text>
          </g>
        ))}
        {cur.map((p, i) => (i % labelEvery === 0 || i === n - 1) && (n <= 40 || i % labelEvery === 0) ? (
          <text key={p.key} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="11" fill="var(--color-muted)">{pointLabel(p.key, grain)}</text>
        ) : null)}
        {area && <path d={area} fill="url(#vizFill)" />}
        {b && n > 1 && <path d={line(b)} fill="none" stroke="var(--viz-prev)" strokeWidth="1.5" strokeDasharray="4 4" strokeLinejoin="round" />}
        {n > 1 ? <path d={line(a)} fill="none" stroke="var(--viz-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /> : <circle cx={x(0)} cy={y(a[0] ?? 0)} r="4" fill="var(--viz-1)" />}
        {hv != null && (
          <g>
            <line x1={x(hv)} x2={x(hv)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--color-ink)" strokeOpacity="0.25" strokeWidth="1" />
            {b && <circle cx={x(hv)} cy={y(b[hv])} r="4" fill="var(--viz-prev)" stroke="var(--color-surface)" strokeWidth="2" />}
            <circle cx={x(hv)} cy={y(a[hv])} r="4.5" fill="var(--viz-1)" stroke="var(--color-surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hv != null && (
        <div className="pointer-events-none absolute top-14 z-10 w-[230px] -translate-x-1/2 rounded-xl border border-line bg-surface p-3 text-[13px] shadow-[var(--shadow-pop)]" style={{ left: tipLeft }}>
          <div className="font-semibold mb-1.5">{pointLabel(cur[hv].key, grain, true)}</div>
          <div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-1.5 text-ink-2"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "var(--viz-1)" }} />{METRICS.find((m) => m.key === metric)?.label}</span><b className="tabular-nums">{fmtInt(a[hv])}</b></div>
          {b && prev && (
            <>
              <div className="flex items-center justify-between gap-3 text-muted"><span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "var(--viz-prev)" }} />{prev[hv].key ? pointLabel(prev[hv].key, grain, true) : "—"}</span><span className="tabular-nums">{fmtInt(b[hv])}</span></div>
              <div className="mt-1 text-right tabular-nums font-semibold" style={{ color: a[hv] >= b[hv] ? "var(--color-ok)" : "var(--color-danger)" }}>{b[hv] ? fmtDelta((a[hv] - b[hv]) / b[hv]) : a[hv] ? "новое" : ""}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Красивые деления оси: 4–5 линий на круглых числах. */
function niceTicks(max: number): number[] {
  const raw = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(Math.round(v * 1000) / 1000);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
