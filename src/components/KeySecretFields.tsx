"use client";
import { useState } from "react";
import { Field } from "./ui/index";

type P = { id: string; name: string; authType: string };

/**
 * Провайдер + секрет на форме нового ключа. У DataForSEO не ключ, а логин и пароль API (Basic-авторизация),
 * поэтому для него показываем два поля; сервер склеит их в «логин:пароль».
 */
export function KeySecretFields({ providers }: { providers: P[] }) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const current = providers.find((p) => p.id === providerId);
  const basic = current?.authType === "BASIC";
  const query = current?.authType === "QUERY";
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Провайдер">
          <select name="providerId" className="input" required value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Название (как вы его узнаете)"><input name="label" className="input" required placeholder={basic ? "DataForSEO — основной" : "OpenRouter — основной"} /></Field>
      </div>
      {basic ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Логин DataForSEO" hint="Email аккаунта. Смотрите в кабинете: dataforseo.com → API Access."><input name="secretLogin" className="input" required autoComplete="off" placeholder="name@example.com" /></Field>
          <Field label="Пароль API" hint="Не пароль от сайта, а API password из раздела API Access."><input name="secretPassword" className="input font-mono" required autoComplete="off" placeholder="пароль API" /></Field>
        </div>
      ) : (
        <Field label={query ? "API key" : "Секрет"} hint={query ? "api_key из личного кабинета SerpAPI." : "Ключ из кабинета провайдера, обычно начинается с sk-."}>
          <input name="secret" className="input font-mono" required autoComplete="off" placeholder={query ? "api_key" : "sk-…"} />
        </Field>
      )}
    </>
  );
}
