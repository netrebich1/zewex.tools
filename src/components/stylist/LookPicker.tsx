"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addToLook } from "@/actions/stylist";

export type PickerLook = { id: string; name: string; collection: string };

/**
 * Кнопка карточки каталога: «В образ» кладёт вещь в собираемый образ, список рядом — в любой другой
 * (сгруппирован по коллекциям) или в новый. Одна вещь может лежать в нескольких образах: уже выбранные отмечены ✓.
 */
export function LookPicker({ itemId, looks, activeId, inLooks }: { itemId: string; looks: PickerLook[]; activeId: string | null; inLooks: string[] }) {
  const [pending, start] = useTransition();
  const [added, setAdded] = useState<string[]>(inLooks);
  const [error, setError] = useState("");
  const router = useRouter();
  const active = looks.find((l) => l.id === activeId) ?? null;
  const groups = [...new Set(looks.map((l) => l.collection))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));

  const add = (look: string) => start(async () => {
    setError("");
    const r = await addToLook(itemId, look === "new" ? { fresh: true } : look ? { look } : {});
    if (r.error) setError(r.error);
    else {
      if (r.lookId) setAdded((a) => [...new Set([...a, r.lookId!])]);
      router.refresh();
    }
  });

  const inActive = !!active && added.includes(active.id);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
        {inActive ? (
          <span className="flex-1 truncate rounded-lg bg-ok-soft px-2 py-1.5 text-center text-[12px] font-medium text-ok" title={active!.name}>✓ {active!.name}</span>
        ) : (
          <button type="button" disabled={pending} className="btn-primary btn-sm min-w-0 flex-1 truncate" onClick={() => add("")} title={active ? `Положить в образ «${active.name}»` : "Создать новый образ с этой вещью"}>
            {pending ? "…" : active ? `В «${active.name}»` : "В новый образ"}
          </button>
        )}
        <select
          aria-label="Положить в другой образ"
          title="Положить в другой образ"
          disabled={pending}
          value=""
          onChange={(e) => { if (e.target.value) add(e.target.value); }}
          className="input !w-[44px] shrink-0 !px-1 text-[13px]"
        >
          <option value="">⋯</option>
          <option value="new">＋ Новый образ</option>
          {groups.map((g) => (
            <optgroup key={g || "-"} label={g || "Без коллекции"}>
              {looks.filter((l) => l.collection === g).map((l) => <option key={l.id} value={l.id}>{added.includes(l.id) ? "✓ " : ""}{l.name}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      {added.length > 0 && !inActive && <span className="text-[11px] text-ok">уже в образах: {added.length}</span>}
      {added.length > 1 && inActive && <span className="text-[11px] text-muted">всего в образах: {added.length}</span>}
      {error && <span className="text-[12px] text-danger">{error}</span>}
    </div>
  );
}
