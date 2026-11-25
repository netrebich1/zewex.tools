"use client";
import { useState } from "react";
import { saveRoutine } from "@/actions/tasks";
import { MODES, PRIORITIES, RULES, WEEKDAYS } from "@/lib/tasks/consts";
import type { ProjectNode } from "@/lib/tasks/queries";
import type { Person } from "@/lib/tasks/access";
import { TkForm, Btn } from "./TkForm";

export type RoutineRow = { id: string; title: string; description: string | null; rule: string; ruleArg: string; steps: string[]; mode: string; priority: number; assigneeId: string | null; projectId: string | null; active: boolean; nextAt: string | null };

/** Форма регламента: расписание (день/неделя/число/раз в N), шаги-цепочка, кому и в какой проект. */
export function RoutineForm({ r, people, projects, onDone }: { r?: RoutineRow | null; people: Person[]; projects: ProjectNode[]; onDone?: string }) {
  const [rule, setRule] = useState(r?.rule ?? "weekly");
  const days = new Set(r?.rule === "weekly" ? r.ruleArg.split(",") : ["1"]);
  return (
    <TkForm action={saveRoutine} hidden={{ id: r?.id }} reset={!r} redirectTo={onDone} className="space-y-3">
      <div><label className="label">Что делать</label><input name="title" defaultValue={r?.title ?? ""} required maxLength={300} className="input" placeholder="Например: Проверить офферы и ставки" /></div>
      <div>
        <label className="label">Как часто</label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {RULES.map((x) => (
            <label key={x.key} className={`tab cursor-pointer ${rule === x.key ? "active" : "border-line"}`}><input type="radio" name="rule" value={x.key} checked={rule === x.key} onChange={() => setRule(x.key)} className="sr-only" />{x.label}</label>
          ))}
        </div>
        {rule === "weekly" && (
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d, i) => (
              <label key={d} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] cursor-pointer has-[:checked]:bg-ink has-[:checked]:text-bg"><input type="checkbox" name="days" value={String(i + 1)} defaultChecked={days.has(String(i + 1))} className="sr-only" />{d}</label>
            ))}
          </div>
        )}
        {rule === "monthly" && <div className="flex items-center gap-2"><input type="number" name="dom" min={1} max={31} defaultValue={r?.rule === "monthly" ? r.ruleArg : 1} className="input !w-24" /><span className="help">-го числа каждого месяца (если дней меньше — последний день)</span></div>}
        {rule === "every_n" && <div className="flex items-center gap-2"><span className="help">раз в</span><input type="number" name="n" min={1} max={365} defaultValue={r?.rule === "every_n" ? r.ruleArg : 3} className="input !w-24" /><span className="help">дней, считая от последней задачи</span></div>}
      </div>
      <div>
        <label className="label">Шаги (цепочка) — по одному в строке, станут чеклистом задачи</label>
        <textarea name="steps" rows={4} defaultValue={r?.steps.join("\n") ?? ""} className="input" placeholder={"Открыть кабинет партнёрки\nСравнить ставки с прошлой неделей\nНаписать менеджеру, если упало"} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div><label className="label">Способ</label><select name="mode" defaultValue={r?.mode ?? "do"} className="input">{MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></div>
        <div><label className="label">Приоритет</label><select name="priority" defaultValue={r?.priority ?? 3} className="input">{PRIORITIES.map((p) => <option key={p.n} value={p.n}>{p.label}</option>)}</select></div>
        <div><label className="label">Кому</label><select name="assigneeId" defaultValue={r?.assigneeId ?? ""} className="input"><option value="">— никто —</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div><label className="label">Проект</label><select name="projectId" defaultValue={r?.projectId ?? ""} className="input"><option value="">— без проекта —</option>{projects.map((p) => <option key={p.id} value={p.id}>{"  ".repeat(p.depth)}{p.name}</option>)}</select></div>
      </div>
      <div><label className="label">Описание</label><textarea name="description" rows={2} defaultValue={r?.description ?? ""} className="input" placeholder="Зачем это и где смотреть" /></div>
      <div className="flex items-center gap-3">
        <Btn className="btn-primary">{r ? "Сохранить" : "Добавить регламент"}</Btn>
        {r && <label className="inline-flex items-center gap-2 text-[14px]"><input type="hidden" name="active" value="0" /><input type="checkbox" name="active" value="1" defaultChecked={r.active} /> Включён</label>}
        {!r && <input type="hidden" name="active" value="1" />}
      </div>
    </TkForm>
  );
}
