"use client";
import { useMemo } from "react";
import type { RunDomainRow } from "@/lib/domains/runs";
import { PATTERN_LABELS, SUFFIX_SOURCE_TAGS, TLD_SOURCE_TAGS, type CandidatePattern, type SuffixSource, type SuffixSourceKind, type TldSource } from "@/lib/domains/types";
import { SourceTag } from "./RunAnalysis";

/** Фильтр доменов бренда: источник приставки, уровень, зона и вид (список / по зонам / по приставкам / зона × приставка). */
export type DomainFilter = { src: "all" | "none" | SuffixSourceKind; tier: "all" | "0" | "1" | "2" | "3" | "4"; zone: string; mode: "list" | "zones" | "suffixes" | "matrix"; /** Только рекомендованные */ recOnly?: boolean };

export const DEFAULT_FILTER: DomainFilter = { src: "all", tier: "all", zone: "all", mode: "list" };

export const SRC_OPTIONS: Array<[DomainFilter["src"], string]> = [["all", "Все"], ["geo", "Гео"], ["brand", "Ключи"], ["common", "Мои приставки"], ["pool", "Запас"], ["none", "Без приставки"]];
export const TIER_OPTIONS: Array<[DomainFilter["tier"], string]> = [["all", "Все уровни"], ["0", "Бренд"], ["1", "Тир 1"], ["2", "Тир 2"], ["3", "Тир 3"], ["4", "Тир 4–6"]];
export const MODE_OPTIONS: Array<[DomainFilter["mode"], string]> = [["list", "Список"], ["zones", "По зонам"], ["suffixes", "По приставкам"], ["matrix", "Зона × приставка"]];

const STATUS_DOT: Record<string, string> = { taken: "bg-danger", unknown: "bg-line-2" };
const STATUS_LABEL: Record<string, string> = { available: "свободен", taken: "занят", unknown: "не проверен" };

type Props = {
  rows: RunDomainRow[];
  sources: Map<string, SuffixSource> | undefined;
  zoneSources: Map<string, TldSource> | undefined;
  filter: DomainFilter;
  setFilter: (f: DomainFilter) => void;
  onToggle: (id: string, selected: boolean) => void;
  /** Рекомендованные к покупке под текущий фильтр: id → почему */
  rec: Map<string, string>;
};

export const kindOf = (d: RunDomainRow, sources: Props["sources"]): DomainFilter["src"] => (d.suffix ? sources?.get(d.suffix)?.kind ?? "common" : "none");
const tierOf = (d: RunDomainRow): DomainFilter["tier"] => (d.tier >= 4 ? "4" : (String(d.tier) as DomainFilter["tier"]));

/** Домены одного бренда с вкладками: источник, уровень, зона и вид. */
export function BrandDomains({ rows, sources, zoneSources, filter, setFilter, onToggle, rec }: Props) {
  const zones = useMemo(() => Array.from(new Set(rows.map((d) => d.tld))), [rows]);
  const pass = (d: RunDomainRow, skip?: "src" | "tier" | "zone") =>
    (skip === "src" || filter.src === "all" || kindOf(d, sources) === filter.src) &&
    (skip === "tier" || filter.tier === "all" || tierOf(d) === filter.tier) &&
    (skip === "zone" || filter.zone === "all" || d.tld === filter.zone);
  const visible = rows.filter((d) => pass(d) && (!filter.recOnly || rec.has(d.id)));
  const count = (skip: "src" | "tier" | "zone", test: (d: RunDomainRow) => boolean) => rows.filter((d) => pass(d, skip) && test(d)).length;
  const set = (patch: Partial<DomainFilter>) => setFilter({ ...filter, ...patch });

  const Chip = ({ active, label, n, onClick, title }: { active: boolean; label: string; n: number; onClick: () => void; title?: string }) => (
    <button type="button" title={title} disabled={!n && !active} onClick={onClick} className={`rounded-md px-1.5 py-0.5 text-[11.5px] whitespace-nowrap ${active ? "bg-ink text-bg" : n ? "bg-ink/5 hover:bg-ink/10" : "bg-ink/5 opacity-40"}`}>
      {label} <span className="opacity-70">{n}</span>
    </button>
  );

  const Line = ({ d }: { d: RunDomainRow }) => (
    <li className={`flex items-center gap-2 px-3 py-1.5 text-[13.5px] ${d.selected ? "bg-brand-soft/40" : ""}`} title={[PATTERN_LABELS[d.pattern as CandidatePattern] ?? d.pattern, d.status === "available" && d.source === "dns" ? "свободен по DNS: у зоны нет RDAP, перед покупкой проверьте у регистратора" : "", d.aiReason].filter(Boolean).join(" · ")}>
      {d.status === "available" ? (
        <input type="checkbox" className="h-4 w-4 shrink-0" checked={d.selected} onChange={(e) => onToggle(d.id, e.target.checked)} />
      ) : (
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[d.status] ?? "bg-line-2"}`} title={STATUS_LABEL[d.status]} />
      )}
      <span className="font-mono min-w-0 flex-1 truncate">{d.domain}</span>
      {rec.has(d.id) && <span className="shrink-0 text-[12px] text-warn" title={`Рекомендован к покупке: ${rec.get(d.id)}`}>★</span>}
      {d.pattern === "brand-letter" && <span className="shrink-0 rounded-md bg-warn-soft px-1.5 text-[11px] text-warn" title="бренд + буква: риск жалобы владельца бренда (UDRP)">буква</span>}
      {d.tier > 0 && d.suffix && <SourceTag source={sources?.get(d.suffix)} suffix={d.suffix} />}
      {d.aiScore != null && <span className="shrink-0 rounded-md bg-ok-soft px-1.5 text-[11px] font-semibold text-ok" title={d.aiReason ?? "оценка ИИ"}>{d.aiScore}</span>}
    </li>
  );

  const groups = (key: (d: RunDomainRow) => string) => {
    const m = new Map<string, RunDomainRow[]>();
    for (const d of visible) m.set(key(d), [...(m.get(key(d)) ?? []), d]);
    return Array.from(m.entries());
  };

  return (
    <div className="flex flex-col min-h-0">
      <div className="space-y-1.5 border-b border-line px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {SRC_OPTIONS.map(([v, label]) => <Chip key={v} active={filter.src === v} label={label} n={v === "all" ? count("src", () => true) : count("src", (d) => kindOf(d, sources) === v)} onClick={() => set({ src: v })} />)}
        </div>
        <div className="flex flex-wrap gap-1">
          {TIER_OPTIONS.map(([v, label]) => <Chip key={v} active={filter.tier === v} label={label} n={v === "all" ? count("tier", () => true) : count("tier", (d) => tierOf(d) === v)} onClick={() => set({ tier: v })} />)}
        </div>
        <div className="flex flex-wrap gap-1">
          <Chip active={filter.zone === "all"} label="Все зоны" n={count("zone", () => true)} onClick={() => set({ zone: "all" })} />
          {zones.map((z) => {
            const s = zoneSources?.get(z);
            return <Chip key={z} active={filter.zone === z} label={`.${z}`} n={count("zone", (d) => d.tld === z)} onClick={() => set({ zone: z })} title={s ? `${TLD_SOURCE_TAGS[s.kind]}: ${s.detail}` : undefined} />;
          })}
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" onClick={() => set({ recOnly: !filter.recOnly })} title="Набор для покупки под текущий фильтр: разные зоны, типы приставок, приставки, с дефисом и без" className={`tab !px-2 !py-0.5 text-[12px] ${filter.recOnly ? "active" : ""}`}>★ Рекомендованные {rec.size}</button>
          {MODE_OPTIONS.map(([v, label]) => (
            <button key={v} type="button" onClick={() => set({ mode: v })} className={`tab !px-2 !py-0.5 text-[12px] ${filter.mode === v ? "active" : ""}`}>{label}</button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="help px-3 py-2">Нет доменов под фильтр</p>
      ) : filter.mode === "list" ? (
        <ul className="max-h-96 overflow-auto divide-y divide-line/70">{visible.map((d) => <Line key={d.id} d={d} />)}</ul>
      ) : filter.mode === "matrix" ? (
        <Matrix rows={visible} sources={sources} onToggle={onToggle} />
      ) : (
        <div className="max-h-96 overflow-auto">
          {groups((d) => (filter.mode === "zones" ? d.tld : d.suffix ?? "")).map(([g, list]) => {
            const src = filter.mode === "suffixes" && g ? sources?.get(g) : undefined;
            const zs = filter.mode === "zones" ? zoneSources?.get(g) : undefined;
            return (
              <div key={g || "—"}>
                <div className="sticky top-0 z-[1] flex items-center gap-2 bg-surface px-3 py-1 text-[12px] font-semibold border-b border-line">
                  <span className="font-mono">{filter.mode === "zones" ? `.${g}` : g || "без приставки"}</span>
                  {src && <SourceTag source={src} suffix={g} />}
                  {zs && <span className="help font-normal" title={zs.detail}>{TLD_SOURCE_TAGS[zs.kind]}</span>}
                  <span className="help ml-auto font-normal">свободно {list.filter((d) => d.status === "available").length} из {list.length}</span>
                </div>
                <ul className="divide-y divide-line/70">{list.map((d) => <Line key={d.id} d={d} />)}</ul>
              </div>
            );
          })}
        </div>
      )}
      <div className="help border-t border-line px-3 py-1">
        {SUFFIX_SOURCE_TAGS.geo}, {SUFFIX_SOURCE_TAGS.brand}, {SUFFIX_SOURCE_TAGS.common}, {SUFFIX_SOURCE_TAGS.pool} — откуда приставка; цифра — уровень. Показано {visible.length}, свободно {visible.filter((d) => d.status === "available").length}.
      </div>
    </div>
  );
}

/** Таблица «приставка × зона»: свободный — галочка, занят — красная точка, не проверен — серая. */
function Matrix({ rows, sources, onToggle }: { rows: RunDomainRow[]; sources: Props["sources"]; onToggle: Props["onToggle"] }) {
  const zones = Array.from(new Set(rows.map((d) => d.tld)));
  const labels = new Map<string, Map<string, RunDomainRow>>();
  for (const d of rows) {
    // Строка таблицы — метка без зоны (бренд-приставка, бренд+приставка и т.п.)
    const label = d.domain.slice(0, d.domain.length - d.tld.length - 1);
    if (!labels.has(label)) labels.set(label, new Map());
    labels.get(label)!.set(d.tld, d);
  }
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 z-[1] bg-surface">
          <tr className="border-b border-line">
            <th className="px-3 py-1 text-left font-semibold">Метка</th>
            {zones.map((z) => <th key={z} className="px-1.5 py-1 text-center font-mono font-semibold">.{z}</th>)}
          </tr>
        </thead>
        <tbody>
          {Array.from(labels.entries()).map(([label, cells]) => {
            const any = cells.values().next().value as RunDomainRow;
            return (
              <tr key={label} className="border-b border-line/60">
                <td className="max-w-0 px-3 py-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono" title={label}>{label}</span>
                    {any.suffix && <SourceTag source={sources?.get(any.suffix)} suffix={any.suffix} />}
                  </div>
                </td>
                {zones.map((z) => {
                  const d = cells.get(z);
                  return (
                    <td key={z} className="px-1.5 py-1 text-center" title={d ? `${d.domain} — ${STATUS_LABEL[d.status] ?? d.status}` : "не генерировался"}>
                      {!d ? <span className="text-muted">·</span> : d.status === "available" ? (
                        <input type="checkbox" className="h-4 w-4 align-middle" checked={d.selected} onChange={(e) => onToggle(d.id, e.target.checked)} />
                      ) : (
                        <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[d.status] ?? "bg-line-2"}`} />
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Отфильтрованные домены бренда — для кнопок «выбрать видимые». */
export function filterRows(rows: RunDomainRow[], sources: Props["sources"], f: DomainFilter): RunDomainRow[] {
  return rows.filter((d) => (f.src === "all" || kindOf(d, sources) === f.src) && (f.tier === "all" || tierOf(d) === f.tier) && (f.zone === "all" || d.tld === f.zone));
}
