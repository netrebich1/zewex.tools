"use client";
import { useState } from "react";
import { DEFAULT_GROWTH, MAX_GROWTH_STEPS, describeGrowth, growthTotal, type GrowthStep } from "@/lib/pins/schedule/growth";

/**
 * Ступени «плавного роста»: «N дней по M пинов в день». После последней ступени — её норма дальше.
 * Поля формы: growthPresent, growthDays[], growthPerDay[]. Полоса снизу показывает рост по неделям.
 */
export function GrowthStepsEditor({ initial, max = 100 }: { initial?: GrowthStep[]; max?: number }) {
  const [steps, setSteps] = useState<GrowthStep[]>(initial?.length ? initial : DEFAULT_GROWTH);
  const set = (i: number, k: keyof GrowthStep, v: string) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, [k]: Math.max(1, Math.min(k === "days" ? 90 : max, Math.floor(Number(v) || 1))) } : x)));
  const top = Math.max(1, ...steps.map((s) => s.perDay));
  const days = steps.reduce((n, s) => n + s.days, 0);
  let from = 1;
  return (
    <div className="space-y-2">
      <input type="hidden" name="growthPresent" value="1" />
      <div className="space-y-1.5">
        {steps.map((s, i) => {
          const a = from, b = from + s.days - 1;
          from = b + 1;
          return (
            <div key={i} className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="w-24 text-muted">Дни {a}–{b}</span>
              <input name="growthDays" type="number" min={1} max={90} className="input w-20 py-1" value={s.days} onChange={(e) => set(i, "days", e.target.value)} aria-label="Дней в ступени" />
              <span className="text-muted">дн. по</span>
              <input name="growthPerDay" type="number" min={1} max={max} className="input w-20 py-1" value={s.perDay} onChange={(e) => set(i, "perDay", e.target.value)} aria-label="Пинов в день" />
              <span className="text-muted">пинов в день</span>
              {steps.length > 1 && <button type="button" className="btn-ghost px-2 py-0.5 text-[12px]" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}>Убрать</button>}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {steps.length < MAX_GROWTH_STEPS && <button type="button" className="btn-ghost px-2 py-1 text-[12px]" onClick={() => setSteps((x) => [...x, { days: 7, perDay: Math.min(max, (x.at(-1)?.perDay ?? 10) + 10) }])}>+ Ступень</button>}
        <button type="button" className="btn-ghost px-2 py-1 text-[12px]" onClick={() => setSteps(DEFAULT_GROWTH)}>Как в примере (15 → 20 → 30 → 40)</button>
      </div>
      <div className="flex h-14 items-end gap-px rounded-lg bg-ink/5 p-1" aria-hidden>
        {steps.flatMap((s, i) => Array.from({ length: s.days }, (_, d) => (
          <div key={`${i}-${d}`} className="flex-1 rounded-sm bg-brand/70" style={{ height: `${Math.max(6, (s.perDay / top) * 100)}%` }} title={`${s.perDay} в день`} />
        )))}
      </div>
      <p className="help">
        {describeGrowth(steps)}. За первые {days} дн. — {growthTotal(steps)} пинов; когда ступени кончатся, прогон идёт по {steps.at(-1)?.perDay} в день, пока пины не закончатся.
      </p>
    </div>
  );
}
