"use client";
import { useActionState, useEffect, useState } from "react";
import { renameDomainRunAction, type FormState } from "@/actions/domains";

/** Переименование подбора: кнопка → поле с названием и «Сохранить». compact — значок карандаша для строки списка. */
export function RenameRun({ id, name, compact = false }: { id: string; name: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(renameDomainRunAction, {});
  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state]);

  if (!open) {
    return compact ? (
      <button type="button" className="ml-1.5 text-muted hover:text-ink" title="Переименовать" aria-label="Переименовать" onClick={() => setOpen(true)}>✎</button>
    ) : (
      <button type="button" className="btn-ghost" onClick={() => setOpen(true)}>Переименовать</button>
    );
  }
  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="id" value={id} />
      <input name="name" className="input !w-64 !py-1.5 text-[13.5px]" defaultValue={name} maxLength={120} autoFocus required />
      <button type="submit" className="btn-primary btn-sm" disabled={pending}>{pending ? "…" : "Сохранить"}</button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>Отмена</button>
      {state.error && <span className="text-[12.5px] text-danger">{state.error}</span>}
    </form>
  );
}
