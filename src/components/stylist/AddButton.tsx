"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addToLook } from "@/actions/stylist";

/** Кнопка карточки каталога: вещь в собираемый образ или аналогом к вещи образа. */
export function AddButton({ itemId, analog, inLook }: { itemId: string; analog?: string; inLook?: boolean }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<{ ok?: string; error?: string }>(inLook ? { ok: "В образе" } : {});
  const router = useRouter();
  if (state.ok) return <span className="block rounded-lg bg-ok-soft px-2 py-1.5 text-center text-[12px] font-medium text-ok">✓ {state.ok}</span>;
  return (
    <>
      <button
        type="button"
        disabled={pending}
        className="btn-primary btn-sm w-full"
        onClick={() => start(async () => {
          const r = await addToLook(itemId, analog ? { analog } : {});
          setState(r.error ? { error: r.error } : { ok: r.ok });
          if (!r.error) router.refresh();
        })}
      >
        {pending ? "Добавляю…" : analog ? "Как аналог" : "В образ"}
      </button>
      {state.error && <span className="mt-1 block text-[12px] text-danger">{state.error}</span>}
    </>
  );
}
