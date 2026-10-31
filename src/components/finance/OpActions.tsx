"use client";
import Link from "next/link";
import { useActionState } from "react";
import { deleteOp, repeatOp, type FinState } from "@/actions/finance";

/** Кнопки строки журнала: изменить, повторить сегодня, удалить. */
export function OpActions({ id, label, back }: { id: string; label: string; back?: string }) {
  const [rep, repAction, repPending] = useActionState<FinState, FormData>(repeatOp, {});
  const [del, delAction, delPending] = useActionState<FinState, FormData>(deleteOp, {});
  const err = rep.error || del.error;
  return (
    <div className="flex items-center justify-end gap-1 whitespace-nowrap">
      {err && <span className="text-[12px] text-danger mr-1">{err}</span>}
      {rep.ok && <span className="text-[12px] text-ok mr-1">✓</span>}
      <Link href={`/finance/ops/${id}${back ? `?back=${encodeURIComponent(back)}` : ""}`} className="btn-ghost btn-sm">Изменить</Link>
      <form action={repAction}><input type="hidden" name="id" value={id} />
        <button className="btn-ghost btn-sm min-h-9 min-w-9" disabled={repPending} title="Записать такую же операцию сегодняшней датой" onClick={(e) => { if (!confirm(`Повторить сегодня: ${label}?`)) e.preventDefault(); }}>↻</button>
      </form>
      <form action={delAction}><input type="hidden" name="id" value={id} />
        <button className="btn-ghost btn-sm text-danger min-h-9 min-w-9" disabled={delPending} title="Удалить" onClick={(e) => { if (!confirm(`Удалить операцию: ${label}? Это сразу изменит итоги и долг.`)) e.preventDefault(); }}>✕</button>
      </form>
    </div>
  );
}
