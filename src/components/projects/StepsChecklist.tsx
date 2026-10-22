import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { addProjectStep, deleteProjectStep, setProjectStep } from "@/actions/projects";
import { STEP_STATES } from "@/lib/projects/steps";

type Step = { id: string; key: string; title: string; state: string; doneAt: Date | null; doneById: string | null; note: string | null };

/** Чеклист этапов: клик по кружку — следующее состояние (не начато → в работе → сделано), «не нужно» — отдельно. */
export function StepsChecklist({ accessId, steps, userName }: { accessId: string; steps: Step[]; userName: (id: string | null) => string | null }) {
  const next = (s: string) => (s === "todo" ? "doing" : s === "doing" ? "done" : "todo");
  return (
    <div>
      <ul className="divide-y divide-line/70">
        {steps.map((s) => {
          const st = STEP_STATES[s.state] ?? STEP_STATES.todo;
          const circle = s.state === "done" ? "bg-ok text-white border-ok" : s.state === "doing" ? "bg-brand text-[#1a1200] border-brand" : s.state === "skip" ? "bg-ink/10 text-muted border-line line-through" : "bg-surface border-line-2";
          return (
            <li key={s.id} className="flex items-center gap-3 py-2">
              <ActionForm action={setProjectStep} hidden={{ accessId, stepId: s.id, state: next(s.state) }} className="inline">
                <SubmitButton className={`h-6 w-6 rounded-full border flex items-center justify-center text-[12px] ${circle}`} pendingText="…">{s.state === "done" ? "✓" : s.state === "doing" ? "…" : ""}</SubmitButton>
              </ActionForm>
              <div className="flex-1 min-w-0">
                <div className={`text-[14px] ${s.state === "skip" ? "text-muted line-through" : s.state === "done" ? "" : ""}`}>{s.title}</div>
                <div className="help">{st.label}{s.doneAt ? ` · ${s.doneAt.toLocaleDateString("ru-RU")}` : ""}{s.doneById ? ` · ${userName(s.doneById) ?? ""}` : ""}{s.note ? ` · ${s.note}` : ""}</div>
              </div>
              {s.state !== "skip" && s.state !== "done" && (
                <ActionForm action={setProjectStep} hidden={{ accessId, stepId: s.id, state: "skip" }} className="inline"><SubmitButton className="text-[12px] text-muted hover:text-ink" pendingText="…">не нужно</SubmitButton></ActionForm>
              )}
              {s.state === "skip" && (
                <ActionForm action={setProjectStep} hidden={{ accessId, stepId: s.id, state: "todo" }} className="inline"><SubmitButton className="text-[12px] text-muted hover:text-ink" pendingText="…">вернуть</SubmitButton></ActionForm>
              )}
              {s.key.startsWith("custom:") && (
                <ActionForm action={deleteProjectStep} hidden={{ accessId, stepId: s.id }} className="inline"><SubmitButton className="text-[12px] text-muted hover:text-danger" pendingText="…" confirm="Удалить этап?">×</SubmitButton></ActionForm>
              )}
            </li>
          );
        })}
      </ul>
      <ActionForm action={addProjectStep} hidden={{ accessId }} className="mt-2 flex gap-2">
        <input name="title" className="input py-1.5 text-[13.5px]" placeholder="Свой этап, например «Перевод на 2 язык»" />
        <SubmitButton className="btn-ghost btn-sm" pendingText="…">Добавить</SubmitButton>
      </ActionForm>
    </div>
  );
}
