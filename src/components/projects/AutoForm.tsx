"use client";
import { useActionState, type ReactNode } from "react";
import { Messages } from "@/components/ui";

export type FormState = { error?: string; ok?: string };

/** Форма, которая отправляется сама при смене значения (селекты статуса/ответственного) — без кнопки «Сохранить». */
export function AutoForm({ action, children, className = "", hidden, showOk }: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  children: ReactNode;
  className?: string;
  hidden?: Record<string, string>;
  showOk?: boolean;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className={className} onChange={(e) => e.currentTarget.requestSubmit()}>
      {(state.error || (showOk && state.ok)) && <Messages error={state.error} ok={showOk ? state.ok : undefined} />}
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
    </form>
  );
}
