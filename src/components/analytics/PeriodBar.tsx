"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { allowedGrains, fmtRange, GRAINS, PRESETS, type Compare, type Grain, type Preset, type Range } from "@/lib/analytics/period";

/**
 * Панель периода: готовые периоды, свой диапазон, с чем сравнивать, детализация графика.
 * Всё живёт в адресе (p/from/to/cmp/g), поэтому ссылку на экран можно переслать.
 */
export function PeriodBar({ range }: { range: Range }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [custom, setCustom] = useState(range.preset === "custom");
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  useEffect(() => { setFrom(range.from); setTo(range.to); }, [range.from, range.to]);

  const go = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) v == null ? q.delete(k) : q.set(k, v);
    q.delete("pg");
    start(() => router.replace(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }));
  };
  const pickPreset = (p: Preset) => { setCustom(false); go({ p: p === "30d" ? null : p, from: null, to: null, g: null }); };
  const applyCustom = () => { if (from && to) go({ p: "custom", from: from <= to ? from : to, to: from <= to ? to : from, g: null }); };
  const grains = allowedGrains(range.days);

  return (
    <div className={`mb-5 flex flex-col gap-3 transition-opacity ${pending ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap gap-1 rounded-xl bg-ink/5 p-1">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" onClick={() => pickPreset(p.key)} className={`rounded-lg px-3 py-1.5 text-[13.5px] font-semibold transition ${range.preset === p.key ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>{p.label}</button>
          ))}
          <button type="button" onClick={() => setCustom((v) => !v)} className={`rounded-lg px-3 py-1.5 text-[13.5px] font-semibold transition ${range.preset === "custom" ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>Свой период</button>
        </div>
        <span className="text-[13.5px] text-ink-2 font-medium ml-1">{fmtRange(range.from, range.to)}</span>
        {range.prev && <span className="help">· сравнение с {fmtRange(range.prev.from, range.prev.to)}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-[13px] text-muted">
            Сравнить
            <select className="input !w-auto !py-1.5 sm:!text-[13px] !rounded-lg" value={range.compare} onChange={(e) => go({ cmp: (e.target.value as Compare) === "prev" ? null : e.target.value })}>
              <option value="prev">с прошлым периодом</option>
              <option value="year">с прошлым годом</option>
              <option value="none">не сравнивать</option>
            </select>
          </label>
          <div className="inline-flex gap-0.5 rounded-full border border-line p-0.5" title="Детализация графика">
            {GRAINS.filter((g) => grains.includes(g.key)).map((g) => (
              <button key={g.key} type="button" onClick={() => go({ g: g.key as Grain })} className={`rounded-full px-2.5 py-1.5 sm:py-1 text-[12.5px] font-semibold transition ${range.grain === g.key ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}>{g.label.replace("По ", "")}</button>
            ))}
          </div>
        </div>
      </div>
      {custom && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
          <input type="date" className="input !w-auto !py-1.5 sm:!text-[13.5px] !rounded-lg" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-muted">—</span>
          <input type="date" className="input !w-auto !py-1.5 sm:!text-[13.5px] !rounded-lg" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          <button type="button" className="btn-primary btn-sm" onClick={applyCustom}>Показать</button>
          <span className="help">До 800 дней. Данные по часам — за последние 90 дней, по страницам — за 120.</span>
        </div>
      )}
    </div>
  );
}
