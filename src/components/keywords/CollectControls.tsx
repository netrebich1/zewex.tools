"use client";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { enqueueFilteredAction, enqueueKeywordAction, issueTokenAction, liftLimitAction, queueControlAction, revokeCollectorAction, type TokenState } from "@/actions/keywords";
import type { Params, Tab } from "@/lib/keywords/query";
import { Messages } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";

/** Выдача токена расширению: токен показывается один раз, с кнопкой «Скопировать». */
export function TokenForm({ accounts }: { accounts: Array<{ id: string; name: string }> }) {
  const [state, action] = useActionState<TokenState, FormData>(issueTokenAction, {});
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
        <span className="label">Аккаунт Pinterest в этом браузере</span>
        <select name="accountId" className="input" defaultValue="" required>
          <option value="" disabled>Выберите…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="label">Подпись (необязательно)</span>
        <input name="name" className="input" placeholder="например: Mac Влада, Chrome профиль 2" maxLength={120} />
      </label>
      <SubmitButton className="btn-brand w-full" pendingText="Выдаю…">Выдать токен расширению</SubmitButton>
    </form>
  );
}

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return { pending, run: (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); }) };
}

export function LiftLimitButton({ id }: { id: string }) {
  const { pending, run } = useRun();
  return <button type="button" disabled={pending} className="btn-ghost btn-sm" onClick={() => run(() => liftLimitAction(id))}>{pending ? "…" : "Снять ограничение"}</button>;
}

export function RevokeButton({ id }: { id: string }) {
  const { pending, run } = useRun();
  return (
    <button type="button" disabled={pending} className="btn-ghost btn-sm" onClick={() => { if (window.confirm("Отозвать токен? Расширение с ним перестанет работать.")) run(() => revokeCollectorAction(id)); }}>
      {pending ? "…" : "Отозвать"}
    </button>
  );
}

export function QueueButtons({ kind, queued, failed }: { kind: "serp" | "volume"; queued: number; failed: number }) {
  const { pending, run } = useRun();
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {queued > 0 && <button type="button" disabled={pending} className="btn-ghost btn-sm" onClick={() => { if (window.confirm(`Убрать из очереди ${queued} ждущих заданий?`)) run(() => queueControlAction("clear", kind)); }}>Очистить очередь</button>}
      {failed > 0 && <button type="button" disabled={pending} className="btn-ghost btn-sm" onClick={() => run(() => queueControlAction("retry", kind))}>Повторить ошибки ({failed})</button>}
    </span>
  );
}

/** Кнопки в раскрытой строке ключа: снять выдачу / частотность заново. */
export function KeywordQueueButtons({ id }: { id: string }) {
  const { pending, run } = useRun();
  const [msg, setMsg] = useState("");
  const go = (kind: "serp" | "volume") => run(async () => { const r = await enqueueKeywordAction(id, kind); setMsg(r.added ? "В очереди сбора" : "Уже в очереди"); });
  return (
    <>
      <button type="button" disabled={pending} onClick={() => go("serp")} className="btn-ghost btn-sm">Снять выдачу заново</button>
      <button type="button" disabled={pending} onClick={() => go("volume")} className="btn-ghost btn-sm">Частотность заново</button>
      {msg && <span className="help w-full">{msg}</span>}
    </>
  );
}

/** Шапка экрана «Ключи»/«Новые»: вся текущая выборка — в очередь сбора. */
export function FilteredQueueButtons({ tab, params, total }: { tab: Tab; params: Params; total: number }) {
  const { pending, run } = useRun();
  const [msg, setMsg] = useState("");
  const go = (kind: "serp" | "volume") => {
    const n = Math.min(total, 5000);
    if (!window.confirm(`Поставить в очередь ${kind === "volume" ? "частотности" : "выдачи"} ${n} ключей из этой выборки?`)) return;
    run(async () => { const r = await enqueueFilteredAction(tab, params, kind); setMsg(`В очередь добавлено ${r.added} из ${r.total}`); });
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" disabled={pending || !total} onClick={() => go("serp")} className="btn-ghost btn-sm" title="Расширение снимет выдачу Pinterest для всех ключей под текущими фильтрами">В очередь: выдача</button>
      <button type="button" disabled={pending || !total} onClick={() => go("volume")} className="btn-ghost btn-sm" title="Расширение снимет частотность в Ads Manager для всех ключей под текущими фильтрами">В очередь: частотность</button>
      {msg && <span className="help">{msg}</span>}
    </span>
  );
}
