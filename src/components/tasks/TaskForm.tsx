"use client";
import { useState } from "react";
import { saveTask } from "@/actions/tasks";
import { MODES, PRIORITIES, STATUSES } from "@/lib/tasks/consts";
import type { ProjectNode, TaskRow } from "@/lib/tasks/queries";
import type { Person } from "@/lib/tasks/access";
import { TkForm, Btn } from "./TkForm";

export type FormRefs = { people: Person[]; projects: ProjectNode[]; labels: { id: string; name: string; color: string }[]; parents: { id: string; title: string }[] };

/** Полная форма задачи (создание и правка). Способ «делегировать/спросить» открывает поля «кому» и «ждём до». */
export function TaskForm({ task, refs, defaults = {}, back }: { task?: TaskRow | null; refs: FormRefs; defaults?: Partial<Pick<TaskRow, "projectId" | "assigneeId" | "parentId" | "planDate" | "status">>; back?: string }) {
  const [mode, setMode] = useState(task?.mode ?? "do");
  const [status, setStatus] = useState(task?.status ?? defaults.status ?? "backlog");
  const picked = new Set(task?.labels.map((l) => l.id) ?? []);
  return (
    <TkForm action={saveTask} redirectTo={task ? undefined : "/tasks/t/{id}"} hidden={{ id: task?.id }} className="space-y-4">
      <div>
        <label className="label">Название</label>
        <input name="title" defaultValue={task?.title ?? ""} required maxLength={300} className="input text-[16px] font-medium" placeholder="Коротко, что сделать" autoFocus={!task} />
      </div>
      <div>
        <label className="label">Способ</label>
        <div className="flex flex-wrap gap-1.5">
          {MODES.map((m) => (
            <label key={m.key} className={`tab cursor-pointer ${mode === m.key ? "active" : "border-line"}`} title={m.hint}>
              <input type="radio" name="mode" value={m.key} checked={mode === m.key} onChange={() => setMode(m.key)} className="sr-only" />{m.icon} {m.label}
            </label>
          ))}
        </div>
      </div>
      {mode !== "do" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">{mode === "ask" ? "У кого спросить" : "Кому поручить"}</label><input name="counterpart" defaultValue={task?.counterpart ?? ""} maxLength={120} className="input" placeholder="Имя или компания" /></div>
          <div><label className="label">Ждём ответа до</label><input type="date" name="waitUntil" defaultValue={task?.waitUntil ?? ""} className="input" /><p className="help mt-1">Когда день пройдёт — утром бот напомнит «пора пнуть».</p></div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Статус</label>
          <select name="status" value={status} onChange={(e) => setStatus(e.target.value)} className="input">{STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        </div>
        <div>
          <label className="label">Приоритет</label>
          <select name="priority" defaultValue={task?.priority ?? 3} className="input">{PRIORITIES.map((p) => <option key={p.n} value={p.n}>{p.icon} {p.label}</option>)}</select>
        </div>
        <div>
          <label className="label">Исполнитель</label>
          <select name="assigneeId" defaultValue={task?.assigneeId ?? defaults.assigneeId ?? ""} className="input"><option value="">— никто —</option>{refs.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </div>
        <div>
          <label className="label">Проект</label>
          <select name="projectId" defaultValue={task?.projectId ?? defaults.projectId ?? ""} className="input"><option value="">— без проекта —</option>{refs.projects.map((p) => <option key={p.id} value={p.id}>{"  ".repeat(p.depth)}{p.name}</option>)}</select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div><label className="label">План на день</label><input type="date" name="planDate" defaultValue={task?.planDate ?? defaults.planDate ?? ""} className="input" /></div>
        <div><label className="label">Начало</label><input type="date" name="startAt" defaultValue={task?.startAt ?? ""} className="input" /></div>
        <div><label className="label">Дедлайн</label><input type="date" name="dueAt" defaultValue={task?.dueAt ?? ""} className="input" /></div>
      </div>
      {refs.labels.length > 0 && (
        <div>
          <label className="label">Метки</label>
          <div className="flex flex-wrap gap-1.5">
            {refs.labels.map((l) => (
              <label key={l.id} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12.5px] font-semibold cursor-pointer has-[:checked]:border-transparent" style={{ ["--c" as string]: l.color }}>
                <input type="checkbox" name="labelIds" value={l.id} defaultChecked={picked.has(l.id)} className="accent-[var(--c)]" /><span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />{l.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <div>
        <label className="label">Родительская задача</label>
        <select name="parentId" defaultValue={task?.parentId ?? defaults.parentId ?? ""} className="input"><option value="">— нет (верхний уровень) —</option>{refs.parents.filter((p) => p.id !== task?.id).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
      </div>
      <div>
        <label className="label">Описание</label>
        <textarea name="description" defaultValue={task?.description ?? ""} rows={5} className="input" placeholder="Подробности, ссылки, что считать результатом" />
      </div>
      <div className="flex items-center gap-2">
        <Btn className="btn-primary">{task ? "Сохранить" : "Создать задачу"}</Btn>
        {back && <a href={back} className="btn-ghost">Отмена</a>}
      </div>
    </TkForm>
  );
}
