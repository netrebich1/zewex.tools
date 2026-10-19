"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ModCandidate, ModPhoto, PhotoModerationState } from "@/lib/articles/moderation";

/**
 * Сетка модерации фото статьи (одна для конвейера модерации и вкладки «Фото» карточки статьи).
 * Зона «В статье»: нумерация, перетаскивание порядка (HTML5 drag), двойной клик — лайтбокс с оригиналом,
 * кнопки ✕ и «Устарело», бейджи. Зона «Резерв»: «Подходящие по оценке» / «Отклонённые оценкой» (оценка кадров
 * на этапе поиска, не ИИ-модерация), кнопка «+».
 * Пометки ИИ-модерации (state.ai): «ИИ ✕» с причиной у снятых ИИ, «+ИИ» у добавленных ИИ, «ИИ: убрать?» / «ИИ: добавить?»
 * у предложений, которые ещё не применены (тест-режим).
 * Клик по фото ничего не удаляет. Все изменения — через /api/articles/moderation, ответ несёт свежее состояние.
 * Undo: стек обратных действий в рамках статьи (включая «Добавить» → убрать добавленный кадр).
 * Сенсорные экраны: кнопки на карточке видны всегда (не только при наведении), стрелки ◀ ▶ вместо перетаскивания.
 *
 * Оригинал: src/pages/PhotoModerationPage.tsx (раскладки, размеры, табы резерва) + 05-data-and-ui.md §7 экран 6.
 */

export type GridSize = "s" | "m" | "l";
const SIZE_LABELS: Record<GridSize, string> = { s: "Компактно", m: "Крупно", l: "Очень крупно" };
const COLS: Record<GridSize, string> = {
  s: "grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10",
  m: "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6",
  l: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
};
/** Минимальная сторона кадра для сайта (08-plan §3 п.11: 550). */
const MIN_SIDE = 550;

type Undo = { label: string; body: Record<string, unknown> };
/** Обратное действие: готовое тело или функция от ответа сервера (например, id только что добавленного фото). */
type Inverse = Record<string, unknown> | ((result: unknown) => Record<string, unknown> | null);

/** Кнопки на карточке: на устройствах с мышью — при наведении (и при фокусе с клавиатуры), на сенсорных — всегда. */
const HOVER_REVEAL = "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100";

export type ApiResponse = { ok?: boolean; error?: string; stale?: boolean; state?: PhotoModerationState | null; result?: unknown };

/** Один вызов API модерации. Бросает Error с текстом сервера; stale — отдельное поле. */
export async function moderationApi(body: Record<string, unknown>, mode = "photos"): Promise<ApiResponse> {
  const res = await fetch("/api/articles/moderation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, ...body }) });
  const data = (await res.json().catch(() => ({}))) as ApiResponse;
  if (!res.ok) {
    const e = new Error(data.error || `Сервер ответил ${res.status}`) as Error & { stale?: boolean };
    e.stale = !!data.stale || res.status === 409;
    throw e;
  }
  return data;
}

export function useGridSize(userKey: string): [GridSize, (s: GridSize) => void] {
  const key = `art-photo-size:${userKey}`;
  const [size, setSizeState] = useState<GridSize>("m");
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      if (v === "s" || v === "m" || v === "l") setSizeState(v);
    } catch {
      /* пусто */
    }
  }, [key]);
  const setSize = useCallback(
    (s: GridSize) => {
      setSizeState(s);
      try {
        localStorage.setItem(key, s);
      } catch {
        /* пусто */
      }
    },
    [key],
  );
  return [size, setSize];
}

const shape = (w: number | null, h: number | null): "tall" | "square" | "wide" => {
  if (!w || !h) return "square";
  const r = w / h;
  return r < 0.9 ? "tall" : r > 1.1 ? "wide" : "square";
};
const score = (p: { aiScore: number | null }) => (p.aiScore == null ? -1 : p.aiScore);
const byScoreDesc = (a: { aiScore: number | null }, b: { aiScore: number | null }) => score(b) - score(a);

/** Быстрые раскладки (оригинал PhotoModerationPage.tsx:199-230). */
export const LAYOUTS: Array<{ key: string; label: string; help: string; fn: (ps: ModPhoto[]) => ModPhoto[] }> = [
  { key: "top", label: "По баллам", help: "Все фото по убыванию балла", fn: (ps) => [...ps].sort(byScoreDesc) },
  {
    key: "top5alt",
    label: "Топ-5 + через одну",
    help: "Пять лучших, дальше сильное/слабое через одну",
    fn: (ps) => {
      const s = [...ps].sort(byScoreDesc);
      const head = s.slice(0, 5);
      const rest = s.slice(5);
      const half = Math.ceil(rest.length / 2);
      const strong = rest.slice(0, half);
      const weak = rest.slice(half);
      const out = [...head];
      for (let i = 0; i < half; i++) {
        out.push(strong[i]);
        if (weak[i]) out.push(weak[i]);
      }
      return out;
    },
  },
  {
    key: "alt",
    label: "Чередовать",
    help: "Вся лента: сильное/слабое через одну",
    fn: (ps) => {
      const s = [...ps].sort(byScoreDesc);
      const half = Math.ceil(s.length / 2);
      const strong = s.slice(0, half);
      const weak = s.slice(half);
      const out: ModPhoto[] = [];
      for (let i = 0; i < half; i++) {
        out.push(strong[i]);
        if (weak[i]) out.push(weak[i]);
      }
      return out;
    },
  },
  { key: "tall", label: "Вертикальные вперёд", help: "Сначала вертикальные по баллам", fn: (ps) => [...ps].sort((a, b) => (shape(a.width, a.height) === "tall" ? 0 : 1) - (shape(b.width, b.height) === "tall" ? 0 : 1) || byScoreDesc(a, b)) },
  {
    key: "shuffle",
    label: "Перемешать",
    help: "Случайный порядок",
    fn: (ps) => {
      const s = [...ps];
      for (let i = s.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [s[i], s[j]] = [s[j], s[i]];
      }
      return s;
    },
  },
];

export type PhotoModerationGridProps = {
  initial: PhotoModerationState;
  /** Ключ пользователя для localStorage (размер превью) */
  userKey: string;
  /** Можно ли менять фото (статья в PHOTO_REVIEW / REVIEW_PENDING) */
  editable?: boolean;
  /** Режим API: photos (модерация фото) или articles (модерация статьи) */
  mode?: "photos" | "articles" | "rework";
  /** Сообщать родителю свежее состояние после каждого действия */
  onState?: (s: PhotoModerationState) => void;
  /** Статья ушла из модерации (409) — родитель переходит к следующей */
  onStale?: (message: string) => void;
  /** Клавиши: Enter — одобрить, стрелки — следующая/предыдущая (если переданы) */
  onApprove?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  /** Дополнительное содержимое под карточкой фото (модерация статьи: текст секции) */
  renderUnderPhoto?: (p: ModPhoto) => ReactNode;
  /** Скрыть резерв (карточка статьи после публикации) */
  hideReserve?: boolean;
};

export function PhotoModerationGrid({ initial, userKey, editable = true, mode = "photos", onState, onStale, onApprove, onNext, onPrev, renderUnderPhoto, hideReserve }: PhotoModerationGridProps) {
  const [state, setState] = useState<PhotoModerationState>(initial);
  const [size, setSize] = useGridSize(userKey);
  const [tab, setTab] = useState<"reserve" | "rejected">("reserve");
  const [shapeFilter, setShapeFilter] = useState<"all" | "tall" | "square">("all");
  const [shown, setShown] = useState(60);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "danger" } | null>(null);
  const [zoom, setZoom] = useState<{ url: string; title: string } | null>(null);
  const [menu, setMenu] = useState(false);
  const [undo, setUndo] = useState<Undo[]>([]);
  const dragId = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Новая статья — сброс
  useEffect(() => {
    setState(initial);
    setUndo([]);
    setShown(60);
    setMsg(null);
  }, [initial]);

  const apply = useCallback(
    (s: PhotoModerationState | null | undefined) => {
      if (!s) return;
      setState(s);
      onState?.(s);
    },
    [onState],
  );

  const act = useCallback(
    async (label: string, body: Record<string, unknown>, inverse?: Inverse) => {
      if (!editable) return;
      setBusy(label);
      setMsg(null);
      try {
        const r = await moderationApi({ articleId: state.article.id, ...body }, mode);
        apply(r.state);
        const inv = typeof inverse === "function" ? inverse(r.result) : inverse;
        if (inv) setUndo((u) => [...u.slice(-29), { label, body: inv }]);
        const res = r.result as { message?: string } | null;
        if (res?.message) setMsg({ text: res.message, tone: "ok" });
      } catch (e) {
        const err = e as Error & { stale?: boolean };
        if (err.stale) onStale?.(err.message);
        else setMsg({ text: err.message, tone: "danger" });
      } finally {
        setBusy(null);
      }
    },
    [editable, state.article.id, mode, apply, onStale],
  );

  const undoLast = useCallback(async () => {
    const last = undo[undo.length - 1];
    if (!last) return;
    setUndo((u) => u.slice(0, -1));
    await act(`undo:${last.label}`, last.body);
  }, [undo, act]);

  const activePhotos = useMemo(() => state.photos.filter((p) => !p.excluded), [state.photos]);
  const orderIds = useMemo(() => state.photos.map((p) => p.id), [state.photos]);

  const reorderTo = useCallback(
    (next: string[]) => {
      const prev = orderIds;
      // оптимистично
      const map = new Map(state.photos.map((p) => [p.id, p]));
      const optimistic = next.map((id, i) => ({ ...map.get(id)!, position: i + 1 }));
      setState((s) => ({ ...s, photos: optimistic }));
      void act("reorder", { action: "reorder", order: next }, { action: "reorder", order: prev });
    },
    [orderIds, state.photos, act],
  );

  /** Сдвинуть кадр на одну позицию (сенсорные экраны: перетаскивание там не работает). */
  const move = useCallback(
    (id: string, dir: -1 | 1) => {
      const ids = [...orderIds];
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      reorderTo(ids);
    },
    [orderIds, reorderTo],
  );

  const applyLayout = useCallback(
    (key: string) => {
      setMenu(false);
      const l = LAYOUTS.find((x) => x.key === key);
      if (!l) return;
      const next = [...l.fn(activePhotos).map((p) => p.id), ...state.photos.filter((p) => p.excluded).map((p) => p.id)];
      reorderTo(next);
    },
    [activePhotos, state.photos, reorderTo],
  );

  // Drag & drop порядка
  const onDrop = useCallback(
    (targetId: string) => {
      const src = dragId.current;
      dragId.current = null;
      setDragOver(null);
      if (!src || src === targetId) return;
      const ids = orderIds.filter((id) => id !== src);
      const idx = ids.indexOf(targetId);
      ids.splice(idx < 0 ? ids.length : idx, 0, src);
      reorderTo(ids);
    },
    [orderIds, reorderTo],
  );

  // Клавиши
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (zoom) {
        if (e.key === "Escape") {
          e.preventDefault();
          setZoom(null);
        }
        return;
      }
      if (e.key === "Enter" && onApprove && !e.repeat) {
        e.preventDefault();
        onApprove();
      } else if (e.key === "ArrowRight" && onNext) {
        e.preventDefault();
        onNext();
      } else if (e.key === "ArrowLeft" && onPrev) {
        e.preventDefault();
        onPrev();
      } else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && undo.length) {
        e.preventDefault();
        void undoLast();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, onApprove, onNext, onPrev, undo.length, undoLast]);

  const ai = state.ai;
  const overNorm = state.article.photoCount > 0 && state.counts.active > state.article.photoCount;
  const reserveList = tab === "reserve" ? state.reserve : state.rejected;
  const filtered = reserveList.filter((c) => shapeFilter === "all" || shape(c.width, c.height) === shapeFilter);
  const aspect = size === "s" ? "aspect-square" : "aspect-[3/4]";

  return (
    <div className="space-y-6">
      {/* Панель инструментов */}
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-semibold">В статье: {state.counts.active}</span>
        {overNorm && (
          <span className="badge bg-warn-soft text-warn" title="Фото больше плана статьи: текст будет длиннее задуманного. Снимите лишние или одобрите осознанно.">
            больше плана ({state.article.photoCount}) на {state.counts.active - state.article.photoCount}
          </span>
        )}
        {state.counts.excluded > 0 && <span className="text-muted">снято: {state.counts.excluded}</span>}
        {msg && <span className={msg.tone === "danger" ? "text-danger" : "text-ok"}>{msg.text}</span>}
        {busy && <span className="text-muted">Сохраняю…</span>}
        <span className="ml-auto inline-flex flex-wrap items-center gap-1">
          {editable && (
            <button type="button" className="btn-ghost btn-sm" disabled={!undo.length || !!busy} onClick={() => void undoLast()} title="Ctrl+Z">
              ↶ Отменить{undo.length ? ` (${undo.length})` : ""}
            </button>
          )}
          {editable && (
            <span className="relative">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setMenu((m) => !m)} disabled={!!busy || activePhotos.length < 2}>
                Раскладка ▾
              </button>
              {menu && (
                <div className="menu" onMouseLeave={() => setMenu(false)}>
                  {LAYOUTS.map((l) => (
                    <button key={l.key} type="button" className="menu-item" onClick={() => applyLayout(l.key)} title={l.help}>
                      <span>{l.label}</span>
                      <span className="ml-auto help">{l.help}</span>
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          <span className="inline-flex rounded-xl border border-line overflow-hidden">
            {(["s", "m", "l"] as GridSize[]).map((s) => (
              <button key={s} type="button" className={`px-2.5 py-1.5 text-[12.5px] ${size === s ? "bg-ink text-bg" : "hover:bg-ink/5"}`} onClick={() => setSize(s)} title={SIZE_LABELS[s]}>
                {s === "s" ? "▫" : s === "m" ? "◻" : "⬜"}
              </button>
            ))}
          </span>
        </span>
      </div>

      {/* В статье */}
      <section>
        <h3 className="h2 mb-2">В статье</h3>
        {state.photos.length === 0 ? (
          <p className="help">Фото пока нет — добавьте из резерва.</p>
        ) : (
          <div className={`grid gap-2 ${COLS[size]}`}>
            {state.photos.map((p, i) => {
              const small = (p.width ?? 0) < MIN_SIDE || (p.height ?? 0) < MIN_SIDE;
              // Пометки ИИ-модерации: снято ИИ (причина), добавлено ИИ (причина), предложено убрать (тест, не применено).
              const aiRemoved = p.excluded && p.excludedByAi ? (ai?.removed[p.id] ?? "снято ИИ") : null;
              const aiAdded = ai?.added[p.id] ?? null;
              const aiPropose = !p.excluded && ai && !ai.applied ? (ai.removed[p.id] ?? null) : null;
              const border = p.excluded ? "border-line opacity-50" : !p.hasDescription ? "border-danger ring-1 ring-danger/40" : dragOver === p.id ? "border-brand ring-2 ring-brand/40" : "border-line";
              return (
                <div key={p.id} className="flex flex-col gap-1">
                  <div
                    className={`relative rounded-xl overflow-hidden border bg-ink/5 group ${border} ${editable && !p.excluded ? "cursor-grab" : ""}`}
                    draggable={editable && !p.excluded}
                    onDragStart={(e) => {
                      dragId.current = p.id;
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      if (!dragId.current) return;
                      e.preventDefault();
                      if (dragOver !== p.id) setDragOver(p.id);
                    }}
                    onDragLeave={() => setDragOver((d) => (d === p.id ? null : d))}
                    onDrop={(e) => {
                      e.preventDefault();
                      onDrop(p.id);
                    }}
                    onDragEnd={() => {
                      dragId.current = null;
                      setDragOver(null);
                    }}
                    onDoubleClick={() => setZoom({ url: p.imageUrl, title: `${i + 1}. ${p.sourceDomain || ""} ${p.width ?? "?"}×${p.height ?? "?"}` })}
                    title="Двойной клик — увеличить; перетащите, чтобы поменять порядок"
                  >
                    <img src={p.thumbUrl} alt="" loading="lazy" draggable={false} className={`w-full ${aspect} object-cover ${p.excluded ? "grayscale" : ""}`} />
                    <span className="absolute top-1.5 left-1.5 inline-flex gap-1">
                      <span className="badge bg-ink/80 text-bg">{p.excluded ? (aiRemoved ? "ИИ ✕" : "снято") : i + 1}</span>
                      {aiAdded != null && !p.excluded && <span className="badge bg-ok text-white" title={aiAdded || "Добавлено ИИ из резерва"}>+ИИ</span>}
                      {aiPropose != null && <span className="badge bg-warn text-white" title={aiPropose}>ИИ: убрать?</span>}
                    </span>
                    {p.aiScore != null && <span className="absolute top-1.5 right-1.5 badge bg-surface/90">★ {Number(p.aiScore).toFixed(1)}</span>}
                    {!p.hasDescription && !p.excluded && <span className="absolute bottom-1.5 left-1.5 badge bg-danger text-white">нет описания</span>}
                    {p.person && !p.excluded && <span className="absolute bottom-1.5 right-1.5 badge bg-danger text-white" title="Интерьер и декор — без людей: ИИ-оценка увидела в кадре человека. Снимите фото.">человек</span>}
                    {editable && (
                      <div className={`absolute inset-x-0 bottom-0 flex justify-end gap-1 p-1.5 transition bg-gradient-to-t from-ink/60 to-transparent ${HOVER_REVEAL}`}>
                        {!p.excluded && (
                          <span className="mr-auto inline-flex gap-1 [@media(hover:hover)]:hidden">
                            <button type="button" className="btn-ghost btn-sm bg-surface/90" disabled={!!busy || i === 0} onClick={() => move(p.id, -1)} aria-label="Раньше">
                              ◀
                            </button>
                            <button type="button" className="btn-ghost btn-sm bg-surface/90" disabled={!!busy || i === state.photos.length - 1} onClick={() => move(p.id, 1)} aria-label="Позже">
                              ▶
                            </button>
                          </span>
                        )}
                        {p.excluded ? (
                          <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={() => act("restore", { action: "restore", photoId: p.id }, { action: "exclude", photoId: p.id })}>
                            Вернуть
                          </button>
                        ) : (
                          <>
                            <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={() => act("outdated", { action: "outdated", photoId: p.id }, { action: "restore", photoId: p.id })} title="Снять: кадр устарел (учитывается в статистике)">
                              Устарело
                            </button>
                            <button type="button" className="btn-danger btn-sm" disabled={!!busy} onClick={() => act("exclude", { action: "exclude", photoId: p.id }, { action: "restore", photoId: p.id })} title="Снять фото">
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {size !== "s" && (
                    <div className="px-0.5 text-[11px] text-muted truncate">
                      <span className={small ? "text-danger" : ""}>{p.width ?? "?"}×{p.height ?? "?"}</span>
                      {p.sourceDomain && <span> · {p.sourceDomain}</span>}
                    </div>
                  )}
                  {(aiRemoved || aiPropose || aiAdded) && (
                    <div className={`px-0.5 text-[11px] leading-tight ${aiAdded != null && !aiRemoved && !aiPropose ? "text-ok" : "text-warn"} ${size === "s" ? "line-clamp-2" : ""}`} title={aiRemoved || aiPropose || aiAdded || ""}>
                      {aiRemoved ? `ИИ снял: ${aiRemoved}` : aiPropose ? `ИИ предлагает убрать: ${aiPropose}` : `ИИ добавил${aiAdded ? `: ${aiAdded}` : ""}`}
                    </div>
                  )}
                  {renderUnderPhoto?.(p)}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Резерв */}
      {!hideReserve && (
        <section>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="h2">Резерв</h3>
            <button type="button" className={`tab ${tab === "reserve" ? "active" : ""}`} onClick={() => { setTab("reserve"); setShown(60); }}>
              Подходящие по оценке · {state.counts.reserve}
            </button>
            <button type="button" className={`tab ${tab === "rejected" ? "active" : ""}`} onClick={() => { setTab("rejected"); setShown(60); }}>
              Отклонённые оценкой · {state.counts.rejected}
            </button>
            <span className="ml-auto inline-flex gap-1">
              {(["all", "tall", "square"] as const).map((s) => (
                <button key={s} type="button" className={`btn-ghost btn-sm ${shapeFilter === s ? "bg-ink/10" : ""}`} onClick={() => setShapeFilter(s)}>
                  {s === "all" ? "Все форматы" : s === "tall" ? "Вертикальные" : "Квадратные"}
                </button>
              ))}
            </span>
          </div>
          {filtered.length === 0 ? (
            <p className="help">{tab === "reserve" ? "Резерв пуст. Нажмите «Добрать фото», чтобы найти ещё." : "Отклонённых оценкой кадров нет."}</p>
          ) : (
            <>
              <div className={`grid gap-2 ${COLS[size]}`}>
                {filtered.slice(0, shown).map((c) => (
                  <ReserveCard key={c.id} c={c} aspect={aspect} compact={size === "s"} busy={!!busy} editable={editable} aiSuggest={ai && !ai.applied ? (ai.proposedAdds[c.id] ?? null) : null} onAdd={() => act("add", { action: "add", candidateId: c.id }, (res) => { const r = res as { photoId?: string; already?: boolean } | null; return r?.photoId && !r.already ? { action: "remove", photoId: r.photoId } : null; })} onZoom={() => setZoom({ url: c.imageUrl, title: `${c.domain} ${c.width ?? "?"}×${c.height ?? "?"}${c.reason ? ` — ${c.reason}` : ""}` })} />
                ))}
              </div>
              {filtered.length > shown && (
                <div className="mt-3 text-center">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setShown((n) => n + 60)}>
                    Показать ещё ({filtered.length - shown})
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* Лайтбокс */}
      {zoom && (
        <div className="fixed inset-0 z-50 bg-ink/85 flex items-center justify-center p-4" onClick={() => setZoom(null)}>
          <div className="relative max-h-full" onClick={(e) => e.stopPropagation()}>
            <img src={zoom.url} alt="" className="max-h-[88vh] max-w-[95vw] rounded-xl object-contain" />
            <div className="mt-2 flex items-center gap-2 text-white text-[13px]">
              <span className="truncate">{zoom.title}</span>
              <button type="button" className="btn-ghost btn-sm bg-surface ml-auto" onClick={() => setZoom(null)}>
                Закрыть (Esc)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReserveCard({ c, aspect, compact, busy, editable, aiSuggest, onAdd, onZoom }: { c: ModCandidate; aspect: string; compact: boolean; busy: boolean; editable: boolean; aiSuggest: string | null; onAdd: () => void; onZoom: () => void }) {
  const small = (c.width ?? 0) < MIN_SIDE || (c.height ?? 0) < MIN_SIDE;
  return (
    <div className="flex flex-col gap-1">
      <div className="relative rounded-xl overflow-hidden border border-line bg-ink/5 group" onDoubleClick={onZoom} title={c.reason || "Двойной клик — увеличить"}>
        <img src={c.thumbUrl} alt="" loading="lazy" className={`w-full ${aspect} object-cover`} />
        {c.aiScore != null && <span className="absolute top-1.5 right-1.5 badge bg-surface/90">★ {Number(c.aiScore).toFixed(1)}</span>}
        <span className="absolute top-1.5 left-1.5 inline-flex gap-1">
          {c.status === "rejected" && <span className="badge bg-danger text-white">отклонено</span>}
          {c.person && <span className="badge bg-danger text-white" title="Интерьер и декор — без людей: в кадре человек">человек</span>}
          {aiSuggest != null && <span className="badge bg-ok text-white" title={aiSuggest || "ИИ предлагает добавить"}>ИИ: добавить?</span>}
        </span>
        {editable && (
          <button type="button" className="absolute bottom-1.5 right-1.5 btn-brand btn-sm" disabled={busy} onClick={onAdd} title="Добавить в статью">
            +
          </button>
        )}
      </div>
      {!compact && (
        <div className="px-0.5 text-[11px] text-muted leading-tight">
          <div className="truncate">
            <span className={small ? "text-danger" : ""}>{c.width ?? "?"}×{c.height ?? "?"}</span>
            {c.domain && <span> · {c.domain}</span>}
            {c.virality != null && (
              <span className={c.virality < 45 ? "text-danger" : "text-ok"} title="Pinterest-привлекательность (виральность)">
                {" "}📌 {c.virality}
              </span>
            )}
            {c.trend != null && (
              <span className={c.trend < 40 ? "text-danger" : c.trend < 55 ? "" : "text-ok"} title={`Актуальность${c.trendReason ? `: ${c.trendReason}` : ""}`}>
                {" "}✨ {c.trend}
              </span>
            )}
          </div>
          {c.reason && <div className="truncate" title={c.reason}>{c.reason}</div>}
          {aiSuggest && <div className="truncate text-ok" title={aiSuggest}>ИИ: {aiSuggest}</div>}
        </div>
      )}
    </div>
  );
}
