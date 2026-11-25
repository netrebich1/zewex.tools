"use client";
import { useState } from "react";
import type { RunDomainRow } from "@/lib/domains/runs";
import { itemKey, type DomainRunSettings } from "@/lib/domains/types";

type Toggle = (id: string, selected: boolean) => void;

/** Снятие выбора с памятью: убранный домен остаётся зачёркнутым, пока открыт список, чтобы промах можно было вернуть. */
function useRemovable(onToggle: Toggle) {
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  function setRowsSelected(rows: RunDomainRow[], selected: boolean) {
    for (const d of rows) if (d.selected !== selected) onToggle(d.id, selected);
    setRemoved((prev) => {
      const next = new Set(prev);
      for (const d of rows) {
        if (selected) next.delete(d.id);
        else next.add(d.id);
      }
      return next;
    });
  }
  const pick = (rows: RunDomainRow[]) => rows.filter((d) => d.selected || removed.has(d.id)).sort((a, b) => a.domain.localeCompare(b.domain));
  return { pick, setRowsSelected };
}

function SelectedRows({ rows, setRowsSelected, className = "" }: { rows: RunDomainRow[]; setRowsSelected: (rows: RunDomainRow[], selected: boolean) => void; className?: string }) {
  return (
    <ul className={`divide-y divide-line ${className}`}>
      {rows.map((d) => (
        <li key={d.id} className="flex items-center gap-2 pl-3 pr-1 text-[13.5px]" title={d.aiReason ?? undefined}>
          <span className={`min-w-0 flex-1 truncate font-mono ${d.selected ? "" : "text-muted line-through"}`}>{d.domain}</span>
          {d.selected ? (
            <button type="button" className="shrink-0 px-2.5 py-1.5 text-muted hover:text-danger" aria-label={`Убрать ${d.domain}`} title="Убрать из выбранных" onClick={() => setRowsSelected([d], false)}>✕</button>
          ) : (
            <button type="button" className="shrink-0 px-2.5 py-1.5 text-[12.5px] text-brand hover:underline" onClick={() => setRowsSelected([d], true)}>Вернуть</button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Выбранные домены одного бренда внутри его карточки. */
export function BrandSelected({ rows, onToggle }: { rows: RunDomainRow[]; onToggle: Toggle }) {
  const { pick, setRowsSelected } = useRemovable(onToggle);
  const shown = pick(rows);
  const active = shown.filter((d) => d.selected);
  if (!shown.length) return <p className="help px-3 py-3">У этого бренда ничего не выбрано</p>;
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-line">
        <span className="text-[12.5px] font-semibold">Выбрано: {active.length}</span>
        {active.length > 0 && <button type="button" className="btn-ghost btn-sm !px-2 !py-0.5 text-[12px]" onClick={() => setRowsSelected(active, false)}>Убрать все</button>}
      </div>
      <SelectedRows rows={shown} setRowsSelected={setRowsSelected} className="max-h-96 overflow-auto" />
    </>
  );
}

type Props = {
  items: DomainRunSettings["items"];
  byBrand: Map<string, RunDomainRow[]>;
  labelOf: (it: { brand: string; country: string }) => string;
  query: string;
  onToggle: Toggle;
};

/** Вкладка «Выбранные»: все отмеченные домены по брендам, без фильтров карточек. */
export function SelectedDomains({ items, byBrand, labelOf, query, onToggle }: Props) {
  const { pick, setRowsSelected } = useRemovable(onToggle);

  const groups = items.flatMap((item) => {
    const brandMatches = !query || item.brand.toLowerCase().includes(query);
    const rows = pick(byBrand.get(itemKey(item.brand, item.country)) ?? []).filter((d) => brandMatches || d.domain.includes(query));
    return rows.length ? [{ key: itemKey(item.brand, item.country), label: labelOf(item), rows }] : [];
  });

  if (!groups.length) {
    return <div className="card px-4 py-6 text-center help">{query ? "По этому поиску среди выбранных ничего нет" : "Пока ничего не выбрано. Отметьте домены во вкладке «Свободные»."}</div>;
  }

  return (
    <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
      {groups.map(({ key, label, rows }) => {
        const active = rows.filter((d) => d.selected);
        return (
          <section key={key} className="card min-w-0">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line">
              <h3 className="min-w-0 flex-1 truncate font-semibold text-[15px]" title={label}>{label}</h3>
              <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-brand" title="Выбрано у бренда">{active.length}</span>
              {active.length > 0 && <button type="button" className="btn-ghost btn-sm !px-2 !py-0.5 text-[12px]" onClick={() => setRowsSelected(active, false)}>Убрать все</button>}
            </div>
            <SelectedRows rows={rows} setRowsSelected={setRowsSelected} />
          </section>
        );
      })}
    </div>
  );
}
