"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addToLook, removeFromLook } from "@/actions/stylist";

export type PickerLook = { id: string; name: string; collectionId: string; collection: string };
export type PickerCollection = { id: string; name: string };

/**
 * Кнопка карточки каталога «В образ»: открывает окно, где видно все коллекции и образы.
 * Нажатие на образ кладёт вещь в него или убирает из него (одна вещь может быть в нескольких образах);
 * внизу — новый образ с названием, в существующей или новой коллекции.
 */
export function LookPicker({ itemId, itemName, looks, collections, activeId, inLooks }: {
  itemId: string; itemName: string; looks: PickerLook[]; collections: PickerCollection[]; activeId: string | null; inLooks: string[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [added, setAdded] = useState<string[]>(inLooks);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [col, setCol] = useState("");
  const [colName, setColName] = useState("");
  const router = useRouter();

  useEffect(() => setAdded(inLooks), [inLooks]);
  useEffect(() => {
    if (!open) return;
    // По умолчанию новый образ идёт в коллекцию собираемого образа и получает следующий номер.
    const activeCol = looks.find((l) => l.id === activeId)?.collectionId ?? "";
    setCol(activeCol);
    setName(`Образ ${looks.filter((l) => l.collectionId === activeCol).length + 1}`);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, looks, activeId]);

  const toggle = (lookId: string) => start(async () => {
    setError("");
    const has = added.includes(lookId);
    const r = has ? await removeFromLook(itemId, lookId) : await addToLook(itemId, { look: lookId });
    if (r.error) return setError(r.error);
    setAdded((a) => (has ? a.filter((x) => x !== lookId) : [...a, lookId]));
    router.refresh();
  });

  const create = () => start(async () => {
    setError("");
    if (!name.trim()) return setError("Дайте образу название");
    if (col === "new" && !colName.trim()) return setError("Дайте коллекции название");
    const r = await addToLook(itemId, { fresh: { name: name.trim(), collectionId: col && col !== "new" ? col : undefined, newCollection: col === "new" ? colName.trim() : undefined } });
    if (r.error) return setError(r.error);
    if (r.lookId) setAdded((a) => [...a, r.lookId!]);
    setOpen(false);
    router.refresh();
  });

  const groups = [...collections.map((c) => ({ id: c.id, name: c.name })), { id: "", name: "Без коллекции" }].filter((g) => looks.some((l) => l.collectionId === g.id));

  return (
    <>
      <button type="button" className={`btn-sm w-full ${added.length ? "btn-ghost" : "btn-primary"}`} onClick={() => setOpen(true)}>
        {added.length ? `✓ В образах: ${added.length}` : "＋ В образ"}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => setOpen(false)}>
          <div className="flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-xl sm:max-w-[460px] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold">В какой образ положить</div>
                <div className="truncate text-[12px] text-muted">{itemName}</div>
              </div>
              <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setOpen(false)}>Готово</button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {groups.length === 0 && <p className="help">Образов пока нет — создайте первый ниже.</p>}
              {groups.map((g) => (
                <div key={g.id || "-"} className="mb-3">
                  <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-muted">{g.name}</div>
                  <div className="flex flex-col gap-1">
                    {looks.filter((l) => l.collectionId === g.id).map((l) => {
                      const has = added.includes(l.id);
                      return (
                        <button key={l.id} type="button" disabled={pending} onClick={() => toggle(l.id)} className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-[14px] transition ${has ? "border-ok bg-ok-soft" : "border-line hover:border-line-2"}`}>
                          <span className="min-w-0 truncate">{l.name}{l.id === activeId ? <span className="ml-1.5 text-[11px] text-muted">собирается</span> : null}</span>
                          <span className={`shrink-0 text-[12px] font-medium ${has ? "text-ok" : "text-muted"}`}>{has ? "✓ лежит · убрать" : "положить"}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-line bg-surface-2/60 px-4 py-3">
              <div className="mb-2 text-[13px] font-semibold">Новый образ</div>
              <div className="flex flex-col gap-2">
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Название образа" className="input" />
                <select value={col} onChange={(e) => setCol(e.target.value)} className="input">
                  <option value="">Без коллекции</option>
                  {collections.map((c) => <option key={c.id} value={c.id}>Коллекция: {c.name}</option>)}
                  <option value="new">＋ Новая коллекция…</option>
                </select>
                {col === "new" && <input value={colName} onChange={(e) => setColName(e.target.value)} maxLength={200} placeholder="Название коллекции" className="input" />}
                <button type="button" disabled={pending} className="btn-primary btn-sm" onClick={create}>{pending ? "…" : "Создать образ и положить вещь"}</button>
              </div>
              {error && <div className="mt-2 text-[13px] text-danger">{error}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
