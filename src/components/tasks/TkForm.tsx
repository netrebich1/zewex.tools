"use client";
import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import type { TkState } from "@/actions/tasks";

type Act = (prev: TkState, f: FormData) => Promise<TkState>;

/**
 * Обёртка формы для server action раздела: показывает ошибку/успех, после успеха обновляет страницу,
 * по желанию очищает поля (`reset`) и переходит по адресу (`redirectTo`, `{id}` → id из ответа).
 */
export function TkForm({ action, children, className = "", reset = false, redirectTo, confirm, inline = false, hidden = {} }: {
  action: Act; children: ReactNode; className?: string; reset?: boolean; redirectTo?: string; confirm?: string; inline?: boolean; hidden?: Record<string, string | null | undefined>;
}) {
  const [state, act, pending] = useActionState<TkState, FormData>(action, {});
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (!state.at) return;
    if (reset) ref.current?.reset();
    if (redirectTo) router.push(redirectTo.replace("{id}", state.id ?? ""));
    else router.refresh();
  }, [state.at, state.id, reset, redirectTo, router]);
  return (
    <form ref={ref} action={act} className={className} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }} data-pending={pending ? "1" : undefined}>
      {Object.entries(hidden).map(([k, v]) => (v != null ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      {children}
      {state.error && <p className={`help text-danger ${inline ? "inline ml-2" : "mt-2"}`}>{state.error}</p>}
      {!inline && state.ok && !redirectTo && <p className="help text-ok mt-2">{state.ok}</p>}
    </form>
  );
}

/** Кнопка отправки с состоянием ожидания — для форм на TkForm. */
export function Btn({ children, className = "btn-primary", pendingText = "…", title }: { children: ReactNode; className?: string; pendingText?: string; title?: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" className={className} title={title} disabled={pending}>{pending ? pendingText : children}</button>;
}
