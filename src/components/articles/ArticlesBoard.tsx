"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui";
import type { ArticleBrief, WorkerState } from "@/lib/articles/queries";
import { badgeTone } from "./StatusBadge";

type Payload = { rows: ArticleBrief[]; worker: WorkerState };

/**
 * Живой список статей в работе и в очереди («Сейчас в работе» на Обзоре). Пока есть статьи «В работе»
 * или в очереди, опрашивает /api/articles/overview раз в 10 с. Плашка воркера обновляется тем же запросом.
 */
export function ArticlesBoard({ initial, worker: initialWorker, errorsHour = 0, limit = 40 }: { initial: ArticleBrief[]; worker: WorkerState; errorsHour?: number; limit?: number }) {
  const [rows, setRows] = useState(initial);
  const [worker, setWorker] = useState(initialWorker);
  const [err, setErr] = useState("");
  useEffect(() => { setRows(initial); setWorker(initialWorker); }, [initial, initialWorker]);
  const anyLive = rows.some((r) => r.status === "RUNNING" || r.status === "PUBLISHING") || worker.pending > 0;
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/articles/overview", { cache: "no-store" });
        if (res.ok) { const j = (await res.json()) as Payload; setRows(j.rows); setWorker(j.worker); setErr(""); }
      } catch { setErr("Нет связи с сервером, показаны последние данные"); }
    }, 10_000);
    return () => clearInterval(t);
  }, [anyLive]);

  // «N мин назад» считается после монтирования, чтобы серверная и клиентская разметка совпадали.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const ago = (iso: string) => {
    if (now === null) return "";
    const s = Math.round((now - new Date(iso).getTime()) / 1000);
    if (s < 60) return "только что";
    const m = Math.round(s / 60);
    return m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`;
  };

  const running = rows.filter((r) => r.status === "RUNNING" || r.status === "PUBLISHING");
  const queued = rows.filter((r) => r.status !== "RUNNING" && r.status !== "PUBLISHING");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <WorkerPill w={worker} />
        <Link href="/pinterest/articles/journal" className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] ${errorsHour ? "bg-danger-soft text-danger" : "bg-ink/5 text-ink-2"}`} title="Ошибки конвейера за последний час по вашим сайтам">
          Ошибок за час: <b className="tabular-nums">{errorsHour}</b>
        </Link>
      </div>
      {err && <p className="help text-danger">{err}</p>}
      {running.length === 0 && queued.length === 0 && <p className="help">Сейчас ничего не выполняется и очередь пуста. Нажмите «Новый запуск», чтобы поставить статьи в работу.</p>}
      {running.length > 0 && (
        <ul className="grid gap-2 lg:grid-cols-2">
          {running.map((r) => (
            <li key={r.id} className={`rounded-xl border p-3 space-y-1.5 ${r.leaseAlive || r.status !== "RUNNING" ? "border-line" : "border-danger/40"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/pinterest/articles/articles/${r.id}`} className="font-semibold hover:underline truncate max-w-[360px]" title={r.keyword}>{r.keyword}</Link>
                <Link href={`/pinterest/articles/sites/${r.siteId}`} className="help hover:underline">{r.siteName}</Link>
                <Badge tone={badgeTone(r.tone)}>{r.statusLabel}</Badge>
                <span className="ml-auto help tabular-nums">{ago(r.updatedAt)} · ${r.costUsd.toFixed(2)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span className="inline-flex items-center gap-1.5"><span className={`inline-block h-2 w-2 rounded-full ${r.leaseAlive || r.status !== "RUNNING" ? "bg-brand animate-pulse" : "bg-danger"}`} />{r.stageLabel}</span>
                {r.note && <span className="text-muted truncate max-w-[420px]" title={r.note}>{r.note}</span>}
                {r.attempts > 1 && <span className="text-warn">попытка {r.attempts}</span>}
                {!r.leaseAlive && r.status === "RUNNING" && <span className="text-danger">воркер не отвечает</span>}
                {r.runId && <Link href={`/pinterest/articles/runs/${r.runId}`} className="ml-auto help hover:underline">запуск: {r.runName || r.runId.slice(0, 8)}</Link>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {queued.length > 0 && (
        <details open={running.length === 0}>
          <summary className="help cursor-pointer">В очереди: {worker.pending > queued.length ? `${worker.pending} (показаны ${queued.length})` : queued.length}</summary>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
            {queued.slice(0, limit).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[13px]">
                <Link href={`/pinterest/articles/articles/${r.id}`} className="font-medium hover:underline truncate max-w-[320px]" title={r.keyword}>{r.keyword}</Link>
                <span className="help">{r.siteName}</span>
                <Badge tone={badgeTone(r.tone)}>{r.statusLabel}</Badge>
                <span className="help">→ {r.stageLabel}</span>
                {r.note && <span className="help truncate max-w-[300px]" title={r.note}>{r.note}</span>}
                <span className="ml-auto help tabular-nums">{ago(r.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Плашка «Воркер»: по статьям RUNNING с живой арендой. */
export function WorkerPill({ w }: { w: WorkerState }) {
  const state = w.stuck
    ? { cls: "bg-danger-soft text-danger", dot: "bg-danger", text: `Воркер не отвечает: ${w.running} стат. «В работе» с истёкшей арендой. Проверьте службу zewex-worker.` }
    : w.alive > 0
      ? { cls: "bg-ok-soft text-ok", dot: "bg-ok animate-pulse", text: `Воркер работает: ${w.alive} стат. в работе${w.pending ? `, ${w.pending} в очереди` : ""}` }
      : w.pending > 0
        ? { cls: "bg-warn-soft text-warn", dot: "bg-warn", text: `В очереди ${w.pending}, в работе нет: ждём свободного места по лимитам сайта или воркер выключен` }
        : { cls: "bg-ink/5 text-ink-2", dot: "bg-line-2", text: "Воркер простаивает: статей в работе нет" };
  return (
    <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] ${state.cls}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${state.dot}`} />
      <span>{state.text}</span>
    </div>
  );
}
