"use client";
import { useActionState } from "react";
import Link from "next/link";
import type { FormState } from "@/actions/auth";
import { Field, Messages } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";

type Props = {
  mode: "login" | "register";
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  /** Show the "first registration" link on the login page (only while the owner has not registered). */
  showRegister?: boolean;
};

export function AuthForm({ mode, action, showRegister }: Props) {
  const [state, formAction] = useActionState(action, {});
  const title = mode === "login" ? "Вход" : "Первая регистрация";
  return (
    <form action={formAction} className="space-y-4">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">{title}</h1>
        {mode === "register" && <p className="help mt-1">Доступно только для владельца портала. Остальным аккаунт создаёт администратор.</p>}
      </div>
      <Messages error={state.error} ok={state.ok} />
      {mode === "login"
        ? <Field label="Логин"><input name="login" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required className="input" placeholder="Логин или почта" /></Field>
        : <Field label="Почта"><input name="email" type="email" autoComplete="email" required className="input" placeholder="you@example.com" /></Field>}
      {mode !== "login" && (
        <Field label="Имя"><input name="name" type="text" required className="input" placeholder="Как вас называть" /></Field>
      )}
      <Field label="Пароль">
        <input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "login" ? undefined : 8} className="input" placeholder={mode === "login" ? "" : "Минимум 8 символов"} />
      </Field>
      <SubmitButton className="btn-brand w-full" pendingText="Секунду…">
        {mode === "login" ? "Войти" : "Создать аккаунт"}
      </SubmitButton>
      <div className="text-center help">
        {mode === "login"
          ? (showRegister ? <Link href="/register" className="hover:text-ink">Первая регистрация владельца</Link> : <span>Аккаунт создаёт администратор</span>)
          : <Link href="/login" className="hover:text-ink">Уже есть аккаунт? Войти</Link>}
      </div>
    </form>
  );
}
