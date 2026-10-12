"use client";
import { useActionState, useState } from "react";
import { createUser } from "@/actions/admin";
import { Field, Messages } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { PermissionsFields } from "@/components/PermissionsFields";
import { PasswordInput } from "./PasswordInput";
import { ToolsAccessFields, type ToolOption } from "./ToolsAccessFields";

type Created = { login: string; password: string };
type State = { error?: string; created?: Created };

/**
 * Добавление сотрудника: админ сам задаёт логин и пароль. После создания показываем готовый текст
 * с адресом, логином и паролем — пароль в базе хранится только хэшем, позже его не посмотреть.
 */
export function NewUserForm({ teams, tools, loginUrl }: { teams: { id: string; name: string }[]; tools: ToolOption[]; loginUrl: string }) {
  const [login, setLogin] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);
  const [state, formAction] = useActionState(async (_prev: State, form: FormData): Promise<State> => {
    const sent = String(form.get("password") ?? "");
    const res = await createUser({}, form);
    if (!res.ok) return { error: res.error ?? "Не удалось добавить сотрудника" };
    setLogin(""); setName(""); setPassword(""); setCopied(false);
    return { created: { login: res.login ?? "", password: sent } };
  }, {});

  const created = state.created;
  const message = created ? `Адрес: ${loginUrl}\nЛогин: ${created.login}\nПароль: ${created.password}` : "";
  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = message;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
  }

  return (
    <form action={formAction} className="space-y-4">
      <Messages error={state.error} />
      {created && (
        <div className="rounded-xl border border-ok/20 bg-ok-soft p-3.5 space-y-2.5">
          <p className="text-[14px] font-medium text-ok">Сотрудник добавлен. Отправьте ему эти данные:</p>
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-surface px-3 py-2 font-mono text-[13px] text-ink select-all">{message}</pre>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary btn-sm" onClick={copy}>{copied ? "Скопировано" : "Скопировать"}</button>
            <span className="help">Пароль больше нигде не показывается.</span>
          </div>
        </div>
      )}
      <Field label="Логин" hint="Латинские буквы, цифры и знаки . _ - @. Можно почту, можно просто имя: ivan.">
        <input name="login" className="input" required minLength={3} maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="ivan" value={login} onChange={(e) => setLogin(e.target.value)} />
      </Field>
      <Field label="Пароль"><PasswordInput value={password} onChange={setPassword} /></Field>
      <Field label="Имя"><input name="name" className="input" placeholder="Как отображать" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Роль">
        <select name="role" className="input" defaultValue="MEMBER">
          <option value="MEMBER">Сотрудник: права по профилю ниже</option>
          <option value="ADMIN">Админ: полные права, как у вас</option>
        </select>
      </Field>
      {teams.length > 0 && (
        <div>
          <span className="label">Команды</span>
          <div className="space-y-1.5">
            {teams.map((t) => <label key={t.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="teamIds" value={t.id} className="h-4 w-4" /> {t.name}</label>)}
          </div>
        </div>
      )}
      <div>
        <span className="label">Инструменты</span>
        <ToolsAccessFields tools={tools} />
      </div>
      <details className="rounded-xl border border-line p-3">
        <summary className="cursor-pointer text-[14px] font-medium">Права сотрудника</summary>
        <div className="mt-3"><PermissionsFields compact /></div>
      </details>
      <SubmitButton className="btn-brand w-full" pendingText="Создаю…">Добавить сотрудника</SubmitButton>
    </form>
  );
}
