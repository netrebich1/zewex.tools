"use client";
import { useState } from "react";

type Props = {
  niches: string[];
  labels: Record<string, string>;
  classes: Array<{ key: string; label: string }>;
  /** Сколько ядер есть в клетке (без учёта сайтов). */
  avail: Record<string, Record<string, number>>;
  costPerArticle: number;
  photos: number;
};

/** Таблица квот «ниша × частотность» с живым итогом и примерной стоимостью. Поля называются q.<ниша>.<класс>. */
export function QuotaGrid({ niches, labels, classes, avail, costPerArticle, photos }: Props) {
  const [vals, setVals] = useState<Record<string, number>>({});
  const [ph, setPh] = useState(photos);
  const [phMax, setPhMax] = useState<number | "">("");
  const avgPhotos = typeof phMax === "number" && phMax > ph ? (ph + phMax) / 2 : ph;
  const total = Object.values(vals).reduce((s, v) => s + (v || 0), 0);
  const set = (k: string, v: string) => setVals((p) => ({ ...p, [k]: Math.max(0, Math.floor(Number(v) || 0)) }));
  return (
    <div className="space-y-3">
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Ниша</th>{classes.map((c) => <th key={c.key} className="text-center">{c.label}</th>)}<th className="text-right">Итого</th></tr></thead>
          <tbody>
            {niches.map((n) => {
              const row = classes.reduce((s, c) => s + (vals[`${n}.${c.key}`] || 0), 0);
              return (
                <tr key={n}>
                  <td className="font-medium">{labels[n] ?? n}</td>
                  {classes.map((c) => {
                    const k = `${n}.${c.key}`;
                    const have = avail[n]?.[c.key] ?? 0;
                    return (
                      <td key={c.key} className="text-center">
                        <input name={`q.${k}`} type="number" min={0} max={5000} value={vals[k] || ""} onChange={(e) => set(k, e.target.value)} placeholder="0" disabled={!have} className="input py-1 w-20 text-center" />
                        <div className={`help ${vals[k] > have ? "text-danger" : ""}`}>есть {have}</div>
                      </td>
                    );
                  })}
                  <td className="text-right tabular-nums font-semibold">{row || ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="block"><span className="label">Фото в статье: от</span><input name="photos" type="number" min={5} max={100} value={ph} onChange={(e) => setPh(Math.max(5, Math.min(100, Number(e.target.value) || 0)))} className="input py-1.5 w-24" /></label>
        <label className="block"><span className="label">до (пусто — ровно «от»)</span><input name="photosMax" type="number" min={5} max={100} value={phMax} onChange={(e) => setPhMax(e.target.value === "" ? "" : Math.max(5, Math.min(100, Number(e.target.value) || 0)))} placeholder="35" className="input py-1.5 w-24" /></label>
        <label className="block"><span className="label">Разнообразие: тем с одним словом не больше</span><input name="maxPerWord" type="number" min={1} max={50} defaultValue={3} className="input py-1.5 w-24" /></label>
        <div className="flex flex-wrap gap-2 text-[13px] pb-1">
          <span className="rounded-full bg-ink/5 px-3 py-1.5">Статей: <b className="tabular-nums">{total}</b></span>
          <span className="rounded-full bg-ink/5 px-3 py-1.5">Текст ≈ <b className="tabular-nums">${(total * costPerArticle * (avgPhotos / 25)).toFixed(2)}</b></span>
        </div>
      </div>
      <p className="help">«Есть» — сколько тем этого класса в запасе вообще; при планировании ещё проверяется, подходит ли тема выбранным сайтам, поэтому итог может быть меньше. ВЧ — частотность от 30 000, СЧ — 10–30 000, НЧ — 3 000–10 000 (Ads Manager, США); «любые» — любая частотность, включая темы без данных. Число фото выбирается случайно в диапазоне на каждую статью. «Разнообразие»: слово ядра (almond, bob, linen…) встретится в партии не чаще заданного — темы расходятся по разным кластерам.</p>
    </div>
  );
}
