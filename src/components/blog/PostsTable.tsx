"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { bulkPostsAction } from "@/actions/blog";
import type { PostRowData } from "@/lib/blog/queries";
import { StatusBadge } from "./StatusBadge";

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Таблица инфо-статей с отметками и массовыми действиями: Одобрить · Повторить · Остановить · В очередь · Удалить. */
export function PostsTable({ rows, showRun = false, showSite = false, emptyText = "Статей нет" }: { rows: PostRowData[]; showRun?: boolean; showSite?: boolean; emptyText?: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(ids));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const picked = ids.filter((id) => selected.has(id));
  if (!rows.length) return <p className="help">{emptyText}</p>;

  return (
    <ActionForm action={bulkPostsAction} className="space-y-3">
      {picked.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2">
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="h-4 w-4" checked={allOn} onChange={toggleAll} /> {picked.length ? `Отмечено ${picked.length}` : "Отметить все"}</label>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="submit" name="op" value="approve" className="btn-ghost btn-sm" disabled={!picked.length} title="Одобрить отмеченные статьи с проверки: пересборка и публикация">Одобрить</button>
          <button type="submit" name="op" value="retry" className="btn-ghost btn-sm" disabled={!picked.length} title="Снова в очередь с этапа, на котором остановились или упали">Повторить</button>
          <button type="submit" name="op" value="stop" className="btn-ghost btn-sm" disabled={!picked.length}>Остановить</button>
          <button type="submit" name="op" value="requeue" className="btn-ghost btn-sm" disabled={!picked.length}>В очередь</button>
          {!confirmDelete ? (
            <button type="button" className="btn-danger btn-sm" disabled={!picked.length} onClick={() => setConfirmDelete(true)}>Удалить</button>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5 rounded-lg bg-danger-soft px-2 py-1 text-[13px] text-danger">
              Удалить {picked.length} статей вместе с фото и текстами?
              <button type="submit" name="op" value="delete" className="btn-danger btn-sm" onClick={() => setConfirmDelete(false)}>Да, удалить</button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>Отмена</button>
            </span>
          )}
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="w-8"></th>
              <th>Ключ · статья</th>
              {showSite && <th className="hidden md:table-cell">Сайт</th>}
              <th>Статус</th>
              <th className="hidden sm:table-cell">Этап</th>
              {showRun && <th className="hidden lg:table-cell">Запуск</th>}
              <th className="hidden md:table-cell text-right">Слов · фото</th>
              <th className="hidden md:table-cell">Обновлено</th>
              <th className="hidden sm:table-cell text-right">Расход</th>
              <th className="hidden md:table-cell">WP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={selected.has(r.id) ? "bg-brand/5" : ""}>
                <td><input type="checkbox" className="h-4 w-4" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label="Отметить" /></td>
                <td className="max-w-[280px] sm:max-w-[420px]">
                  <Link href={`/pinterest/blog/posts/${r.id}`} className="font-medium hover:underline block truncate" title={r.keyword}>{r.keyword}</Link>
                  {r.title && r.title.toLowerCase() !== r.keyword.toLowerCase() && <div className="truncate text-[13px]" title={r.title}>{r.title}</div>}
                  <div className="help truncate"><span className="sm:hidden">{r.stageLabel} · </span>{r.recipeName ?? "—"}{r.note ? ` · ${r.note}` : ""}</div>
                  {r.error && (r.status === "FAILED" || r.status === "PUBLISH_ERROR") && <div className="text-[12.5px] text-danger truncate" title={r.error}>{r.error}</div>}
                </td>
                {showSite && <td className="hidden md:table-cell text-muted"><Link href={`/pinterest/blog/sites/${r.siteId}`} className="hover:underline">{r.siteName}</Link></td>}
                <td><StatusBadge status={r.status} /></td>
                <td className="hidden sm:table-cell text-muted">{r.stage === "done" ? "—" : r.stageLabel}</td>
                {showRun && <td className="hidden lg:table-cell text-muted">{r.runId ? <Link href={`/pinterest/blog/runs/${r.runId}`} className="hover:underline">{r.runName || r.runId.slice(0, 8)}</Link> : "—"}</td>}
                <td className="hidden md:table-cell text-right tabular-nums text-muted">{r.wordCount || "—"} · {r.photos}</td>
                <td className="hidden md:table-cell text-muted tabular-nums whitespace-nowrap">{fmt(r.updatedAt)}</td>
                <td className="hidden sm:table-cell text-right tabular-nums">{r.costUsd > 0 ? `$${r.costUsd.toFixed(3)}` : "—"}</td>
                <td className="hidden md:table-cell">{r.wpUrl ? <a href={r.wpUrl} target="_blank" rel="noreferrer" className="text-info hover:underline">открыть ↗</a> : <span className="text-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ActionForm>
  );
}
