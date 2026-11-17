"use client";
import { addCheck, addNote, changeStatus, deleteCheck, deleteTask, nudged, planTask, toggleCheck } from "@/actions/tasks";
import { addDays, STATUSES, todayYmd } from "@/lib/tasks/consts";
import type { TaskRow } from "@/lib/tasks/queries";
import { TkForm, Btn } from "./TkForm";

/** Панель быстрых действий в карточке задачи: статус, план на день, «пнули», удалить. */
export function TaskActions({ t, back }: { t: TaskRow; back?: string }) {
  const today = todayYmd();
  const open = t.status !== "done" && t.status !== "cancelled";
  return (
    <div className="space-y-3">
      <div>
        <p className="label">Статус</p>
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => (
            <TkForm key={s.key} action={changeStatus} hidden={{ id: t.id, status: s.key }} inline>
              <Btn className={`tab ${t.status === s.key ? "active" : "border-line"}`}>{s.label}</Btn>
            </TkForm>
          ))}
        </div>
      </div>
      {open && (
        <div>
          <p className="label">План</p>
          <div className="flex flex-wrap gap-1.5">
            <TkForm action={planTask} hidden={{ id: t.id, ymd: today }} inline><Btn className={`btn-ghost btn-sm ${t.planDate === today ? "!border-brand" : ""}`}>На сегодня</Btn></TkForm>
            <TkForm action={planTask} hidden={{ id: t.id, ymd: addDays(today, 1) }} inline><Btn className={`btn-ghost btn-sm ${t.planDate === addDays(today, 1) ? "!border-brand" : ""}`}>На завтра</Btn></TkForm>
            <TkForm action={planTask} hidden={{ id: t.id }} inline className="inline-flex items-center gap-1">
              <input type="date" name="ymd" className="input !w-auto !py-1.5 !text-[13px]" defaultValue={t.planDate ?? ""} /><Btn className="btn-ghost btn-sm">На день</Btn>
            </TkForm>
          </div>
        </div>
      )}
      {open && t.mode !== "do" && (
        <div>
          <p className="label">Ожидание</p>
          <div className="flex flex-wrap gap-1.5">
            <TkForm action={nudged} hidden={{ id: t.id, days: "2" }} inline><Btn className="btn-ghost btn-sm">Пнул(а), ждём ещё 2 дня</Btn></TkForm>
            <TkForm action={nudged} hidden={{ id: t.id, days: "7" }} inline><Btn className="btn-ghost btn-sm">…ещё неделю</Btn></TkForm>
          </div>
        </div>
      )}
      <TkForm action={deleteTask} hidden={{ id: t.id, back: back ?? "/tasks/board" }} confirm={`Удалить задачу «${t.title}»? Подзадачи останутся без родителя.`} inline>
        <Btn className="btn-ghost btn-sm text-danger">Удалить задачу</Btn>
      </TkForm>
    </div>
  );
}

export function Checklist({ taskId, items }: { taskId: string; items: { id: string; text: string; done: boolean }[] }) {
  return (
    <div className="space-y-1.5">
      {items.map((c) => (
        <div key={c.id} className="flex items-center gap-2 group">
          <TkForm action={toggleCheck} hidden={{ id: c.id }} inline className="flex items-center gap-2 min-w-0 flex-1">
            <button type="submit" className={`h-5 w-5 shrink-0 rounded-md border flex items-center justify-center text-[12px] ${c.done ? "bg-ok border-ok text-white" : "border-line-2 hover:border-ink"}`} aria-label={c.done ? "Снять отметку" : "Отметить"}>{c.done ? "✓" : ""}</button>
            <span className={`text-[14px] [overflow-wrap:anywhere] ${c.done ? "line-through text-muted" : ""}`}>{c.text}</span>
          </TkForm>
          <TkForm action={deleteCheck} hidden={{ id: c.id }} inline><button type="submit" className="text-muted hover:text-danger text-[14px] opacity-0 group-hover:opacity-100 px-1" title="Удалить пункт">✕</button></TkForm>
        </div>
      ))}
      <TkForm action={addCheck} hidden={{ taskId }} reset inline className="flex items-center gap-2 pt-1">
        <input name="text" className="input !py-1.5 !text-[14px]" placeholder="Новый пункт (несколько — с новой строки через Shift+Enter в описании)" />
        <Btn className="btn-ghost btn-sm shrink-0">Добавить</Btn>
      </TkForm>
    </div>
  );
}

export function NoteForm({ taskId }: { taskId: string }) {
  return (
    <TkForm action={addNote} hidden={{ taskId }} reset className="flex items-start gap-2">
      <textarea name="text" rows={2} className="input" placeholder="Комментарий… Исполнитель и автор получат его в Telegram" required />
      <Btn className="btn-primary shrink-0">Отправить</Btn>
    </TkForm>
  );
}
