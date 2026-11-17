"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setFailedKeywordIgnored, setFailedKeywordNote } from "@/actions/articlesFailedKeywords";

/** Переключатель «не считать» в строке списка неудачных ключей. */
export function FailedKeywordIgnoreToggle({ id, ignored }: { id: string; ignored: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(ignored);
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  return (
    <label className={`inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap ${pending ? "opacity-60" : ""}`} title={err || "Ключ останется в списке, но не попадёт в счётчики, сводку и предупреждения при запуске"}>
      <input
        type="checkbox"
        checked={on}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.checked;
          setOn(v); setErr("");
          start(async () => {
            const r = await setFailedKeywordIgnored(id, v).catch(() => ({ error: "Сервер не ответил" }));
            if (r.error) { setOn(!v); setErr(r.error); }
            else router.refresh();
          });
        }}
      />
      не считать
      {err && <span className="text-danger">!</span>}
    </label>
  );
}

/** Заметка к ключу: по клику — поле ввода, сохранение по Enter или кнопке. */
export function FailedKeywordNote({ id, note }: { id: string; note: string | null }) {
  const router = useRouter();
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(note ?? "");
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const save = () =>
    start(async () => {
      const r = await setFailedKeywordNote(id, text).catch(() => ({ error: "Сервер не ответил" }));
      if (r.error) setErr(r.error);
      else { setEdit(false); setErr(""); router.refresh(); }
    });
  if (!edit) {
    return (
      <button type="button" className="text-left text-[12.5px] text-muted hover:text-ink" onClick={() => setEdit(true)}>
        {note ? <span className="line-clamp-2 max-w-[220px]">{note}</span> : "+ заметка"}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <input className="input py-1 text-[13px] min-w-[160px]" value={text} autoFocus maxLength={1000} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") setEdit(false); }} />
      <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={save}>{pending ? "…" : "OK"}</button>
      {err && <span className="text-danger text-[12px]">{err}</span>}
    </div>
  );
}
