/** Полоса запаса пинов по дням: серый — пусто, жёлтый — недобор, зелёный — норма, рамка — больше 100 (часть публикуется сразу). */
export function SiteCalendar({ days, target }: { days: Array<{ day: string; count: number }>; target: number }) {
  if (!days.length) return <p className="help">Нет данных.</p>;
  const tone = (n: number) => (n === 0 ? "bg-ink/10 text-muted" : n < target * 0.7 ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok");
  const fmt = (d: string) => { const [, m, dd] = d.split("-"); return `${dd}.${m}`; };
  return (
    <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-7 lg:grid-cols-7">
      {days.map((d) => (
        <div key={d.day} className={`rounded-lg px-2 py-1.5 text-center ${tone(d.count)} ${d.count > 100 ? "ring-2 ring-warn" : ""}`} title={`${d.day}: ${d.count} из ${target}${d.count > 100 ? ` — 100 по расписанию, ${d.count - 100} сразу при загрузке файла` : ""}`}>
          <div className="text-[11px] opacity-80">{fmt(d.day)}</div>
          <div className="text-[15px] font-semibold leading-tight">{d.count}</div>
          {d.count > 100 && <div className="text-[10px] leading-tight text-warn">+{d.count - 100} сразу</div>}
        </div>
      ))}
    </div>
  );
}
