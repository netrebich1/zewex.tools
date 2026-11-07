import type { BlogStageLog } from "@prisma/client";
import { stageLabel } from "@/lib/blog/stages";
import { fmtDate } from "@/lib/utils";
import { Fold } from "@/components/ui/Fold";
import { StageLogBadge } from "./StatusBadge";

function duration(a: Date, b: Date | null): string {
  if (!b) return "";
  const s = Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин ${s % 60} с` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function StageItem({ l }: { l: BlogStageLog }) {
  const dot = l.status === "done" ? "bg-ok" : l.status === "error" ? "bg-danger" : l.status === "running" ? "bg-brand animate-pulse" : "bg-line-2";
  const hasDetails = l.details != null && !(typeof l.details === "object" && l.details && !Array.isArray(l.details) && Object.keys(l.details as object).length === 0);
  return (
    <li className="relative">
      <span className={`absolute -left-[22.5px] top-1.5 h-3 w-3 rounded-full ring-4 ring-bg ${dot}`} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{stageLabel(l.stage)}</span>
        <StageLogBadge status={l.status} />
        <span className="help tabular-nums">{fmtDate(l.startedAt)}{l.finishedAt ? ` · ${duration(l.startedAt, l.finishedAt)}` : ""}</span>
        {l.costUsd > 0 && <span className="help tabular-nums">${l.costUsd.toFixed(4)}</span>}
      </div>
      {l.summary && <p className="mt-0.5 text-[13.5px] text-ink-2">{l.summary}</p>}
      {l.error && <p className="mt-0.5 text-[13.5px] text-danger break-words">{l.error}</p>}
      {hasDetails && (
        <details className="mt-1">
          <summary className="help cursor-pointer">Подробности</summary>
          <pre className="mono mt-1 max-h-80 overflow-auto rounded-lg bg-surface-2 p-2 text-[11.5px] whitespace-pre-wrap break-words">{JSON.stringify(l.details, null, 2)}</pre>
        </details>
      )}
    </li>
  );
}

const finished = (l: BlogStageLog) => l.status === "done" || l.status === "skipped";

/** Таймлайн этапов поста (BlogStageLog): готовые этапы до текущего/ошибочного свёрнуты в один блок. */
export function PostTimeline({ logs }: { logs: BlogStageLog[] }) {
  if (!logs.length) return <p className="help">Этапов ещё не было: статья ждёт воркера.</p>;
  // последний этап виден всегда, даже если весь конвейер пройден
  const firstOpen = logs.findIndex((l) => !finished(l));
  const cut = firstOpen < 0 ? logs.length - 1 : firstOpen;
  const done = logs.slice(0, cut);
  const rest = logs.slice(cut);
  const ms = done.reduce((n, l) => n + (l.finishedAt ? Math.max(0, l.finishedAt.getTime() - l.startedAt.getTime()) : 0), 0);
  const cost = done.reduce((n, l) => n + l.costUsd, 0);
  return (
    <div className="space-y-3">
      {done.length > 0 && (
        <Fold title={`${done.length} ${plural(done.length)} ${done.length % 10 === 1 && done.length % 100 !== 11 ? "готов" : "готово"}`} summary={[ms ? duration(new Date(0), new Date(ms)) : "", cost ? `$${cost.toFixed(3)}` : ""].filter(Boolean).join(" · ") || undefined}>
          <ol className="relative mt-1 space-y-3 border-l border-line pl-4">{done.map((l) => <StageItem key={l.id} l={l} />)}</ol>
        </Fold>
      )}
      <ol className="relative space-y-3 border-l border-line pl-4">{rest.map((l) => <StageItem key={l.id} l={l} />)}</ol>
    </div>
  );
}

function plural(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? "этап" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "этапа" : "этапов";
}
