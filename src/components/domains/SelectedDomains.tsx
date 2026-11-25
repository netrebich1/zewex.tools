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

/** Чем заменить домен: свободные невыбранные из той же группы — тот же ключ/приставка, затем та же группа и шаблон. */
function alternativesFor(d: RunDomainRow, rows: RunDomainRow[]): RunDomainRow[] {
  const free = rows.filter((x) => x.status === "available" && !x.selected && x.id !== d.id);
  const same = free.filter((x) => (x.suffix ?? "") === (d.suffix ?? ""));
  const near = free.filter((x) => (x.suffix ?? "") !== (d.suffix ?? "") && x.tier === d.tier && x.pattern === d.pattern);
  return [...same, ...near].sort((a, b) => a.sortOrder - b.sortOrder).slice(0, 12);
}

/** Выбранные домены одного бренда (кластера) внутри его карточки: убрать, вернуть или заменить на другой свободный. */
export function BrandSelected({ rows, onToggle }: { rows: RunDomainRow[]; onToggle: Toggle }) {
  const { pick, setRowsSelected } = useRemovable(onToggle);
  const [swap, setSwap] = useState<string | null>(null);
  const shown = pick(rows);
  const active = shown.filter((d) => d.selected);
  if (!shown.length) return <p className="help px-3 py-3">В этой пачке ничего не выбрано — отметь домены в других вкладках</p>;
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-line">
        <span className="text-[12.5px] font-semibold">Выбрано в этой пачке: {active.length}</span>
        {active.length > 0 && <button type="button" className="btn-ghost btn-sm !px-2 !py-0.5 text-[12px]" onClick={() => setRowsSelected(active, false)}>Убрать все</button>}
      </div>
      <ul className="divide-y divide-line max-h-[30rem] overflow-auto">
        {shown.map((d) => {
          const alts = swap === d.id ? alternativesFor(d, rows) : [];
          return (
            <li key={d.id} className="text-[13.5px]" title={d.aiReason ?? undefined}>
              <div className="flex items-center gap-2 pl-3 pr-1">
                <span className={`min-w-0 flex-1 truncate font-mono ${d.selected ? "" : "text-muted line-through"}`}>{d.domain}</span>
                {d.suffix && <span className="hidden sm:inline shrink-0 max-w-[40%] truncate text-[11px] text-muted" title={d.suffix}>{d.suffix}</span>}
                {d.selected ? (
                  <>
                    <button type="button" className="shrink-0 px-2 py-1.5 text-[12.5px] text-brand hover:underline" onClick={() => setSwap(swap === d.id ? null : d.id)}>{swap === d.id ? "Закрыть" : "Заменить"}</button>
                    <button type="button" className="shrink-0 px-2.5 py-1.5 text-muted hover:text-danger" aria-label={`Убрать ${d.domain}`} title="Убрать из выбранных" onClick={() => setRowsSelected([d], false)}>✕</button>
                  </>
                ) : (
                  <button type="button" className="shrink-0 px-2.5 py-1.5 text-[12.5px] text-brand hover:underline" onClick={() => setRowsSelected([d], true)}>Вернуть</button>
                )}
              </div>
              {swap === d.id && (
                <div className="flex flex-wrap gap-1 bg-ink/[0.03] px-3 py-2">
                  {alts.length ? alts.map((a) => (
                    <button key={a.id} type="button" className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[12px] hover:border-brand hover:text-brand" title={a.suffix ?? undefined}
                      onClick={() => { setRowsSelected([d], false); setRowsSelected([a], true); setSwap(null); }}>{a.domain}</button>
                  )) : <span className="help">Свободных из той же группы нет — выбери в других вкладках</span>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
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
