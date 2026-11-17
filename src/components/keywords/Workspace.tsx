"use client";
import Link from "next/link";
import { useCallback, useState, useTransition } from "react";
import { savePrefsAction, type ViewItem } from "@/actions/keywords";
import { SearchBox } from "@/components/analytics/SearchBox";
import { buildChips } from "@/lib/keywords/chips";
import type { TableRow } from "@/lib/keywords/query";
import { MIN_VOLUME, NICHES, VERDICTS } from "@/lib/keywords/types";
import { ColumnPicker, ViewsMenu } from "./ColumnsAndViews";
import { DataTable } from "./DataTable";
import { FILTER_KEYS, FilterPanel } from "./FilterPanel";
import { KeywordDrawer } from "./KeywordDrawer";
import { Chip, fmt, useQueryNav } from "./kwui";

type Opt = { value: string; label: string };

/** Быстрые наборы: одна кнопка — один фильтр в адресе. */
const PRESETS: Array<{ label: string; patch: Record<string, string>; title: string }> = [
  { label: "Новый блог ≥ 60", patch: { entryNew_min: "60" }, title: "Выдача пускает молодой блог" },
  { label: "Старый блог ≥ 60", patch: { entryOld_min: "60" }, title: "Шанс для старого блога" },
  { label: "Реклама+товары ≤ 10%", patch: { com_max: "10" }, title: "Почти без коммерции на первом экране" },
  { label: "Видео ≤ 30%", patch: { video_max: "30" }, title: "Исключить видео-выдачи" },
  { label: "Блоги ≥ 50%", patch: { blogs_min: "50" }, title: "Среди ссылок топа хотя бы половина — блоги" },
  { label: "Свежий пин в топ-3", patch: { flag: "fresh_top" }, title: "Новичка пускают наверх: на местах 1–3 есть пин моложе 3 месяцев" },
  { label: "Сменился вердикт", patch: { changed: "1" }, title: "Вердикт изменился с прошлого снимка" },
];

/** Плашки активных фильтров: у каждой крестик и подсказка, сколько ключей станет без неё; невозможное значение — красным. */
function ActiveChips({ accounts, relax, total }: { accounts: Opt[]; relax: Record<string, number>; total: number }) {
  const { sp, apply } = useQueryNav();
  const chips = buildChips((k) => sp.get(k), new Map(accounts.map((a) => [a.value, a.label])));
  const defaults = [];
  if (sp.get("volume_min") == null) defaults.push(`частотность ≥ ${MIN_VOLUME.toLocaleString("ru-RU")}`);
  if (!sp.get("season")) defaults.push("без сезонных");
  if (!chips.length) return <p className="help">По умолчанию: {defaults.join(", ")}. Остальные фильтры — кнопка «Фильтры».</p>;
  const clear = () => { const p: Record<string, null> = {}; for (const k of FILTER_KEYS) p[k] = null; apply(p); };
  // Какой фильтр сильнее всего сужает выборку: без него ключей больше всего.
  const worst = chips.reduce<{ id: string; n: number } | null>((m, c) => (relax[c.id] != null && relax[c.id] > total && (!m || relax[c.id] > m.n) ? { id: c.id, n: relax[c.id] } : m), null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((c) => {
          const n = relax[c.id];
          const bad = !!c.warn;
          return (
            <span key={c.id} title={c.warn ?? (n != null ? `Без этого фильтра: ${n.toLocaleString("ru-RU")} ключей` : undefined)}
              className={`inline-flex items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-[12.5px] font-semibold ${bad ? "border-danger bg-danger-soft text-danger" : worst?.id === c.id && total < 20 ? "border-warn bg-warn-soft text-ink" : "border-ink/20 bg-ink/5"}`}>
              {bad && <span aria-hidden>⚠</span>}{c.label}
              {n != null && n !== total && <span className="font-normal text-muted">· без него {fmt(n)}</span>}
              <button type="button" onClick={() => apply(c.patch)} className="relative flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-ink/10 hover:text-ink after:absolute after:-inset-2 after:content-['']" aria-label="Снять фильтр">×</button>
            </span>
          );
        })}
        <button type="button" onClick={clear} className="ml-1 text-[12.5px] font-semibold text-muted hover:text-ink">Сбросить всё</button>
        {defaults.length > 0 && <span className="help">· по умолчанию {defaults.join(", ")}</span>}
      </div>
      {chips.filter((c) => c.warn).map((c) => <p key={c.id} className="text-[13px] text-danger">⚠ {c.warn}</p>)}
      {total < 20 && worst && !chips.some((c) => c.warn) && (
        <p className="text-[13px] text-ink-2">Сильнее всего сужает выборку «{chips.find((c) => c.id === worst.id)?.label}»: без него будет {fmt(worst.n)} {worst.n === 1 ? "ключ" : "ключей"}.</p>
      )}
    </div>
  );
}

/** Рабочая область экрана «Ключи»/«Новые». */
export function Workspace({ rows, total, page, perPage, columns: initialCols, views, accounts, relax }: {
  rows: TableRow[]; total: number; page: number; perPage: number; columns: string[]; views: ViewItem[]; accounts: Opt[]; relax: Record<string, number>;
}) {
  const { sp, apply, pending } = useQueryNav();
  const [cols, setCols] = useState(initialCols);
  const [filters, setFilters] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [, startSave] = useTransition();
  const changeCols = useCallback((c: string[]) => { setCols(c); startSave(() => savePrefsAction(c)); }, []);
  const changePer = (n: number) => { startSave(() => savePrefsAction(cols, n)); apply({ pp: String(n) }); };
  const verdicts = (sp.get("verdict") ?? "").split(",").filter(Boolean);
  const niches = (sp.get("niche") ?? "").split(",").filter(Boolean);
  const toggleList = (k: string, cur: string[], v: string) => apply({ [k]: (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]).join(",") || null });
  const presetOn = (p: Record<string, string>) => sp.get("fu") !== "cnt" && Object.entries(p).every(([k, v]) => sp.get(k) === v);
  // Быстрые наборы заданы в процентах: включение набора возвращает фильтры в режим «в процентах».
  const togglePreset = (p: Record<string, string>) => apply({ ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, presetOn(p) ? null : v])), ...(presetOn(p) ? {} : { fu: null }) });
  const nRange = FILTER_KEYS.filter((k) => k !== "fu" && sp.get(k) != null).length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const pageHref = (p: number) => { const q = new URLSearchParams(sp.toString()); p > 1 ? q.set("pg", String(p)) : q.delete("pg"); return `?${q}`; };
  return (
    <div className={pending ? "opacity-80 transition" : "transition"}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox placeholder="Ключ содержит…" className="w-full sm:w-64" />
        <button type="button" onClick={() => setFilters(true)} className="btn-brand btn-sm">Фильтры{nRange ? ` · ${nRange}` : ""}{sp.get("fu") === "cnt" ? " · в штуках" : ""}</button>
        <ViewsMenu views={views} columns={cols} onColumns={changeCols} />
        <ColumnPicker columns={cols} onChange={changeCols} />
        <span className="ml-auto text-[13px] text-muted">Найдено <b className="text-ink">{fmt(total)}</b></span>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {VERDICTS.map((v) => <Chip key={v.key} on={verdicts.includes(v.key)} onClick={() => toggleList("verdict", verdicts, v.key)}>{v.label}</Chip>)}
        <span className="mx-1 h-5 w-px bg-line" />
        {NICHES.map((x) => <Chip key={x.key} on={niches.includes(x.key)} onClick={() => toggleList("niche", niches, x.key)}>{x.label}</Chip>)}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => <Chip key={p.label} title={p.title} on={presetOn(p.patch)} onClick={() => togglePreset(p.patch)}>{p.label}</Chip>)}
        {/* на телефоне title не увидеть — пояснение включённых наборов текстом */}
        {PRESETS.some((p) => p.title && presetOn(p.patch)) && <p className="help w-full sm:hidden">{PRESETS.filter((p) => p.title && presetOn(p.patch)).map((p) => `${p.label}: ${p.title}`).join(" · ")}</p>}
      </div>
      <div className="mb-3"><ActiveChips accounts={accounts} relax={relax} total={total} /></div>
      <DataTable rows={rows} columns={cols} selected={open} onOpen={setOpen} />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[13px]">
        <span className="help">Показано {fmt(Math.min(total, (page - 1) * perPage + 1))}–{fmt(Math.min(total, page * perPage))} из {fmt(total)}</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="help hidden sm:inline">На странице</span>
          <select className="input !w-auto !py-1 sm:!text-[13px]" aria-label="На странице" value={perPage} onChange={(e) => changePer(Number(e.target.value))}>
            {[25, 50, 100, 200].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          {page > 1 && <Link href={pageHref(page - 1)} scroll={false} className="btn-ghost btn-sm">← Назад</Link>}
          <span className="help">{page} / {pages}</span>
          {page < pages && <Link href={pageHref(page + 1)} scroll={false} className="btn-ghost btn-sm">Дальше →</Link>}
        </div>
      </div>
      <FilterPanel open={filters} onClose={() => setFilters(false)} accounts={accounts} />
      <KeywordDrawer id={open} onClose={() => setOpen(null)} />
    </div>
  );
}
