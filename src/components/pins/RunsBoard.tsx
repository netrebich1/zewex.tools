"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui";
import type { RunOverview } from "@/lib/pins/runs/status";
import { RUN_STATUS_LABELS, STAGE_LABELS, runStatusTone } from "./labels";

const LIVE = new Set(["QUEUED", "RUNNING"]);

/** Доска прогонов на «Сегодня»: статус, этап, прогресс, проблемы; обновляется сама, пока что-то работает. */
export function RunsBoard({ initial }: { initial: RunOverview[] }) {
  const [rows, setRows] = useState(initial);
  useEffect(() => setRows(initial), [initial]);
  const anyLive = rows.some((r) => LIVE.has(r.status));
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(async () => {
      try { const res = await fetch("/api/pins/runs/overview", { cache: "no-store" }); if (res.ok) setRows(await res.json()); } catch { /* показываем прошлое */ }
    }, 10_000);
    return () => clearInterval(t);
  }, [anyLive]);

  const dot = (s: RunOverview["stages"][number]["state"]) =>
    s === "done" ? "bg-ok" : s === "active" ? "bg-brand animate-pulse" : s === "waiting" ? "bg-warn" : s === "problem" ? "bg-danger" : "bg-line";
  const nextHint = (r: RunOverview) => {
    if (r.status === "WAITING_MODERATION") return { text: `Проверить ${r.pendingModeration} пинов`, href: `/pinterest/pins/moderation?run=${r.id}`, tone: "warn" as const };
    if (r.status === "BLOCKED") return { text: "Исправить и продолжить", href: `/pinterest/pins/runs/${r.id}`, tone: "danger" as const };
    if (r.status === "STOPPED") return { text: r.stepByStep ? "Следующий этап: Продолжить" : "На паузе: Продолжить", href: `/pinterest/pins/runs/${r.id}`, tone: "neutral" as const };
    if (r.status === "DONE") return { text: "Готов к выгрузке", href: `/pinterest/pins/export`, tone: "ok" as const };
    return null;
  };
  // «N мин назад» считается после монтирования, чтобы серверная и клиентская разметка совпадали.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const ago = (iso: string) => {
    if (now === null) return "";
    const m = Math.round((now - new Date(iso).getTime()) / 60000);
    return m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`;
  };

  if (!rows.length) return <p className="help">Прогонов ещё не было.</p>;
  const active = rows.filter((r) => r.status !== "DONE" && r.status !== "FAILED");
  const finished = rows.filter((r) => r.status === "DONE" || r.status === "FAILED");

  const card = (r: RunOverview) => {
    const pct = r.job && r.job.total > 0 ? Math.round((r.job.done / r.job.total) * 100) : 0;
    const hint = nextHint(r);
    return (
      <div key={r.id} className={`rounded-xl border p-3 space-y-2 ${r.status === "BLOCKED" ? "border-danger/40" : r.status === "WAITING_MODERATION" ? "border-warn/50" : "border-line"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/pinterest/pins/runs/${r.id}`} className="font-semibold hover:underline truncate max-w-[360px]">{r.name || r.id.slice(0, 8)}</Link>
          <span className="help">{r.siteName}</span>
          <Badge tone={runStatusTone(r.status)}>{RUN_STATUS_LABELS[r.status]}</Badge>
          <Badge>{r.stepByStep ? "пошагово" : "автопилот"}</Badge>
          <span className="ml-auto help">{ago(r.updatedAt)} · ${r.costUsd.toFixed(2)}</span>
        </div>
        <ol className="flex flex-wrap gap-x-3 gap-y-1">
          {r.stages.map((s) => (
            <li key={s.key} className="flex items-center gap-1 text-[11px]"><span className={`inline-block h-2 w-2 rounded-full ${dot(s.state)}`} /><span className={s.state === "todo" ? "text-muted" : s.state === "active" ? "font-semibold" : ""}>{STAGE_LABELS[s.key]}</span></li>
          ))}
        </ol>
        {r.job && LIVE.has(r.status) && (
          <div>
            <div className="flex justify-between text-[12px]"><span>{STAGE_LABELS[r.job.stage as keyof typeof STAGE_LABELS] ?? r.job.stage}: {r.job.label || r.job.status.toLowerCase()}</span><span className="text-muted">{r.job.total > 0 ? `${r.job.done}/${r.job.total}` : ""}</span></div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/5"><div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-muted">страниц {r.pages} · пинов {r.pins}</span>
          {r.errors > 0 && <span className="text-danger">ошибок {r.errors}{r.topProblem ? `: ${r.topProblem}` : ""}</span>}
          {r.blockedReason && <span className="text-danger">{r.blockedReason}</span>}
          {hint && <Link href={hint.href} className={`ml-auto btn-sm ${hint.tone === "warn" ? "btn-brand" : hint.tone === "danger" ? "btn-danger" : "btn-ghost"}`}>{hint.text} →</Link>}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {active.length > 0 ? <div className="grid gap-3 lg:grid-cols-2">{active.map(card)}</div> : <p className="help">Сейчас ничего не выполняется.</p>}
      {finished.length > 0 && (
        <details>
          <summary className="help cursor-pointer">Завершённые: {finished.length}</summary>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">{finished.map(card)}</div>
        </details>
      )}
    </div>
  );
}
