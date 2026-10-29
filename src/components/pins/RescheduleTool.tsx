"use client";
import { useState, useTransition } from "react";
import { Field } from "@/components/ui";
import { GrowthStepsEditor } from "@/components/pins/GrowthStepsEditor";
import { applyRescheduleAction, previewRescheduleAction, type RescheduleInput } from "@/actions/pinsSchedule";
import type { ReschedulePreview } from "@/lib/pins/runs/reschedule";
import { cleanGrowth } from "@/lib/pins/schedule/growth";

const ru = (k: string) => { const [, m, d] = k.split("-"); return `${d}.${m}`; };
const SHOW_DAYS = 63;

/**
 * «Перераспределить график» сайта: новая норма в день (ровная или «плавный рост») для уже запланированных пинов.
 * Сначала предпросмотр «было → станет», потом запись. Залитые в Pinterest дни и закреплённые пины не двигаются.
 */
export function RescheduleTool({ siteId, today, current }: { siteId: string; today: string; current: number }) {
  const [mode, setMode] = useState<"flat" | "growth">("flat");
  const [perDay, setPerDay] = useState(current || 50);
  const [from, setFrom] = useState(today);
  const [withUndated, setWithUndated] = useState(true);
  const [preview, setPreview] = useState<ReschedulePreview | null>(null);
  const [msg, setMsg] = useState<{ error?: string; ok?: string }>({});
  const [pending, start] = useTransition();
  const [formEl, setFormEl] = useState<HTMLFormElement | null>(null);

  const input = (): RescheduleInput => {
    const f = formEl ? new FormData(formEl) : new FormData();
    const steps = cleanGrowth(f.getAll("growthDays").map((d, i) => ({ days: d, perDay: f.getAll("growthPerDay")[i] })));
    return { siteId, from, mode, perDay, steps, withUndated };
  };
  const run = (apply: boolean) => start(async () => {
    setMsg({});
    const r = apply ? await applyRescheduleAction(input()) : await previewRescheduleAction(input());
    if (r.error) { setMsg({ error: r.error }); return; }
    setPreview(r.preview ?? null);
    if (r.applied) setMsg({ ok: `Готово: новые даты у ${r.preview?.changed ?? 0} пинов. Файлы дней выгружаются уже по новому графику.` });
  });
  const dirty = () => { setPreview(null); setMsg({}); };

  const immediate = preview?.over.reduce((n, d) => n + d.immediate, 0) ?? 0;
  const topCount = Math.max(1, ...(preview?.after ?? []).map((d) => d.count), ...(preview?.before ?? []).map((d) => d.count));
  return (
    <form ref={setFormEl} onSubmit={(e) => { e.preventDefault(); run(false); }} onChange={dirty} className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={`rounded-xl border p-3 cursor-pointer ${mode === "flat" ? "border-brand ring-2 ring-brand/30" : "border-line"}`}>
          <div className="flex items-center gap-2"><input type="radio" checked={mode === "flat"} onChange={() => setMode("flat")} /> <b>Ровно N пинов в день</b></div>
          <p className="help mt-1">Все подвижные пины сайта встают по N в день подряд с выбранной даты. Порядок пинов сохраняется.</p>
          {mode === "flat" && <div className="mt-2"><Field label="Всего пинов сайта в день" hint="До 200; сверх 100 — публикация сразу"><input type="number" min={1} max={200} className="input py-1.5" value={perDay} onChange={(e) => setPerDay(Math.max(1, Math.min(200, Math.floor(Number(e.target.value) || 1))))} /></Field></div>}
        </label>
        <label className={`rounded-xl border p-3 cursor-pointer ${mode === "growth" ? "border-brand ring-2 ring-brand/30" : "border-line"}`}>
          <div className="flex items-center gap-2"><input type="radio" checked={mode === "growth"} onChange={() => setMode("growth")} /> <b>Плавный рост</b></div>
          <p className="help mt-1">Норма растёт ступенями: неделя по 15, неделя по 20, потом по 30…</p>
          {mode === "growth" && <div className="mt-2"><GrowthStepsEditor max={200} /></div>}
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Перераспределить с даты" hint="Пины до этой даты не трогаются"><input type="date" min={today} className="input py-1.5" value={from} onChange={(e) => setFrom(e.target.value || today)} /></Field>
        <label className="flex items-center gap-2 pb-2 text-[13px]"><input type="checkbox" checked={withUndated} onChange={(e) => setWithUndated(e.target.checked)} className="h-3.5 w-3.5" /> Взять и готовые пины без даты</label>
        <button type="submit" className="btn-primary" disabled={pending}>{pending ? "Считаю…" : "Показать, что получится"}</button>
      </div>
      <p className="help">Не двигаются: дни, чей файл уже залит в Pinterest (отметка «залито»), и пины, закреплённые вручную, — они остаются на своих днях и входят в норму дня.</p>

      {msg.error && <div className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{msg.error}</div>}
      {msg.ok && <div className="rounded-lg bg-ok-soft px-3 py-2 text-[13px] text-ok">{msg.ok}</div>}

      {preview && (
        <div className="space-y-3 rounded-xl border border-line p-3">
          <div className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
            <div><div className="text-muted text-[12px]">Переставляется</div><b>{preview.movable + preview.undated}</b>{preview.undated > 0 && <span className="text-muted"> (без даты {preview.undated})</span>}</div>
            <div><div className="text-muted text-[12px]">Остаются на месте</div><b>{preview.kept}</b>{preview.uploadedDays.length > 0 && <span className="text-muted"> (залитых дней {preview.uploadedDays.length})</span>}</div>
            <div><div className="text-muted text-[12px]">Последний день</div><b>{preview.lastBefore ? ru(preview.lastBefore) : "—"} → {preview.lastAfter ? ru(preview.lastAfter) : "—"}</b></div>
            <div><div className="text-muted text-[12px]">Новые даты у</div><b>{preview.changed}</b> пинов</div>
          </div>
          {immediate > 0 && (
            <div className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
              <b>В {preview.over.length} дн. больше 100 пинов — {immediate} опубликуются сразу.</b> Pinterest ставит по времени только 100 пинов файла дня: первые 100 пойдут по расписанию, остальные выгрузятся без даты и выйдут сразу при загрузке файла.
              {" "}Дни: {preview.over.slice(0, 6).map((d) => `${ru(d.day)} (${d.total}: 100 + ${d.immediate} сразу)`).join(", ")}{preview.over.length > 6 ? "…" : ""}
            </div>
          )}
          {preview.unscheduled > 0 && <div className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">Не хватило дней: {preview.unscheduled} пинов останутся без даты. Увеличьте норму.</div>}
          <div>
            <div className="mb-1 flex flex-wrap gap-3 text-[12px] text-muted">
              <span><span className="inline-block h-2.5 w-2.5 rounded-sm bg-ink/20 align-middle" /> было</span>
              <span><span className="inline-block h-2.5 w-2.5 rounded-sm bg-brand/70 align-middle" /> станет</span>
              <span><span className="inline-block h-2.5 w-2.5 rounded-sm bg-warn align-middle" /> больше 100 — часть сразу</span>
              <span><span className="inline-block h-2.5 w-2.5 rounded-sm bg-ok align-middle" /> залит, не трогается</span>
            </div>
            <div className="grid grid-cols-7 gap-1 sm:grid-cols-9 lg:grid-cols-[repeat(14,minmax(0,1fr))]">
              {preview.after.slice(0, SHOW_DAYS).map((d, i) => {
                const was = preview.before[i]?.count ?? 0;
                const up = preview.uploadedDays.includes(d.day);
                return (
                  <div key={d.day} className={`rounded-lg border px-1 pb-1 pt-0.5 text-center ${up ? "border-ok" : d.count > 100 ? "border-warn" : "border-line"}`} title={`${d.day}: было ${was}, станет ${d.count}${d.count > 100 ? ` (100 по расписанию + ${d.count - 100} сразу)` : ""}${up ? " · файл уже залит" : ""}`}>
                    <div className="text-[10.5px] text-muted">{ru(d.day)}</div>
                    <div className="flex h-8 items-end justify-center gap-0.5">
                      <div className="w-2 rounded-sm bg-ink/20" style={{ height: `${Math.max(4, (was / topCount) * 100)}%` }} />
                      <div className={`w-2 rounded-sm ${up ? "bg-ok" : d.count > 100 ? "bg-warn" : "bg-brand/70"}`} style={{ height: `${Math.max(4, (d.count / topCount) * 100)}%` }} />
                    </div>
                    <div className="text-[11px] leading-tight"><span className="text-muted">{was}</span>→<b>{d.count}</b></div>
                  </div>
                );
              })}
            </div>
            {preview.after.length > SHOW_DAYS && <p className="help mt-1">Показаны первые {SHOW_DAYS} дн. из {preview.after.length}.</p>}
          </div>
          <button type="button" className="btn-brand" disabled={pending || !preview.changed} onClick={() => { if (confirm(`Поставить новые даты ${preview.changed} пинам?`)) run(true); }}>{pending ? "Записываю…" : "Применить новый график"}</button>
        </div>
      )}
    </form>
  );
}
