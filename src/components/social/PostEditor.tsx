"use client";
import { useActionState, useState } from "react";
import { saveSocialPost, type FormState } from "@/actions/social";

/** Текст поста одной сети: правка на месте, счётчик знаков с лимитом сети, копирование. */
export function PostEditor({ runId, itemId, net, label, text, maxChars, isX }: { runId: string; itemId: string; net: string; label: string; text: string; maxChars: number; isX: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveSocialPost, {});
  const [value, setValue] = useState(text);
  const [copied, setCopied] = useState(false);
  // В X любая ссылка считается за 23 знака.
  const len = isX ? value.length - (value.match(/https?:\/\/\S+/g) ?? []).reduce((a, u) => a + u.length - 23, 0) : value.length;
  const over = len > maxChars;
  const dirty = value !== text;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* буфер недоступен */
    }
  };
  return (
    <form action={action} className="space-y-1.5">
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="net" value={net} />
      <textarea name="text" value={value} onChange={(e) => setValue(e.target.value)} rows={Math.min(12, Math.max(3, Math.ceil(value.length / 70) + value.split("\n").length - 1))} className="input w-full !text-[14px] leading-snug" aria-label={`Текст поста ${label}`} />
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className={over ? "font-semibold text-danger" : "text-muted"}>{len} / {maxChars}</span>
        {state.error && <span className="text-danger">{state.error}</span>}
        {state.ok && !dirty && <span className="text-ok">{state.ok}</span>}
        <span className="ml-auto flex gap-1.5">
          <button type="button" onClick={copy} className="btn-ghost btn-sm">{copied ? "Скопировано ✓" : "Копировать"}</button>
          {dirty && <button type="submit" disabled={pending || over} className="btn-primary btn-sm">{pending ? "Сохраняю…" : "Сохранить"}</button>}
        </span>
      </div>
    </form>
  );
}
