"use client";
import { useActionState, type ReactNode } from "react";
import Link from "next/link";
import { Messages } from "@/components/ui";

/** link — кнопка-ссылка под сообщением (например «Открыть существующий сайт»). */
export type FormState = { error?: string; ok?: string; link?: { href: string; label: string } };

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
      {state.link && <Link href={state.link.href} className="btn-primary btn-sm inline-flex mb-4">{state.link.label} →</Link>}
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
    </form>
  );
}
