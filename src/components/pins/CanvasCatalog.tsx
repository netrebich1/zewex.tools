"use client";
import { useEffect, useMemo, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, Field } from "@/components/ui";
import { buildCanvasCatalog, decideCanvasStyle, saveCanvasSet, toggleStyleHidden } from "@/actions/pins";

export type CatalogRow = { id: string; name: string; tags: string[]; counts: number[]; previewUrl: string | null; status: "pending" | "approved" | "rejected"; hidden: boolean; sourceCount: number };
type SetRow = { id: string; name: string; styleIds: string[] };

/**
 * Каталог Canvas-стилей: отбор кандидатов по превью (A — принять, R — отклонить, ← → листать),
 * утверждённые стили, наборы сайта и скрытие стиля для сайта.
 */
export function CanvasCatalog({ siteId, teamId, rows, sets, jobLabel, canDecide }: { siteId: string; teamId: string; rows: CatalogRow[]; sets: SetRow[]; jobLabel: string | null; canDecide: boolean }) {
  const [view, setView] = useState<"pending" | "approved" | "rejected">(rows.some((r) => r.status === "pending") ? "pending" : "approved");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editSet, setEditSet] = useState("");
  const list = useMemo(() => rows.filter((r) => r.status === view), [rows, view]);
  const current = list[Math.min(cursor, Math.max(0, list.length - 1))];
  const counts = { pending: rows.filter((r) => r.status === "pending").length, approved: rows.filter((r) => r.status === "approved").length, rejected: rows.filter((r) => r.status === "rejected").length };

  const decide = async (id: string, decision: "approve" | "reject" | "reset") => {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("decision", decision);
    await decideCanvasStyle({}, fd);
  };

  useEffect(() => {
    if (view !== "pending" || !canDecide) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (!current) return;
      if (e.key === "a" || e.key === "A" || e.key === "ф") { e.preventDefault(); void decide(current.id, "approve"); }
      else if (e.key === "r" || e.key === "R" || e.key === "к") { e.preventDefault(); void decide(current.id, "reject"); }
      else if (e.key === "ArrowRight") setCursor((c) => Math.min(c + 1, list.length - 1));
      else if (e.key === "ArrowLeft") setCursor((c) => Math.max(c - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, current, list.length, canDecide]);

  const toggle = (id: string) => setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const loadSet = (id: string) => { setEditSet(id); setSelected(new Set(sets.find((s) => s.id === id)?.styleIds ?? [])); };
  const cur = sets.find((s) => s.id === editSet);

  return (
    <div className="space-y-4">
      <Card title="Каталог Canvas-стилей" description="Кандидаты собираются из старых шаблонов: один спокойный вариант на стиль. Утверждённые стили используются в прогонах." actions={canDecide ? (
        <ActionForm action={buildCanvasCatalog} className="inline" hidden={{ teamId }}>
          <SubmitButton className="btn-ghost btn-sm" pendingText="Запускаю…">{rows.length ? "Обновить превью" : "Собрать каталог"}</SubmitButton>
        </ActionForm>
      ) : undefined}>
        {jobLabel && <p className="help mb-3">Идёт сборка: {jobLabel}</p>}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {(["pending", "approved", "rejected"] as const).map((v) => (
            <button key={v} type="button" className={`tab ${view === v ? "active" : ""}`} onClick={() => { setView(v); setCursor(0); }}>
              {v === "pending" ? "На отбор" : v === "approved" ? "Утверждённые" : "Отклонённые"} · {counts[v]}
            </button>
          ))}
          {view === "pending" && canDecide && list.length > 0 && <span className="help self-center ml-2">Клавиши: A принять, R отклонить, ← → листать. Текущий: {Math.min(cursor, list.length - 1) + 1}/{list.length}</span>}
        </div>

        {list.length === 0 ? (
          <p className="help">{rows.length === 0 ? "Каталог ещё не собран. Нажмите «Собрать каталог»: кандидаты и превью появятся через несколько минут." : "Пусто."}</p>
        ) : (
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {list.map((r, i) => {
              const isCur = view === "pending" && i === Math.min(cursor, list.length - 1);
              return (
                <div key={r.id} className={`rounded-xl border p-2 flex flex-col ${isCur ? "border-brand ring-2 ring-brand/40" : selected.has(r.id) ? "border-ink ring-2 ring-ink/20" : "border-line"} ${r.hidden ? "opacity-60" : ""}`} onClick={() => setCursor(i)}>
                  {r.previewUrl ? <img src={r.previewUrl} alt="" loading="lazy" className="w-full aspect-[2/3] object-cover rounded-lg" /> : <div className="w-full aspect-[2/3] rounded-lg bg-ink/5 flex items-center justify-center text-[12px] text-muted">превью ещё нет</div>}
                  <div className="mt-1.5 text-[13px] font-medium leading-tight truncate" title={r.name}>{r.name}</div>
                  <div className="help">{r.counts.join("/")} фото · из {r.sourceCount}{r.tags[0] ? ` · ${r.tags[0]}` : ""}</div>
                  <div className="mt-auto pt-2 flex flex-wrap gap-1">
                    {canDecide && view !== "approved" && <button type="button" className="btn-brand btn-sm" onClick={(e) => { e.stopPropagation(); void decide(r.id, "approve"); }}>Принять</button>}
                    {canDecide && view !== "rejected" && <button type="button" className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); void decide(r.id, "reject"); }}>Отклонить</button>}
                    {view === "approved" && (
                      <>
                        <label className="flex items-center gap-1 text-[12px] ml-auto" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /> в набор</label>
                        <ActionForm action={toggleStyleHidden} className="inline" hidden={{ siteId, styleId: r.id, kind: "canvas", styleName: r.name }}>
                          <SubmitButton className="btn-ghost btn-sm" pendingText="…">{r.hidden ? "Вернуть" : "Скрыть для сайта"}</SubmitButton>
                        </ActionForm>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title={`Canvas-наборы сайта: ${sets.length}`} description="Набор ограничивает стили, которые автопилот берёт для этого сайта. Без наборов берутся все утверждённые стили, кроме скрытых.">
        {sets.length > 0 && (
          <ul className="mb-3 flex flex-wrap gap-2">{sets.map((s) => <li key={s.id} className="badge bg-ink/5">{s.name} · {s.styleIds.length}</li>)}</ul>
        )}
        <ActionForm action={saveCanvasSet} className="flex flex-wrap items-end gap-2" hidden={{ siteId, id: editSet }}>
          {[...selected].map((id) => <input key={id} type="hidden" name="styleIds" value={id} />)}
          <select className="input max-w-xs py-1.5" value={editSet} onChange={(e) => loadSet(e.target.value)}>
            <option value="">Новый набор</option>
            {sets.map((s) => <option key={s.id} value={s.id}>Изменить: {s.name}</option>)}
          </select>
          <Field label="Название"><input name="name" className="input py-1.5" key={editSet} defaultValue={cur?.name ?? ""} placeholder="Основной" /></Field>
          <span className="text-[14px] self-center">Выбрано: <b>{selected.size}</b> (отмечайте во вкладке «Утверждённые»)</span>
          <SubmitButton className="btn-brand" pendingText="…">{editSet ? "Сохранить" : "Создать набор"}</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
