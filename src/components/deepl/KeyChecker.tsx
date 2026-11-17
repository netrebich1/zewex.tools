"use client";
import { useActionState, useState } from "react";
import { Badge, Card, Messages } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ActionForm } from "@/components/ActionForm";
import { addDeeplKeys, checkDeeplKeysTool, type KeyCheckState } from "@/actions/deepl";

const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");

/** Вкладка «Проверка ключей»: вставили → таблица «принят / отклонён, израсходовано, осталось» → по желанию добавить рабочие. */
export function KeyChecker() {
  const [state, action] = useActionState<KeyCheckState, FormData>(checkDeeplKeysTool, {});
  const [onlyBad, setOnlyBad] = useState(false);
  const rows = state.rows ?? [];
  const good = rows.filter((r) => r.ok);
  const bad = rows.length - good.length;
  const free = good.reduce((a, r) => a + (r.limit == null ? 0 : Math.max(0, r.limit - (r.used ?? 0))), 0);
  const addable = good.filter((r) => !r.inTool && (r.limit == null || (r.used ?? 0) < r.limit));
  const shown = onlyBad ? rows.filter((r) => !r.ok) : rows;

  return (
    <div className="space-y-5">
      <Card title="Ключи для проверки" description="Один или много ключей, каждый с новой строки; можно с названием перед ключом. Free-ключи (…:fx) проверяются через api-free.deepl.com, Pro — через api.deepl.com.">
        <form action={action} className="space-y-3">
          <Messages error={state.error} />
          <textarea name="keys" className="input min-h-[160px] font-mono text-[13px]" autoComplete="off" spellCheck={false} placeholder={"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx\nАккаунт 2 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx"} />
          <SubmitButton className="btn-brand" pendingText="Спрашиваю DeepL…">Проверить ключи</SubmitButton>
        </form>
      </Card>

      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Проверено ключей", value: fmt(rows.length) },
              { label: "Рабочих", value: fmt(good.length) },
              { label: "Отклонены DeepL / ошибка", value: fmt(bad) },
              { label: "Свободных символов у рабочих", value: fmt(free) },
            ].map((s) => (
              <div key={s.label} className="kpi">
                <div className="kpi-value">{s.value}</div>
                <div className="help">{s.label}</div>
              </div>
            ))}
          </div>

          <Card
            title={`Результат${state.at ? ` · ${new Date(state.at).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}` : ""}`}
            actions={bad > 0 ? <button type="button" className="btn-ghost btn-sm" onClick={() => setOnlyBad((v) => !v)}>{onlyBad ? "Показать все" : `Только нерабочие (${bad})`}</button> : null}
          >
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>#</th><th>Ключ</th><th>Тариф</th><th>DeepL</th><th>Израсходовано</th><th>Лимит</th><th>Осталось</th><th>В инструменте</th></tr></thead>
                <tbody>
                  {shown.map((r, i) => (
                    <tr key={r.secret}>
                      <td className="help">{i + 1}</td>
                      <td>
                        {r.label && <div className="font-medium">{r.label}</div>}
                        <div className="help font-mono">{r.hint}</div>
                      </td>
                      <td>{r.plan}</td>
                      <td className="max-w-[260px]">
                        <Badge tone={r.ok ? "ok" : "danger"}>{r.ok ? "принят" : "отклонён"}</Badge>
                        {!r.ok && <div className="help text-danger">{r.note}</div>}
                      </td>
                      <td className="whitespace-nowrap">{r.used == null ? "—" : fmt(r.used)}</td>
                      <td className="whitespace-nowrap">{r.ok ? (r.limit == null ? "без лимита" : fmt(r.limit)) : "—"}</td>
                      <td className="whitespace-nowrap font-medium">{!r.ok ? "—" : r.limit == null ? "без лимита" : fmt(Math.max(0, r.limit - (r.used ?? 0)))}</td>
                      <td>{r.inTool ? <Badge tone="neutral">уже есть</Badge> : <span className="help">нет</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {addable.length > 0 && (
              <ActionForm action={addDeeplKeys} className="mt-4 flex flex-wrap items-center gap-3">
                <input type="hidden" name="keys" value={addable.map((r) => `${r.label} ${r.secret}`.trim()).join("\n")} />
                <input type="hidden" name="limit" value="1000000" />
                <SubmitButton className="btn-primary" pendingText="Добавляю…">Добавить рабочие в инструмент ({addable.length})</SubmitButton>
                <span className="help">Рабочие ключи со свободными символами, которых ещё нет в «Ключах DeepL»; лимит — 1 000 000 на ключ, как по умолчанию.</span>
              </ActionForm>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
