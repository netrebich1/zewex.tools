import type { BlogStageLog } from "@prisma/client";
import { stageLabel } from "@/lib/blog/stages";
import { fmtDate } from "@/lib/utils";
import { StageLogBadge } from "./StatusBadge";

function duration(a: Date, b: Date | null): string {
  if (!b) return "";
  const s = Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин ${s % 60} с` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** Таймлайн этапов поста (BlogStageLog). */
export function PostTimeline({ logs }: { logs: BlogStageLog[] }) {
  if (!logs.length) return <p className="help">Этапов ещё не было: статья ждёт воркера.</p>;
  return (
    <ol className="relative space-y-3 border-l border-line pl-4">
      {logs.map((l) => {
        const dot = l.status === "done" ? "bg-ok" : l.status === "error" ? "bg-danger" : l.status === "running" ? "bg-brand animate-pulse" : "bg-line-2";
        const hasDetails = l.details != null && !(typeof l.details === "object" && l.details && !Array.isArray(l.details) && Object.keys(l.details as object).length === 0);
        return (
          <li key={l.id} className="relative">
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
      })}
    </ol>
  );
}
