"use client";
import { useMemo, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, Field } from "@/components/ui";
import { saveAiSet, saveStyleNote, toggleStyleHidden } from "@/actions/pins";

type StyleRow = { id: string; name: string; category: string; concept: string; examples: string[]; hidden: boolean; note: string };
type SetRow = { id: string; name: string; topic: string; styleIds: string[] };

/** Галерея ИИ-стилей: примеры, скрытие для сайта, заметка к стилю, выбор в набор. */
export function AiStylePicker({ siteId, teamId, styles, categories, sets }: { siteId: string; teamId: string; styles: StyleRow[]; categories: Array<{ id: string; label: string }>; sets: SetRow[] }) {
  const [cat, setCat] = useState<string>("");
  const [q, setQ] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editSet, setEditSet] = useState<string>("");
  const [open, setOpen] = useState<string | null>(null);

  const list = useMemo(
    () => styles.filter((s) => (!cat || s.category === cat) && (showHidden || !s.hidden) && (!q || s.name.toLowerCase().includes(q.toLowerCase()) || s.id.includes(q.toLowerCase()))),
    [styles, cat, q, showHidden],
  );
  const loadSet = (id: string) => {
    setEditSet(id);
    const s = sets.find((x) => x.id === id);
    setSelected(new Set(s?.styleIds ?? []));
  };
  const toggle = (id: string) => setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const current = sets.find((s) => s.id === editSet);

  return (
    <Card title="Галерея ИИ-стилей" description="Отметьте стили галочками и создайте набор, или выберите существующий набор, чтобы изменить его состав.">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select className="input max-w-xs py-1.5" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">Все категории</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <input className="input max-w-xs py-1.5" placeholder="Поиск по названию…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> показывать скрытые</label>
        <select className="input max-w-xs py-1.5 ml-auto" value={editSet} onChange={(e) => loadSet(e.target.value)}>
          <option value="">Новый набор</option>
          {sets.map((s) => <option key={s.id} value={s.id}>Изменить: {s.name}</option>)}
        </select>
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
        {list.map((s) => (
          <div key={s.id} className={`rounded-xl border p-2 flex flex-col ${s.hidden ? "opacity-60 border-dashed" : selected.has(s.id) ? "border-brand ring-2 ring-brand/40" : "border-line"}`}>
            <button type="button" className="text-left" onClick={() => toggle(s.id)}>
              {s.examples.length ? (
                <div className="grid grid-cols-3 gap-1">{s.examples.map((u) => <img key={u} src={u} alt="" loading="lazy" className="w-full aspect-[2/3] object-cover rounded-md" />)}</div>
              ) : <div className="w-full aspect-[3/2] rounded-md bg-ink/5 flex items-center justify-center text-[12px] text-muted">без примеров</div>}
              <div className="mt-1.5 text-[13px] font-medium leading-tight">{s.name}</div>
              <div className="help">{s.category}{s.note ? " · есть заметка" : ""}</div>
            </button>
            <div className="mt-auto pt-2 flex items-center gap-1">
              <label className="flex items-center gap-1.5 text-[12px]"><input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} /> в набор</label>
              <button type="button" className="btn-ghost btn-sm ml-auto" onClick={() => setOpen(open === s.id ? null : s.id)}>…</button>
            </div>
            {open === s.id && (
              <div className="mt-2 space-y-2 border-t border-line pt-2">
                <p className="text-[12px] text-muted">{s.concept}</p>
                <ActionForm action={toggleStyleHidden} className="inline" hidden={{ siteId, styleId: s.id, kind: "ai", styleName: s.name }}>
                  <SubmitButton className="btn-ghost btn-sm" pendingText="…">{s.hidden ? "Вернуть для сайта" : "Скрыть для сайта"}</SubmitButton>
                </ActionForm>
                <ActionForm action={saveStyleNote} className="space-y-1" hidden={{ teamId, styleId: s.id }}>
                  <textarea name="instruction" className="input text-[12px]" rows={3} defaultValue={s.note} placeholder="Заметка к стилю для промта (необязательно)" />
                  <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить заметку</SubmitButton>
                </ActionForm>
              </div>
            )}
          </div>
        ))}
      </div>
      {list.length === 0 && <p className="help">Ничего не найдено.</p>}

      <div className="sticky bottom-0 mt-4 -mx-4 sm:-mx-5 px-4 sm:px-5 py-3 border-t border-line bg-surface/95 backdrop-blur">
        <ActionForm action={saveAiSet} className="flex flex-wrap items-end gap-2" hidden={{ siteId, id: editSet }}>
          {[...selected].map((id) => <input key={id} type="hidden" name="styleIds" value={id} />)}
          <span className="text-[14px] self-center">Выбрано стилей: <b>{selected.size}</b></span>
          <Field label="Название набора"><input name="name" className="input py-1.5" defaultValue={current?.name ?? ""} key={editSet} placeholder="Основной" /></Field>
          <Field label="Тема (необязательно)"><input name="topic" className="input py-1.5" defaultValue={current?.topic ?? ""} key={`t-${editSet}`} placeholder="decor, nails…" /></Field>
          <SubmitButton className="btn-brand" pendingText="…">{editSet ? "Сохранить набор" : "Создать набор"}</SubmitButton>
          {selected.size > 0 && <button type="button" className="btn-ghost" onClick={() => setSelected(new Set())}>Снять выбор</button>}
        </ActionForm>
      </div>
    </Card>
  );
}
