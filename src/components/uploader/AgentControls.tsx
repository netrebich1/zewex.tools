"use client";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { issueAgentAction, revokeAgentAction, type TokenState } from "@/actions/uploader";
import { Messages } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";

/** Выдача токена агенту: токен показывается один раз, с кнопкой «Скопировать». */
export function AgentTokenForm({ teams, defaultTeamId }: { teams: Array<{ id: string; name: string }>; defaultTeamId: string | null }) {
  const [state, action] = useActionState<TokenState, FormData>(issueAgentAction, {});
  const [copied, setCopied] = useState(false);
  return (
    <form action={action} className="space-y-3">
      <Messages error={state.error} ok={state.ok} />
      {state.token && (
        <div className="flex gap-2">
          <input readOnly value={state.token} className="input font-mono text-[12.5px]" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn-brand btn-sm whitespace-nowrap" onClick={() => navigator.clipboard.writeText(state.token!).then(() => setCopied(true))}>{copied ? "Скопировано" : "Скопировать"}</button>
        </div>
      )}
      <label className="block">
        <span className="label">Название (чей ПК)</span>
        <input name="name" className="input" placeholder="например: ПК Влада" maxLength={120} />
      </label>
      <label className="block">
        <span className="label">Команда (агент получит токен Dolphin этой команды и будет заливать только её профили)</span>
        <select name="teamId" className="input" defaultValue={defaultTeamId ?? ""} required>
          <option value="" disabled>— выберите команду —</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <SubmitButton className="btn-brand" pendingText="Выдаю…">Добавить агента и выдать токен</SubmitButton>
    </form>
  );
}

export function RevokeAgentButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} className="btn-ghost btn-sm text-danger" onClick={() => { if (window.confirm("Отозвать токен агента? Агент с ним перестанет работать, живые запуски остановятся.")) start(async () => { await revokeAgentAction(id); router.refresh(); }); }}>
      {pending ? "…" : "Отозвать"}
    </button>
  );
}
