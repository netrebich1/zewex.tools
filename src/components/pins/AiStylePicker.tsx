"use client";
import { useMemo, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Badge, Card, Field } from "@/components/ui";
import { saveAiSet, saveStyleNote, toggleStyleHidden } from "@/actions/pins";

export type StyleRow = {
  id: string; name: string; category: string; type: string; group: string; groupName: string; variantLabel: string;
  concept: string; examples: string[]; hidden: boolean; note: string;
};
type SetRow = { id: string; name: string; topic: string; styleIds: string[] };
type CategoryRow = { id: string; label: string; note?: string };
type TypeRow = { id: string; label: string; ru?: string; color?: string; desc?: string };

type Group = { key: string; name: string; category: string; type: string; concept: string; variants: StyleRow[]; examples: string[] };

/**
 * Галерея ИИ-стилей, сгруппированная по стилям: у стиля до 5 вариантов (цветовых подач).
 * В набор можно взять весь стиль («Выбрать все») или отдельные варианты.
 */
export function AiStylePicker({ siteId, teamId, styles, categories, types, sets }: { siteId: string; teamId: string; styles: StyleRow[]; categories: CategoryRow[]; types: TypeRow[]; sets: SetRow[] }) {
  const [cat, setCat] = useState<string>("");
  const [type, setType] = useState<string>("");
  const [q, setQ] = useState("");
  const [onlyExamples, setOnlyExamples] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editSet, setEditSet] = useState<string>("");
  const [open, setOpen] = useState<string | null>(null);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const s of styles) {
      let g = map.get(s.group);
      if (!g) { g = { key: s.group, name: s.groupName, category: s.category, type: s.type, concept: s.concept, variants: [], examples: [] }; map.set(s.group, g); }
      g.variants.push(s);
      for (const u of s.examples) if (g.examples.length < 5 && !g.examples.includes(u)) g.examples.push(u);
    }
    return [...map.values()];
  }, [styles]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return groups
      .map((g) => ({ ...g, variants: g.variants.filter((v) => showHidden || !v.hidden) }))
      .filter((g) => g.variants.length > 0)
      .filter((g) => (!cat || g.category === cat) && (!type || g.type === type))
      .filter((g) => !onlyExamples || g.examples.length > 0)
      .filter((g) => !needle || g.name.toLowerCase().includes(needle) || g.key.includes(needle) || g.variants.some((v) => v.variantLabel.toLowerCase().includes(needle)));
  }, [groups, cat, type, q, onlyExamples, showHidden]);

  const typeOf = (id: string) => types.find((t) => t.id === id);
  const loadSet = (id: string) => { setEditSet(id); setSelected(new Set(sets.find((x) => x.id === id)?.styleIds ?? [])); };
  const toggle = (id: string) => setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setMany = (ids: string[], on: boolean) => setSelected((p) => { const n = new Set(p); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });
  const visibleIds = list.flatMap((g) => g.variants.map((v) => v.id));
  const current = sets.find((s) => s.id === editSet);
  const catNote = categories.find((c) => c.id === cat)?.note;

  return (
    <Card title="Галерея ИИ-стилей" description="Стиль — это идея оформления, у него до 5 вариантов (цвет, подача). Возьмите в набор весь стиль или отдельные варианты.">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input className="input max-w-xs py-1.5" placeholder="Поиск стиля…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={onlyExamples} onChange={(e) => setOnlyExamples(e.target.checked)} /> только с примерами</label>
        <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> показывать скрытые</label>
        <select className="input max-w-xs py-1.5 ml-auto" value={editSet} onChange={(e) => loadSet(e.target.value)}>
          <option value="">Новый набор</option>
          {sets.map((s) => <option key={s.id} value={s.id}>Изменить: {s.name}</option>)}
        </select>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-2">
        <button type="button" className={`tab ${!cat ? "active" : ""}`} onClick={() => setCat("")}>Все категории</button>
        {categories.map((c) => <button key={c.id} type="button" className={`tab ${cat === c.id ? "active" : ""}`} onClick={() => setCat(c.id)}>{c.label}</button>)}
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        <button type="button" className={`badge px-2.5 py-1 ${!type ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`} onClick={() => setType("")}>Все типы</button>
        {types.map((t) => (
          <button key={t.id} type="button" title={t.desc} className={`badge px-2.5 py-1 ${type === t.id ? "text-bg" : "bg-ink/5 hover:bg-ink/10"}`} style={type === t.id ? { background: t.color } : undefined} onClick={() => setType(type === t.id ? "" : t.id)}>{t.ru ?? t.label}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="help">{catNote ?? "Стилей: " + groups.length}{" · показано: "}{list.length}</span>
        <button type="button" className="btn-ghost btn-sm ml-auto" onClick={() => setMany(visibleIds, true)}>Выбрать всё показанное</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMany(visibleIds, false)}>Очистить показанное</button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((g) => {
          const ids = g.variants.map((v) => v.id);
          const chosen = ids.filter((id) => selected.has(id)).length;
          const all = chosen === ids.length;
          const t = typeOf(g.type);
          return (
            <div key={g.key} className={`rounded-xl border p-3 flex flex-col ${chosen ? "border-brand ring-2 ring-brand/30" : "border-line"}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="help">{g.variants.length} вариант(ов){chosen ? ` · выбрано ${chosen}` : ""}</div>
                  <div className="text-[14px] font-semibold leading-tight truncate" title={g.name}>{g.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {t && <span className="badge px-2 py-0.5 text-bg" style={{ background: t.color }}>{t.ru ?? t.label}</span>}
                    <Badge>{categories.find((c) => c.id === g.category)?.label.split(" / ")[0] ?? g.category}</Badge>
                  </div>
                </div>
                <button type="button" className={`btn-sm ${all ? "btn-primary" : "btn-ghost"}`} onClick={() => setMany(ids, !all)}>{all ? "Снять все" : `Выбрать все ${ids.length}`}</button>
              </div>

              <div className="mt-3 grid grid-cols-5 gap-1.5">
                {g.variants.map((v, i) => {
                  const on = selected.has(v.id);
                  const img = v.examples[0] ?? g.examples[i] ?? g.examples[0];
                  return (
                    <button key={v.id} type="button" onClick={() => toggle(v.id)} title={`${v.variantLabel || v.name}${v.note ? " · есть заметка" : ""}`} className={`rounded-lg border p-1 text-left ${on ? "border-brand ring-2 ring-brand/40" : "border-line hover:border-line-2"} ${v.hidden ? "opacity-50 border-dashed" : ""}`}>
                      {img ? <img src={img} alt="" loading="lazy" className="w-full aspect-[2/3] object-cover rounded-md" /> : <div className="w-full aspect-[2/3] rounded-md bg-ink/5 flex items-center justify-center text-[11px] text-muted">нет примера</div>}
                      <div className="mt-1 flex items-center gap-1 text-[11px] leading-tight">
                        <input type="checkbox" readOnly checked={on} className="h-3 w-3" />
                        <span className="truncate">{v.variantLabel || `/${i + 1}`}</span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <p className="help truncate flex-1" title={g.concept}>{g.concept}</p>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(open === g.key ? null : g.key)}>{open === g.key ? "Скрыть" : "Подробнее"}</button>
              </div>
              {open === g.key && (
                <div className="mt-2 space-y-2 border-t border-line pt-2">
                  <p className="text-[12px] text-muted">{g.concept}</p>
                  <div className="space-y-1.5">
                    {g.variants.map((v) => (
                      <div key={v.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                        <span className="font-medium w-36 truncate" title={v.name}>{v.variantLabel || v.name}</span>
                        <ActionForm action={toggleStyleHidden} className="inline" hidden={{ siteId, styleId: v.id, kind: "ai", styleName: v.name }}>
                          <SubmitButton className="btn-ghost btn-sm" pendingText="…">{v.hidden ? "Вернуть для сайта" : "Скрыть для сайта"}</SubmitButton>
                        </ActionForm>
                        <ActionForm action={saveStyleNote} className="flex items-center gap-1 flex-1 min-w-[240px]" hidden={{ teamId, styleId: v.id }}>
                          <input name="instruction" className="input py-1 text-[12px]" defaultValue={v.note} placeholder="Заметка к варианту для промта" />
                          <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить</SubmitButton>
                        </ActionForm>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {list.length === 0 && <p className="help">Ничего не найдено.</p>}

      <div className="sticky bottom-0 mt-4 -mx-4 sm:-mx-5 px-4 sm:px-5 py-3 border-t border-line bg-surface/95 backdrop-blur">
        <ActionForm action={saveAiSet} className="flex flex-wrap items-end gap-2" hidden={{ siteId, id: editSet }}>
          {[...selected].map((id) => <input key={id} type="hidden" name="styleIds" value={id} />)}
          <span className="text-[14px] self-center">Выбрано вариантов: <b>{selected.size}</b></span>
          <Field label="Название набора"><input name="name" className="input py-1.5" defaultValue={current?.name ?? ""} key={editSet} placeholder="Основной" /></Field>
          <Field label="Тема (необязательно)"><input name="topic" className="input py-1.5" defaultValue={current?.topic ?? ""} key={`t-${editSet}`} placeholder="decor, nails…" /></Field>
          <SubmitButton className="btn-brand" pendingText="…">{editSet ? "Сохранить набор" : "Создать набор"}</SubmitButton>
          {selected.size > 0 && <button type="button" className="btn-ghost" onClick={() => setSelected(new Set())}>Снять выбор</button>}
        </ActionForm>
      </div>
    </Card>
  );
}
