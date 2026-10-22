import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { addProjectTask, setProjectTask } from "@/actions/projects";
import type { TaskRow } from "@/lib/projects/tasks";

/** Список задач: по карточке (с формой добавления) или общий (с названием сайта). */
export function TasksList({ rows, accessId, members, showSite, now = Date.now() }: { rows: TaskRow[]; accessId?: string; members?: Array<{ id: string; name: string }>; showSite?: boolean; now?: number }) {
  return (
    <div>
      {accessId && members && (
        <ActionForm action={addProjectTask} hidden={{ accessId }} className="mb-3 grid gap-2 sm:grid-cols-[1fr_180px_150px_auto]">
          <input name="title" className="input py-2" placeholder="Новая задача" required />
          <select name="assigneeId" className="input py-2" defaultValue=""><option value="">— исполнитель —</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          <input type="date" name="dueAt" className="input py-2" />
          <SubmitButton className="btn-primary" pendingText="…">Добавить</SubmitButton>
        </ActionForm>
      )}
      {rows.length === 0 ? <p className="help">Задач нет.</p> : (
        <ul className="divide-y divide-line/70">
          {rows.map((t) => {
            const overdue = t.status !== "done" && t.dueAt && new Date(t.dueAt).getTime() < now;
            const aid = t.accessId;
            return (
              <li key={t.id} className="flex items-center gap-3 py-2">
                <ActionForm action={setProjectTask} hidden={{ accessId: aid, taskId: t.id, status: t.status === "done" ? "open" : "done" }} className="inline">
                  <SubmitButton className={`h-5 w-5 rounded border flex items-center justify-center text-[11px] ${t.status === "done" ? "bg-ok border-ok text-white" : "border-line-2 bg-surface"}`} pendingText="…">{t.status === "done" ? "✓" : ""}</SubmitButton>
                </ActionForm>
                <div className="flex-1 min-w-0">
                  <div className={`text-[14px] ${t.status === "done" ? "text-muted line-through" : ""}`}>{t.title}{showSite && <Link href={`/pinterest/projects/${aid}?tab=tasks`} className="ml-2 text-[12.5px] text-muted hover:underline">{t.siteName}</Link>}</div>
                  <div className="help">{t.assigneeName ?? "без исполнителя"}{t.dueAt ? <span className={overdue ? " text-danger" : ""}> · до {new Date(t.dueAt).toLocaleDateString("ru-RU")}</span> : ""}{t.status === "doing" ? " · в работе" : ""}{t.description ? ` · ${t.description}` : ""}</div>
                </div>
                {t.status === "open" && <ActionForm action={setProjectTask} hidden={{ accessId: aid, taskId: t.id, status: "doing" }} className="inline"><SubmitButton className="text-[12px] text-muted hover:text-ink" pendingText="…">в работу</SubmitButton></ActionForm>}
                <ActionForm action={setProjectTask} hidden={{ accessId: aid, taskId: t.id, status: "delete" }} className="inline"><SubmitButton className="text-[12px] text-muted hover:text-danger" pendingText="…" confirm="Удалить задачу?">×</SubmitButton></ActionForm>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
