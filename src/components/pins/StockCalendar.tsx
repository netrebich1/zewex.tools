"use client";
import Link from "next/link";
import { useMemo, useState } from "react";

export type StockSite = { id: string; name: string; target: number; counts: number[] };

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const DOW = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

/**
 * Сводный календарь запаса: строка — сайт, столбцы — дни выбранного месяца, цифра — пинов в день.
 * Данные на 3 месяца вперёд, на экране один месяц, переключение стрелками.
 */
export function StockCalendar({ sites, days }: { sites: StockSite[]; days: string[] }) {
  const months = useMemo(() => {
    const out: Array<{ key: string; label: string; idx: number[] }> = [];
    days.forEach((d, i) => {
      const key = d.slice(0, 7);
      let m = out.find((x) => x.key === key);
      if (!m) { const [y, mm] = key.split("-"); m = { key, label: `${MONTHS[Number(mm) - 1]} ${y}`, idx: [] }; out.push(m); }
      m.idx.push(i);
    });
    return out;
  }, [days]);
  const [mi, setMi] = useState(0);
  const month = months[Math.min(mi, months.length - 1)];
  const today = days[0];

  const stats = (s: StockSite) => {
    let run = 0;
    while (run < s.counts.length && s.counts[run] > 0) run++;
    const closedUntil = run ? days[run - 1] : null;
    const firstGap = run < s.counts.length ? days[run] : null;
    return { stock: run, closedUntil, firstGap };
  };
  const fmt = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "—");
  const dow = (d: string) => DOW[new Date(d + "T12:00:00Z").getUTCDay()];
  const tone = (n: number, target: number) => n === 0 ? "bg-ink/8 text-muted" : n < target * 0.7 ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok";
  const stockTone = (n: number) => n === 0 ? "bg-danger-soft text-danger" : n < 7 ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok";
  const empty = sites.filter((s) => stats(s).stock === 0);

  if (!sites.length) return <p className="help">Сайтов пока нет. Добавьте сайт в разделе «Сайты» портала и включите Pinterest Pins.</p>;

  return (
    <div className="space-y-3">
      {empty.length > 0 && (
        <div className="rounded-xl border border-danger/30 bg-danger-soft/40 p-3">
          <div className="text-[13px] font-semibold text-danger mb-1.5">Нужно заполнить в первую очередь</div>
          <div className="flex flex-wrap gap-1.5">
            {empty.map((s) => <Link key={s.id} href={`/pinterest/pins/runs/new?site=${s.id}`} className="badge bg-surface border border-line px-2.5 py-1 hover:border-danger"><b className="text-ink">{s.name}</b><span className="text-danger ml-1.5">пинов нет · запустить</span></Link>)}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost btn-sm" disabled={mi === 0} onClick={() => setMi((m) => Math.max(0, m - 1))}>←</button>
        <span className="text-[14px] font-semibold capitalize min-w-[150px] text-center">{month?.label}</span>
        <button type="button" className="btn-ghost btn-sm" disabled={mi >= months.length - 1} onClick={() => setMi((m) => Math.min(months.length - 1, m + 1))}>→</button>
        <span className="help">цифра — пинов в день · горизонт {days.length} дней</span>
        <span className="ml-auto flex items-center gap-3 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-3 rounded-full bg-ink/10" /> пусто</span>
          <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-3 rounded-full bg-warn-soft border border-warn/40" /> мало</span>
          <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-3 rounded-full bg-ok-soft border border-ok/40" /> норма</span>
        </span>
      </div>

      <div className="table-wrap">
        <table className="table text-[12px]">
          <thead>
            <tr>
              <th className="sticky left-0 bg-surface z-10 min-w-[180px]">Сайт</th>
              <th className="whitespace-nowrap">Закрыт до</th>
              <th className="whitespace-nowrap">Запас</th>
              <th className="whitespace-nowrap">В день</th>
              {month?.idx.map((i) => (
                <th key={days[i]} className={`px-0.5 text-center font-normal ${days[i] === today ? "text-ink font-semibold" : "text-muted"}`} title={days[i]}>
                  <div>{Number(days[i].slice(8, 10))}</div>
                  <div className="text-[10px] opacity-70">{dow(days[i])}</div>
                </th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sites.map((s) => {
              const st = stats(s);
              return (
                <tr key={s.id}>
                  <td className="sticky left-0 bg-surface z-10"><Link href={`/pinterest/pins/sites/${s.id}`} className="font-semibold text-[13px] hover:underline">{s.name}</Link></td>
                  <td className="whitespace-nowrap">{fmt(st.closedUntil)}</td>
                  <td><span className={`badge px-2 py-0.5 ${stockTone(st.stock)}`}>{st.stock} дн.</span></td>
                  <td className="text-muted">{s.target}</td>
                  {month?.idx.map((i) => {
                    const n = s.counts[i];
                    return (
                      <td key={i} className="px-0.5 py-1 text-center">
                        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold ${tone(n, s.target)} ${days[i] === today ? "ring-2 ring-ink/30" : ""}`} title={`${days[i]}: ${n} из ${s.target}`}>{n || ""}</span>
                      </td>
                    );
                  })}
                  <td className="text-right whitespace-nowrap"><Link href={`/pinterest/pins/runs/new?site=${s.id}`} className="btn-ghost btn-sm">Прогон</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
