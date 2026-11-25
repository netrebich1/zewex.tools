"use client";
import { useState, useTransition, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { moveCard } from "@/actions/tasks";
import { BOARD_STATUSES, STATUSES, type Status } from "@/lib/tasks/consts";
import type { TaskRow } from "@/lib/tasks/queries";
import { TaskCard } from "./bits";

/** Канбан: колонки по статусу, перетаскивание карточек (HTML5 drag-and-drop), порядок сохраняется. */
export function Board({ tasks, hideDone = false }: { tasks: TaskRow[]; hideDone?: boolean }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [local, setLocal] = useState<TaskRow[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ status: string; index: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = local ?? tasks;
  const cols = BOARD_STATUSES.filter((s) => !(hideDone && s === "done"));
  const byStatus = (s: string) => rows.filter((t) => t.status === s).sort((a, b) => a.order - b.order || a.priority - b.priority);

  const onDragStart = (e: DragEvent, id: string) => { setDragId(id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id); };
  const onDragOverCol = (e: DragEvent, status: string, index: number) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (!over || over.status !== status || over.index !== index) setOver({ status, index }); };
  const drop = (status: Status, index: number) => {
    if (!dragId) return;
    const moving = rows.find((t) => t.id === dragId);
    if (!moving) return;
    const col = byStatus(status).filter((t) => t.id !== dragId);
    const idx = Math.max(0, Math.min(index, col.length));
    col.splice(idx, 0, { ...moving, status });
    const ordered = col.map((t, i) => ({ ...t, order: i }));
    setLocal(rows.map((t) => ordered.find((o) => o.id === t.id) ?? t));
    setDragId(null); setOver(null); setError(null);
    start(async () => {
      const r = await moveCard(dragId, status, ordered.map((t) => t.id));
      if (r.error) { setError(r.error); setLocal(null); }
      router.refresh();
    });
  };

  return (
    <div>
      {error && <p className="help text-danger mb-2">{error}</p>}
      <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto pb-3">
        <div className="flex gap-3 min-w-max items-start">
          {cols.map((status) => {
            const items = byStatus(status);
            const meta = STATUSES.find((s) => s.key === status)!;
            const isOver = over?.status === status;
            return (
              <div key={status} className={`w-[280px] shrink-0 rounded-2xl border p-2 transition ${isOver && dragId ? "border-brand bg-brand-soft/40" : "border-line bg-ink/[0.025]"}`}
                onDragOver={(e) => onDragOverCol(e, status, items.length)} onDrop={(e) => { e.preventDefault(); drop(status, over?.status === status ? over.index : items.length); }} onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null); }}>
                <div className="flex items-center justify-between px-1.5 pb-2">
                  <span className="text-[12.5px] font-semibold uppercase tracking-wider text-muted">{meta.label}</span>
                  <span className="text-[12px] text-muted tabular-nums">{items.length}</span>
                </div>
                <div className="space-y-2 min-h-[60px]">
                  {items.map((t, i) => (
                    <div key={t.id} draggable onDragStart={(e) => onDragStart(e, t.id)} onDragEnd={() => { setDragId(null); setOver(null); }}
                      onDragOver={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onDragOverCol(e, status, e.clientY < r.top + r.height / 2 ? i : i + 1); }}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(status, over?.status === status ? over.index : i); }}
                      className={`cursor-grab active:cursor-grabbing ${dragId === t.id ? "opacity-40" : ""}`}>
                      {isOver && dragId && over?.index === i && dragId !== t.id && <div className="h-1 rounded bg-brand mb-2" />}
                      <TaskCard t={t} compact />
                    </div>
                  ))}
                  {isOver && dragId && over?.index === items.length && <div className="h-1 rounded bg-brand" />}
                  {!items.length && <p className="help px-1.5 py-3 text-center">Перетащите сюда</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
