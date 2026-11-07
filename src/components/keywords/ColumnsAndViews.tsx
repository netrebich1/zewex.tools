"use client";
import { useState, useTransition } from "react";
import { deleteViewAction, saveViewAction, type ViewItem } from "@/actions/keywords";
import { DEFAULT_COLUMNS, FIELDS, GROUPS } from "@/lib/keywords/fields";
import { Hint, useQueryNav } from "./kwui";

/** Выпадающая панель (закрывается кликом мимо). */
function Pop({ open, onClose, children, wide }: { open: boolean; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  if (!open) return null;
  return (
    <>
      <button type="button" aria-label="Закрыть" className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      {/* на телефоне — во всю ширину экрана: от кнопки слева панель уходила за правый край */}
      <div className={`fixed inset-x-4 top-20 z-50 max-h-[75dvh] overflow-y-auto rounded-xl border border-line bg-surface p-4 shadow-[var(--shadow-pop)] sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-2 sm:max-h-[75vh] ${wide ? "sm:w-[min(760px,92vw)]" : "sm:w-[min(380px,92vw)]"}`}>{children}</div>
    </>
  );
}

/** Выбор колонок таблицы: галочки по группам, порядок — как в реестре. Сохраняется сразу (личная настройка). */
/** Меню «Выгрузка»: CSV со всеми метриками и CSV для запуска статей. */
export function ExportMenu({ qs }: { qs: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="btn-ghost btn-sm">Выгрузка CSV ▾</button>
      {open && (
        <>
          <button type="button" aria-label="Закрыть" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div className="fixed inset-x-4 top-20 z-50 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[300px] rounded-xl border border-line bg-surface p-2 shadow-[var(--shadow-pop)]">
            <a href={`/api/keywords/export?${qs}`} className="block rounded-lg px-3 py-2 text-[13.5px] hover:bg-surface-2"><b>Все метрики</b><span className="help block">текущая выборка, все колонки реестра</span></a>
            <a href={`/api/keywords/export?${qs}&format=articles`} className="block rounded-lg px-3 py-2 text-[13.5px] hover:bg-surface-2"><b>Для запуска статей</b><span className="help block">Keyword / SEO Keyword / Focus Keyword / Сценарий / Режим</span></a>
          </div>
        </>
      )}
    </div>
  );
}

export function ColumnPicker({ columns, onChange }: { columns: string[]; onChange: (cols: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const toggle = (k: string) => onChange(columns.includes(k) ? columns.filter((x) => x !== k) : FIELDS.map((f) => f.key).filter((x) => x === k || columns.includes(x)));
  const setGroup = (g: string, on: boolean) => {
    const keys = FIELDS.filter((f) => f.group === g).map((f) => f.key);
    onChange(FIELDS.map((f) => f.key).filter((x) => (keys.includes(x) ? on : columns.includes(x))));
  };
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="btn-ghost btn-sm">Колонки · {columns.length}</button>
      <Pop open={open} onClose={() => setOpen(false)} wide>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <b className="text-[14px]">Какие колонки показывать</b>
          <span className="help flex-1">Ключ и вердикт видны всегда. Сохраняется для вас на любом компьютере.</span>
          <button type="button" className="btn-ghost btn-sm" onClick={() => onChange(DEFAULT_COLUMNS)}>По умолчанию</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => onChange(FIELDS.map((f) => f.key))}>Все</button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {GROUPS.map((g) => {
            const fs = FIELDS.filter((f) => f.group === g.key);
            const all = fs.every((f) => columns.includes(f.key));
            return (
              <div key={g.key}>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[12px] font-bold uppercase tracking-wider text-muted">{g.label}</span>
                  <button type="button" className="text-[12px] font-semibold text-muted hover:text-ink" onClick={() => setGroup(g.key, !all)}>{all ? "снять все" : "все"}</button>
                </div>
                {fs.map((f) => (
                  <label key={f.key} className="flex cursor-pointer items-center gap-2 py-0.5 text-[13.5px]">
                    <input type="checkbox" checked={columns.includes(f.key)} onChange={() => toggle(f.key)} />
                    <span>{f.label}</span><Hint text={f.desc} />
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      </Pop>
    </div>
  );
}

/** Сохранённые виды: фильтры + сортировка (+ колонки). Свои и общие. */
export function ViewsMenu({ views: initial, columns, onColumns }: { views: ViewItem[]; columns: string[]; onColumns: (cols: string[]) => void }) {
  const { sp, replaceAll } = useQueryNav();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState(initial);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [withCols, setWithCols] = useState(true);
  const [err, setErr] = useState("");
  const [pending, start] = useTransition();
  const current = sp.toString().replace(/(^|&)pg=\d+/g, "").replace(/^&/, "");
  const save = () => start(async () => {
    setErr("");
    try {
      const v = await saveViewAction(name, current, withCols ? columns : null, shared);
      setViews((p) => [v, ...p.filter((x) => x.id !== v.id)]);
      setName("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  });
  const load = (v: ViewItem) => { if (v.columns) onColumns(v.columns); replaceAll(v.query); setOpen(false); };
  const del = (v: ViewItem) => { if (window.confirm(`Удалить вид «${v.name}»?`)) start(async () => { await deleteViewAction(v.id); setViews((p) => p.filter((x) => x.id !== v.id)); }); };
  const active = views.find((v) => v.query === current);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="btn-ghost btn-sm">{active ? `Вид: ${active.name}` : "Сохранённые виды"} ▾</button>
      <Pop open={open} onClose={() => setOpen(false)}>
        <b className="text-[14px]">Сохранённые виды</b>
        <p className="help mb-2">Вид запоминает фильтры, сортировку и (если отмечено) колонки.</p>
        <div className="mb-3 space-y-1">
          {views.map((v) => (
            <div key={v.id} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${active?.id === v.id ? "bg-brand-soft" : "hover:bg-surface-2"}`}>
              <button type="button" className="flex-1 truncate text-left text-[13.5px] font-semibold" onClick={() => load(v)} title={v.query || "без фильтров"}>{v.name}</button>
              {v.shared && <span className="badge bg-ink/5 text-muted">общий</span>}
              {v.columns && <span className="help">+ колонки</span>}
              {v.mine && <button type="button" className="text-muted hover:text-danger" onClick={() => del(v)} aria-label="Удалить">×</button>}
            </div>
          ))}
          {!views.length && <p className="help">Пока нет. Настройте фильтры и сохраните их ниже.</p>}
        </div>
        <div className="space-y-2 border-t border-line pt-3">
          <input className="input !py-1.5" placeholder="Название: изи ногти без видео" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={withCols} onChange={(e) => setWithCols(e.target.checked)} /> запомнить и колонки</label>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> общий — видят все, кому открыт инструмент</label>
          {err && <p className="text-[13px] text-danger">{err}</p>}
          <button type="button" disabled={pending || !name.trim()} onClick={save} className="btn-brand btn-sm w-full">Сохранить текущие фильтры</button>
        </div>
      </Pop>
    </div>
  );
}
