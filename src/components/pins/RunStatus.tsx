"use client";
import { useEffect, useState } from "react";
import { Alert, Badge, Card } from "@/components/ui";
import type { RunStatusView } from "@/lib/pins/runs/status";
import { ENGINE_LABELS, RUN_STATUS_LABELS, STAGE_LABELS, runStatusTone } from "./labels";

const LIVE = new Set(["QUEUED", "RUNNING"]);

/** Статус прогона: таймлайн этапов, прогресс задачи, счётчики. Опрос раз в 8 с, пока прогон работает. */
export function RunStatus({ initial }: { initial: RunStatusView }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState("");
  // после server action страница перерисовывается с новым initial — подхватываем его
  useEffect(() => setV(initial), [initial]);
  useEffect(() => {
    if (!LIVE.has(v.run.status) && !v.run.stopRequested) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/pins/runs/${v.run.id}/status`, { cache: "no-store" });
        if (res.ok) {
          setV(await res.json());
          setErr("");
        }
      } catch {
        setErr("Нет связи с сервером, показаны последние данные");
      }
    }, 8000);
    return () => clearInterval(t);
  }, [v.run.id, v.run.status, v.run.stopRequested]);

  const pct = v.job && v.job.total > 0 ? Math.round((v.job.done / v.job.total) * 100) : 0;
  const stageDot = (s: RunStatusView["stages"][number]["state"]) =>
    s === "done" ? "bg-ok" : s === "active" ? "bg-brand animate-pulse" : s === "waiting" ? "bg-warn" : s === "problem" ? "bg-danger" : "bg-line";

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={runStatusTone(v.run.status)}>{RUN_STATUS_LABELS[v.run.status]}</Badge>
          {v.job && (
            <span className="text-[14px]">
              {STAGE_LABELS[v.job.stage as keyof typeof STAGE_LABELS] ?? v.job.stage}: {v.job.label || v.job.status.toLowerCase()}
              {v.job.total > 0 && <span className="text-muted"> · {v.job.done}/{v.job.total}</span>}
            </span>
          )}
          <span className="ml-auto help">расход ${v.run.costUsd.toFixed(2)}</span>
        </div>
        {v.job && LIVE.has(v.run.status) && (
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-ink/5">
            <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
        {err && <p className="help mt-2">{err}</p>}
        {v.run.blockedReason && <div className="mt-3"><Alert tone="danger">{v.run.blockedReason}</Alert></div>}
        {v.run.status === "WAITING_MODERATION" && <div className="mt-3"><Alert tone="warn">Прогон ждёт модерации. <a className="underline" href={`/pinterest/pins/moderation?run=${v.run.id}`}>Открыть модерацию этого прогона →</a> После проверки всех пинов прогон продолжится сам.</Alert></div>}

        <ol className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-12">
          {v.stages.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-[12px]">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${stageDot(s.state)}`} />
              <span className={s.state === "todo" ? "text-muted" : ""}>{STAGE_LABELS[s.key]}</span>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Счётчики" description={`Страниц: ${v.pages.total}, с ключом: ${v.pages.withKeyword}${v.pages.errors ? `, с ошибкой: ${v.pages.errors}` : ""}`}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Тип</th><th>План</th><th>Промт</th><th>Картинка</th><th>Одобрено</th><th>Отклонено</th><th>Текст</th><th>WP</th><th>Дата</th><th>Ошибки</th></tr></thead>
            <tbody>
              {[...v.counters, v.total].map((c) => (
                <tr key={c.engine} className={c.engine === "ALL" ? "font-semibold" : ""}>
                  <td>{ENGINE_LABELS[c.engine] ?? c.engine}</td>
                  <td>{c.planned}</td><td>{c.withPrompt}</td><td>{c.withImage}</td><td>{c.approved}</td><td>{c.rejected}</td><td>{c.withText}</td><td>{c.uploaded}</td><td>{c.scheduled}</td>
                  <td className={c.errors ? "text-danger" : ""}>{c.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {v.problems.length > 0 && (
        <Card title="Проблемы">
          <ul className="space-y-1.5 text-[14px]">
            {v.problems.map((p, i) => (
              <li key={i}><Badge tone="danger">{p.count}</Badge> <span className="text-muted">{STAGE_LABELS[p.stage as keyof typeof STAGE_LABELS] ?? p.stage}:</span> {p.message || p.kind}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
