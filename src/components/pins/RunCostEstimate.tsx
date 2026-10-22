"use client";
import { useEffect, useRef, useState } from "react";
import { fmtMoney } from "@/lib/utils";
import type { RunEstimate, SlotUnit } from "@/lib/pins/runs/estimate";

const UNIT_LABEL: Record<SlotUnit, string> = { aiPin: "ИИ-пин", pin: "пин", page: "статья" };

type Mix = { ai: number; photos: number; canvas: number; pinora: number };

/**
 * Примерная стоимость прогона перед запуском. Число статей приходит от формы, число пинов на статью читается
 * прямо из полей рецепта (`mixAi`, `mixPhotos`, `mixCanvas`, `mixPinora`) той же формы — при каждом изменении.
 * Считает сервер (`/api/pins/estimate`) по средним ценам прошлых прогонов и остаткам на счетах.
 */
export function RunCostEstimate({ pages, pagesLabel, siteId }: { pages: number; pagesLabel: string; siteId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mix, setMix] = useState<Mix | null>(null);
  const [data, setData] = useState<RunEstimate | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Читаем смесь из полей формы; подписываемся на любые изменения в форме.
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const read = () => {
      const fd = new FormData(form);
      const n = (k: string) => Math.max(0, Math.floor(Number(fd.get(k)) || 0));
      setMix({ ai: n("mixAi"), photos: n("mixPhotos"), canvas: n("mixCanvas"), pinora: n("mixPinora") });
    };
    read();
    form.addEventListener("input", read);
    form.addEventListener("change", read);
    return () => { form.removeEventListener("input", read); form.removeEventListener("change", read); };
  }, [siteId]);

  useEffect(() => {
    if (!mix) return;
    const perPage = mix.ai + mix.photos + mix.canvas + mix.pinora;
    if (!pages || !perPage) { setData(null); return; }
    const t = setTimeout(async () => {
      setBusy(true); setError("");
      try {
        const q = new URLSearchParams({ site: siteId, pages: String(pages), ai: String(mix.ai), photos: String(mix.photos), canvas: String(mix.canvas), pinora: String(mix.pinora) });
        const r = await fetch(`/api/pins/estimate?${q}`, { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Ошибка");
        setData(j as RunEstimate);
      } catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    }, 400);
    return () => clearTimeout(t);
  }, [pages, mix?.ai, mix?.photos, mix?.canvas, mix?.pinora]); // eslint-disable-line react-hooks/exhaustive-deps

  const short = !pages || !mix || !(mix.ai + mix.photos + mix.canvas + mix.pinora);
  return (
    <div ref={ref} className="rounded-xl border border-line p-3 sm:p-4 space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">Примерная стоимость прогона</span>
        {data?.totalUsd != null && <span className="text-[20px] font-semibold">≈ {fmtMoney(data.totalUsd)}</span>}
        {busy && <span className="help">считаю…</span>}
      </div>
      {short ? (
        <p className="help">Появится, когда будут известны статьи ({pagesLabel}) и число пинов на статью.</p>
      ) : error ? (
        <p className="text-danger text-[13px]">{error}</p>
      ) : data ? (
        <>
          <p className="help">
            {pagesLabel}: <b>{data.pages}</b> · пинов ≈ <b>{data.pins.total}</b> (ИИ {data.pins.ai}, Canvas {data.pins.canvas}, фото {data.pins.photos}) ·
            цены — средние по {data.basis.runs} прогонам за {data.basis.sinceDays} дней; реальный расход обычно ±30 %.
          </p>
          {data.errors.map((e) => <p key={e} className="text-danger text-[13px]">{e}</p>)}
          {data.providers.length > 0 && (
            <table className="w-full text-[13px]">
              <thead><tr className="text-muted text-left"><th className="font-normal py-1">Система</th><th className="font-normal py-1">Нужно</th><th className="font-normal py-1">На счёте</th><th className="font-normal py-1">Ключ</th></tr></thead>
              <tbody>
                {data.providers.map((p) => (
                  <tr key={p.slug} className="border-t border-line">
                    <td className="py-1 font-medium">{p.name}</td>
                    <td className="py-1">{fmtMoney(p.costUsd)}</td>
                    <td className={`py-1 ${p.enough === false ? "text-danger font-semibold" : p.enough ? "text-ok" : "text-muted"}`}>
                      {p.remainingUsd != null ? fmtMoney(p.remainingUsd) : p.balanceNote}
                      {p.enough === false && <span className="block text-[12px] font-normal">не хватит: нужно ещё ≈ {fmtMoney(Math.max(0, p.costUsd * 1.2 - (p.remainingUsd ?? 0)))} с запасом 20 %</span>}
                    </td>
                    <td className="py-1 text-muted">{p.keys.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <details>
            <summary className="help cursor-pointer">Как посчитано</summary>
            <ul className="help mt-1 list-disc pl-5">
              {data.parts.map((p) => (
                <li key={p.slot}>
                  {p.slotName} ({p.providerName}): {p.units} × {p.rate != null ? fmtMoney(p.rate) : "?"} за {UNIT_LABEL[p.unit]} = {p.costUsd != null ? fmtMoney(p.costUsd) : "?"}
                  {p.note ? ` — ${p.note}` : ""}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
    </div>
  );
}
