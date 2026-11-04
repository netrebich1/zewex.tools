"use client";
import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { quickAdd, type TkState } from "@/actions/tasks";

/**
 * Быстрый ввод: одна строка → задача. Ctrl+K / «/» фокусирует поле с любого экрана раздела.
 * `defaults` — проект/исполнитель/день/статус текущего экрана (например, канбан проекта или «Завтра»).
 */
export function QuickAdd({ defaults = {}, placeholder, autoFocus = false }: { defaults?: { projectId?: string; assigneeId?: string; planDate?: string; status?: string; parentId?: string }; placeholder?: string; autoFocus?: boolean }) {
  const [state, action, pending] = useActionState<TkState, FormData>(quickAdd, {});
  const ref = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ref.current?.focus(); }
      else if (e.key === "/" && !typing) { e.preventDefault(); ref.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (state.ok && state.at) { formRef.current?.reset(); ref.current?.focus(); router.refresh(); }
  }, [state.ok, state.at, router]);
  return (
    <form ref={formRef} action={action} className="mb-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[18px] text-muted">＋</span>
          <input ref={ref} name="text" autoFocus={autoFocus} autoComplete="off" className="input !pl-10 !pr-20" placeholder={placeholder ?? "Что сделать? Например: Спросить у Димы про домены !! завтра #Pinterest @Никита"} />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 hidden sm:inline rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted">Ctrl K</kbd>
        </div>
        <button type="submit" className="btn-brand shrink-0" disabled={pending}>{pending ? "…" : "Добавить"}</button>
      </div>
      {Object.entries(defaults).map(([k, v]) => v ? <input key={k} type="hidden" name={k} value={v} /> : null)}
      {(state.error || state.ok) && <p className={`help mt-1.5 ${state.error ? "text-danger" : "text-ok"}`}>{state.error ?? state.ok}</p>}
      {!state.error && !state.ok && <p className="help mt-1.5 hidden sm:block"><code>!</code> важно · <code>!!</code> срочно · <code>@Имя</code> исполнитель · <code>#Проект</code> · <code>+метка</code> · «завтра», «пт», «12.11» план · «до 15.11» срок · «спросить у Димы …», «делегировать Саше …»</p>}
    </form>
  );
}
