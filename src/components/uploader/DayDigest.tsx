import type { DayDigest, GrowthAlerts } from "@/lib/uploader/digest";

const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const wd = (s: string) => WD[new Date(`${s}T12:00:00Z`).getUTCDay()];
const fmt = (n: number) => n.toLocaleString("ru-RU");

/** Зелёная плашка роста: трафик с Pinterest (Метрика) и показы Pinterest, день к тому же дню прошлой недели, рост > 20%. */
export function GrowthBanner({ g }: { g: GrowthAlerts }) {
  const blocks = ([["Трафик с Pinterest (Метрика)", g.traffic], ["Показы в Pinterest", g.impressions]] as const).filter(([, x]) => x && x.list.length);
  if (!blocks.length) return null;
  return (
    <div className="rounded-xl border border-ok/40 bg-ok-soft px-4 py-3 text-[13.5px] space-y-1.5">
      {blocks.map(([title, x]) => (
        <div key={title}>
          <b className="text-ok">▲ {title}: вырос на {x!.list.length} {x!.list.length === 1 ? "сайте" : "сайтах"}</b>
          <span className="help"> · {wd(x!.day)} {dm(x!.day)} к {wd(x!.prevDay)} {dm(x!.prevDay)}, рост больше 20%</span>
          <div className="mt-0.5">{x!.list.slice(0, 12).map((s, i) => (
            <span key={s.site}>{i ? ", " : ""}<b>{s.site}</b> +{Math.round(s.pct * 100)}% <span className="help">({fmt(s.prev)} → {fmt(s.cur)})</span></span>
          ))}{x!.list.length > 12 ? <span className="help"> и ещё {x!.list.length - 12}</span> : null}</div>
        </div>
      ))}
    </div>
  );
}

/** Итог заливки дня: залито, не залито по причинам, в очереди, не запускались; 0 пинов в расписании после проверки. */
export function DayDigestCard({ d }: { d: DayDigest }) {
  if (!d.withFile) return null;
  const failedTotal = d.failed.reduce((s, f) => s + f.sites.length, 0);
  return (
    <div className={`rounded-xl border px-4 py-3 text-[13.5px] ${failedTotal ? "border-warn/40 bg-warn-soft/60" : "border-line"}`}>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="text-ok"><b>✓ Залито: {d.uploaded}</b> из {d.withFile}</span>
        {failedTotal > 0 && <span className="text-danger"><b>✗ Не залито с ошибкой: {failedTotal}</b></span>}
        {d.queued > 0 && <span><b>В очереди: {d.queued}</b></span>}
        {d.notStarted > 0 && <span className="help">Не запускались: {d.notStarted}</span>}
      </div>
      {d.failed.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">{d.failed.map((f) => (
          <li key={f.kind}><b>{f.label}</b> — {f.sites.length}: <span className="help">{f.sites.join(", ")}</span></li>
        ))}</ul>
      )}
      {d.emptySchedule.length > 0 && <div className="mt-1.5 text-warn">После проверки 0 пинов в расписании: {d.emptySchedule.join(", ")} — посмотрите скрин Created.</div>}
    </div>
  );
}
