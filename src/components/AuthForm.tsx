"use client";
import { useActionState } from "react";
import Link from "next/link";
import type { FormState } from "@/actions/auth";
import { Field, Messages } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";

type Props = {
  mode: "login" | "register" | "invite";
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  token?: string;
  email?: string;
};

export function AuthForm({ mode, action, token, email }: Props) {
  const [state, formAction] = useActionState(action, {});
  const title = mode === "login" ? "Вход" : mode === "register" ? "Первая регистрация" : "Завершите регистрацию";
  return (
    <form action={formAction} className="space-y-4">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">{title}</h1>
        {mode === "register" && <p className="help mt-1">Доступно только для владельца портала. Остальные входят по приглашению.</p>}
        {mode === "invite" && email && <p className="help mt-1">Приглашение для {email}</p>}
      </div>
      <Messages error={state.error} ok={state.ok} />
      {token && <input type="hidden" name="token" value={token} />}
      {mode !== "invite" && (
        <Field label="Почта"><input name="email" type="email" autoComplete="email" required className="input" placeholder="you@example.com" /></Field>
      )}
      {mode !== "login" && (
        <Field label="Имя"><input name="name" type="text" required className="input" placeholder="Как вас называть" /></Field>
      )}
      <Field label="Пароль">
        <input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} className="input" placeholder="Минимум 8 символов" />
      </Field>
      <SubmitButton className="btn-brand w-full" pendingText="Секунду…">
        {mode === "login" ? "Войти" : "Создать аккаунт"}
      </SubmitButton>
      <div className="text-center help">
        {mode === "login" ? <Link href="/register" className="hover:text-ink">Первая регистрация владельца</Link> : <Link href="/login" className="hover:text-ink">Уже есть аккаунт? Войти</Link>}
      </div>
    </form>
  );
}
