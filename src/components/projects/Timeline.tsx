import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { addProjectNote, deleteProjectNote } from "@/actions/projects";
import { EVENT_GROUPS, EVENT_LABELS, type EventKind } from "@/lib/projects/events";
import type { FeedItem } from "@/lib/projects/card";
import { fmtMoney } from "@/lib/utils";

/** Лента проекта: автособытия и заметки. Деньги в строках — только главным админам. */
export function Timeline({ accessId, items, userName, finance, filter, meId, isAdmin }: { accessId: string; items: FeedItem[]; userName: (id: string | null) => string | null; finance: boolean; filter: string; meId: string; isAdmin: boolean }) {
  const kinds = filter && EVENT_GROUPS[filter] ? new Set<string>(EVENT_GROUPS[filter].kinds) : null;
  const shown = items.filter((i) => (kinds ? kinds.has(i.kind) : true)).filter((i) => finance || i.kind !== "finance_added");
  const base = `/pinterest/projects/${accessId}?tab=feed`;
  let lastDay = "";
  return (
    <div>
      <ActionForm action={addProjectNote} hidden={{ accessId }} className="mb-3 flex gap-2">
        <input name="text" className="input py-2" placeholder="Заметка: что решили, что применили, что заметили" required />
        <SubmitButton className="btn-primary" pendingText="…">Записать</SubmitButton>
      </ActionForm>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <Link href={base} className={`tab ${!filter ? "active" : ""}`}>Всё</Link>
        {Object.entries(EVENT_GROUPS).filter(([k]) => finance || k !== "finance").map(([k, g]) => <Link key={k} href={`${base}&kind=${k}`} className={`tab ${filter === k ? "active" : ""}`}>{g.label}</Link>)}
      </div>
      {shown.length === 0 ? <p className="help">Пока пусто.</p> : (
        <ul className="space-y-1">
          {shown.map((i) => {
            const d = new Date(i.at);
            const day = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
            const header = day !== lastDay; lastDay = day;
            const label = EVENT_LABELS[i.kind as EventKind] ?? i.kind;
            const dot = i.isNote ? "bg-brand" : i.kind.startsWith("run_") || i.kind.startsWith("export_") ? "bg-ink/60" : i.kind.endsWith("_published") ? "bg-ok" : i.kind === "finance_added" ? "bg-warn" : "bg-ink/25";
            return (
              <li key={i.id}>
                {header && <div className="mt-3 mb-1 text-[12px] font-semibold uppercase tracking-wider text-muted">{day}</div>}
                <div className="flex items-start gap-2.5 py-1">
                  <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${dot}`} />
                  <div className="flex-1 min-w-0 text-[14px]">
                    <span className="text-muted text-[12.5px] tabular-nums mr-2">{d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
                    {!i.isNote && <span className="text-muted">{label}: </span>}
                    <span className={i.isNote ? "" : ""}>{linkify(i.summary)}</span>
                    {finance && i.costUsd != null && i.costUsd > 0 && <span className="ml-2 text-[12.5px] text-muted">{fmtMoney(i.costUsd)}</span>}
                    {i.userId && <span className="ml-2 text-[12.5px] text-muted">— {userName(i.userId)}</span>}
                    {i.refId && (i.kind === "run_created" || i.kind === "run_done" || i.kind === "run_failed") && <Link href={`/pinterest/pins/runs/${i.refId}`} className="ml-2 text-[12.5px] text-muted hover:underline">открыть</Link>}
                  </div>
                  {i.isNote && (i.userId === meId || isAdmin) && <ActionForm action={deleteProjectNote} hidden={{ accessId, noteId: i.id }} className="inline"><SubmitButton className="inline-flex items-center justify-center max-sm:min-h-9 max-sm:min-w-9 text-[12px] max-sm:text-[18px] text-muted hover:text-danger" pendingText="…" confirm="Удалить заметку?">×</SubmitButton></ActionForm>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line hover:text-ink break-all">{p.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}</a> : p));
}
