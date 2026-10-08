"use client";
import { useActionState, type ReactNode } from "react";
import { Messages } from "@/components/ui";

export type FormState = { error?: string; ok?: string };

export function ActionForm({ action, children, className = "space-y-4", hidden }: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  children: ReactNode;
  className?: string;
  hidden?: Record<string, string>;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className={className}>
      <Messages error={state.error} ok={state.ok} />
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
    </form>
  );
}
