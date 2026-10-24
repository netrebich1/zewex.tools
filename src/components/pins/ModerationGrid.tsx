"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ModerationItem } from "@/lib/pins/runs/moderation";
import { ENGINE_LABELS } from "./labels";

type Batch = { items: ModerationItem[]; nextCursor: string | null };
type Filter = { siteId?: string; runId?: string; engine?: string };

/**
 * Сетка быстрой модерации: клик = пометить на отклонение; «Одобрить остальные» отправляет пачку.
 * Увеличение: ← → листать, Delete отклонить, Enter оставить, Esc закрыть. Черновик — в localStorage.
 */
/** post — пост-модерация: одобренные пины; клик помечает на отклонение, остальные остаются одобренными и считаются просмотренными. */
export function ModerationGrid({ initial, filter, showSite = false, post = false }: { initial: Batch; filter: Filter; showSite?: boolean; post?: boolean }) {
  const router = useRouter();
  const storageKey = `pins-moderation${post ? "-post" : ""}:${filter.siteId ?? "all"}:${filter.runId ?? "all"}:${filter.engine ?? "all"}`;
  const [batch, setBatch] = useState<Batch>(initial);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [zoomId, setZoomId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [size, setSize] = useState<"s" | "m" | "l">("m");
  const nextRef = useRef<Batch | null>(null);
  // Сервер прислал новую пачку (смена фильтра, обновление страницы) — показываем её, а не то, что осталось в памяти.
  useEffect(() => { setBatch(initial); }, [initial]);

  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) || "[]");
      if (Array.isArray(raw)) setMarked(new Set(raw.filter((x) => typeof x === "string")));
    } catch { /* пусто */ }
  }, [storageKey]);
  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(storageKey, JSON.stringify([...marked])); } catch { /* пусто */ } }, 150);
    return () => clearTimeout(t);
  }, [marked, storageKey]);

  const query = useCallback((cursor: string | null) => {
    const u = new URLSearchParams();
    if (filter.siteId) u.set("site", filter.siteId);
    if (filter.runId) u.set("run", filter.runId);
    if (filter.engine) u.set("engine", filter.engine);
    if (cursor) u.set("cursor", cursor);
    if (post) u.set("view", "post");
    u.set("limit", "60");
    return `/api/pins/moderation?${u.toString()}`;
  }, [filter, post]);

  // предзагрузка следующей пачки
  useEffect(() => {
    nextRef.current = null;
    if (!batch.nextCursor) return;
    fetch(query(batch.nextCursor), { cache: "no-store" }).then((r) => r.json()).then((b: Batch) => { nextRef.current = b; }).catch(() => {});
  }, [batch.nextCursor, query]);

  const toggle = useCallback((id: string) => {
    setMarked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);

  const zoomIndex = useMemo(() => batch.items.findIndex((i) => i.id === zoomId), [batch.items, zoomId]);
  const zoomItem = zoomIndex >= 0 ? batch.items[zoomIndex] : null;
  const zoomBy = useCallback((d: number) => {
    if (zoomIndex < 0) return;
    const n = Math.min(Math.max(zoomIndex + d, 0), batch.items.length - 1);
    setZoomId(batch.items[n]?.id ?? null);
  }, [zoomIndex, batch.items]);

  useEffect(() => {
    if (!zoomId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "ArrowRight") { e.preventDefault(); zoomBy(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); zoomBy(-1); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); setMarked((p) => new Set(p).add(zoomId)); zoomBy(1); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMarked((p) => { const n = new Set(p); n.delete(zoomId); return n; }); zoomBy(1); }
      else if (e.key === "Escape") { e.preventDefault(); setZoomId(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomId, zoomBy]);

  // свайп влево/вправо в увеличении листает пины
  const touchX = useRef<number | null>(null);

  const finish = useCallback(async (mode: "all" | "marked_only") => {
    setBusy(true);
    setMsg("");
    try {
      const ids = batch.items.map((i) => i.id);
      const decisions = ids
        .filter((id) => mode === "all" || marked.has(id))
        .map((id) => ({ id, moderation: marked.has(id) ? "REJECTED" : "APPROVED" }));
      for (let i = 0; i < decisions.length; i += 100) {
        const res = await fetch("/api/pins/moderation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decisions: decisions.slice(i, i + 100), post }) });
        if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
        const r = (await res.json()) as { applied: number; continued: string[] };
        if (r.continued.length) setMsg(`Прогонов продолжено: ${r.continued.length}`);
      }
      const decided = new Set(decisions.map((d) => d.id));
      setMarked((p) => { const n = new Set([...p].filter((id) => !decided.has(id))); return n; });
      const rest = batch.items.filter((i) => !decided.has(i.id));
      if (rest.length === 0) {
        const next = nextRef.current ?? (batch.nextCursor ? ((await (await fetch(query(null), { cache: "no-store" })).json()) as Batch) : null);
        if (next && next.items.length) { setBatch(next); window.scrollTo({ top: 0 }); }
        else { router.refresh(); setBatch({ items: [], nextCursor: null }); }
      } else {
        setBatch({ items: rest, nextCursor: batch.nextCursor });
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [batch, marked, query, router]);

  const cols = size === "s" ? "grid-cols-4 sm:grid-cols-6 lg:grid-cols-8" : size === "m" ? "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
  const markedHere = batch.items.filter((i) => marked.has(i.id)).length;

  return (
    <div className="pb-36 sm:pb-24">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <span>Показано {batch.items.length}{batch.nextCursor ? " (есть ещё)" : ""}</span>
        <span className="ml-auto inline-flex gap-1">
          {(["s", "m", "l"] as const).map((s) => <button key={s} className={`btn-ghost btn-sm ${size === s ? "bg-ink/10" : ""}`} onClick={() => setSize(s)}>{s === "s" ? "мелко" : s === "m" ? "средне" : "крупно"}</button>)}
        </span>
      </div>
      <div className={`grid gap-2 ${cols}`}>
        {batch.items.map((it) => {
          const m = marked.has(it.id);
          return (
            <div key={it.id} className={`relative rounded-xl overflow-hidden border ${m ? "border-danger ring-2 ring-danger/40" : "border-line"} bg-ink/5`}>
              <button type="button" className="block w-full" onClick={() => toggle(it.id)} title={it.title || it.keyword}>
                <img src={it.thumbUrl} alt="" loading="lazy" className={`w-full aspect-[2/3] object-cover ${m ? "opacity-40 grayscale" : ""}`} />
              </button>
              {m && <span className="absolute top-2 left-2 badge bg-danger text-white">отклонить</span>}
              <button type="button" className={`absolute top-2 right-2 btn-ghost btn-sm bg-surface/90 ${size === "s" ? "max-sm:!hidden" : ""}`} onClick={() => setZoomId(it.id)} aria-label="Увеличить">🔍</button>
              <div className="px-2 py-1.5 text-[12px] sm:text-[11px] text-muted truncate">{showSite && it.siteName ? <b className="text-ink-2">{it.siteName} · </b> : null}{ENGINE_LABELS[it.engine] ?? it.engine} · {it.keyword}</div>
            </div>
          );
        })}
      </div>

      <div className="fixed bottom-0 inset-x-0 z-30 border-t border-line bg-surface/95 backdrop-blur px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:pl-72">
        <div className="mx-auto max-w-6xl flex flex-wrap items-center gap-2">
          <span className="text-[14px]">Помечено на отклонение: <b>{markedHere}</b> из {batch.items.length}</span>
          {msg && <span className="help">{msg}</span>}
          <span className="flex w-full gap-2 sm:w-auto sm:ml-auto">
            <button className="btn-ghost flex-1 sm:flex-none !whitespace-normal" disabled={busy || !markedHere} onClick={() => finish("marked_only")}><span className="sm:hidden">Отклонить</span><span className="hidden sm:inline">Отклонить помеченные</span></button>
            <button className="btn-brand flex-1 sm:flex-none !whitespace-normal" disabled={busy || !batch.items.length} onClick={() => finish("all")}>{busy ? "Сохраняю…" : post ? (markedHere ? <><span className="sm:hidden">Отклонить {markedHere} и дальше</span><span className="hidden sm:inline">Отклонить {markedHere}, остальные оставить и дальше</span></> : "Всё в порядке, дальше") : <><span className="sm:hidden">Одобрить и дальше</span><span className="hidden sm:inline">Одобрить остальные и дальше</span></>}</button>
          </span>
        </div>
      </div>

      {zoomItem && (
        <div className="fixed inset-0 z-40 bg-ink/80 flex items-start sm:items-center justify-center overflow-y-auto p-4" onClick={() => setZoomId(null)}>
          <div
            className="relative max-w-full"
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
            onTouchEnd={(e) => {
              const x0 = touchX.current; touchX.current = null;
              const x1 = e.changedTouches[0]?.clientX;
              if (x0 == null || x1 == null || Math.abs(x1 - x0) < 50) return;
              zoomBy(x1 < x0 ? 1 : -1);
            }}
          >
            <img src={zoomItem.imageUrl} alt="" className={`max-h-[65dvh] sm:max-h-[85vh] max-w-full w-auto mx-auto rounded-xl ${marked.has(zoomItem.id) ? "opacity-50 grayscale" : ""}`} />
            <button type="button" className="absolute top-2 right-2 h-10 w-10 rounded-full bg-surface/90 text-ink text-[20px] leading-none flex items-center justify-center" onClick={() => setZoomId(null)} aria-label="Закрыть">×</button>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-white text-[13px]">
              <span className="min-w-0 break-words">{zoomIndex + 1}/{batch.items.length} · {ENGINE_LABELS[zoomItem.engine] ?? zoomItem.engine} · {zoomItem.keyword}</span>
              <span className="w-full grid grid-cols-2 gap-2 sm:w-auto sm:ml-auto sm:flex">
                <button className="btn-ghost btn-sm bg-surface max-sm:order-3" onClick={() => zoomBy(-1)}>←</button>
                <button className="btn-danger btn-sm max-sm:order-1 max-sm:!py-3" onClick={() => { setMarked((p) => new Set(p).add(zoomItem.id)); zoomBy(1); }}>Отклонить<span className="hidden sm:inline"> (Delete)</span></button>
                <button className="btn-brand btn-sm max-sm:order-2 max-sm:!py-3" onClick={() => { setMarked((p) => { const n = new Set(p); n.delete(zoomItem.id); return n; }); zoomBy(1); }}>Оставить<span className="hidden sm:inline"> (Enter)</span></button>
                <button className="btn-ghost btn-sm bg-surface max-sm:order-4" onClick={() => zoomBy(1)}>→</button>
                <button className="btn-ghost btn-sm bg-surface max-sm:order-5 col-span-2" onClick={() => setZoomId(null)}>Закрыть<span className="hidden sm:inline"> (Esc)</span></button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
