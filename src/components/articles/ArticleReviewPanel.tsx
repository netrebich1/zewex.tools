"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import type { ArticleReviewState, ModPhoto, PhotoModerationState } from "@/lib/articles/moderation";
import { moderationApi, PhotoModerationGrid } from "./PhotoModerationGrid";
import { ShowMore } from "@/components/ui/ShowMore";

/**
 * Модерация готовой статьи (REVIEW_PENDING; вкладка «В доработку» — NEEDS_REWORK): список слева, карточка справа.
 * Мета-поля со счётчиками (сохраняются при переходе), категория, фото с текстом секции под каждым, снять/вернуть,
 * перетаскивание (секция едет с фото), кнопки Одобрить / Одобрить и опубликовать / В доработку / Пропустить.
 * Клавиши: Enter — одобрить, S — пропустить, Backspace — назад, Esc — закрыть лайтбокс.
 * Оригинал: src/pages/ModerationPage.tsx.
 */

export type ReviewListItem = { id: string; keyword: string; keywordRu: string; siteName: string; status: string; claimedById: string | null; claimedByName: string | null; claimedFresh: boolean; note: string | null };

export const REWORK_KINDS = ["мало фото", "слабый текст", "не по теме", "ошибки в фактах", "другое"];

type Props = {
  userId: string;
  mode: "articles" | "rework";
  items: ReviewListItem[];
  initialId: string | null;
  initialState: ArticleReviewState | null;
  initialMessage?: string;
};

const LIMITS = { h1: 70, metaTitle: 60, metaDescription: 160 };

export function ArticleReviewPanel({ userId, mode, items, initialId, initialState, initialMessage }: Props) {
  const router = useRouter();
  const [list, setList] = useState(items);
  const [currentId, setCurrentId] = useState<string | null>(initialId);
  const [state, setState] = useState<ArticleReviewState | null>(initialState);
  const [gridInitial, setGridInitial] = useState<ArticleReviewState | null>(initialState);
  const [meta, setMeta] = useState(initialState?.meta ?? { h1: "", metaTitle: "", metaDescription: "", slug: "", wpCategoryId: null as number | null, publishMode: "" });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "danger" | "neutral" } | null>(initialMessage ? { text: initialMessage, tone: "neutral" } : null);
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkKind, setReworkKind] = useState(REWORK_KINDS[0]);
  const [reworkText, setReworkText] = useState("");
  const [publishNow, setPublishNow] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const workRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setPublishNow(localStorage.getItem(`art-review-publish-now:${userId}`) === "1");
    } catch {
      /* пусто */
    }
  }, [userId]);
  const togglePublishNow = (v: boolean) => {
    setPublishNow(v);
    try {
      localStorage.setItem(`art-review-publish-now:${userId}`, v ? "1" : "0");
    } catch {
      /* пусто */
    }
  };

  const saveMeta = useCallback(
    async (id: string) => {
      if (!dirty) return;
      const m = metaRef.current;
      try {
        await moderationApi({ action: "save_meta", articleId: id, fields: { h1: m.h1, metaTitle: m.metaTitle, metaDescription: m.metaDescription, slug: m.slug, wpCategoryId: m.wpCategoryId } }, mode);
        setDirty(false);
      } catch (e) {
        setMsg({ text: `Мета не сохранилась: ${e instanceof Error ? e.message : String(e)}`, tone: "danger" });
      }
    },
    [dirty, mode],
  );

  const open = useCallback(
    async (id: string, pushHistory = true) => {
      setBusy("open");
      setMsg(null);
      try {
        if (currentId) await saveMeta(currentId);
        const c = await moderationApi({ action: "claim", articleId: id }, mode);
        const res = c.result as { claimed: boolean; by?: string };
        if (!res?.claimed) {
          setMsg({ text: `Статью сейчас модерирует ${res?.by ?? "другой сотрудник"}`, tone: "neutral" });
          return;
        }
        const r = (await (await fetch(`/api/articles/moderation?article=${id}&review=1`, { cache: "no-store" })).json()) as { state?: ArticleReviewState; error?: string };
        if (!r.state) throw new Error(r.error || "Не удалось загрузить статью");
        if (pushHistory && currentId) setHistory((h) => [...h.slice(-19), currentId]);
        setCurrentId(id);
        setState(r.state);
        setGridInitial(r.state);
        setMeta(r.state.meta);
        setDirty(false);
        setReworkOpen(false);
        setList((l) => l.map((x) => (x.id === id ? { ...x, claimedById: userId, claimedByName: "вы", claimedFresh: true } : x)));
        // На телефоне список стоит над карточкой — прокручиваем к карточке, а не в начало страницы.
        if (window.matchMedia("(min-width: 1024px)").matches) window.scrollTo({ top: 0 });
        else workRef.current?.scrollIntoView({ block: "start" });
      } catch (e) {
        const err = e as Error & { stale?: boolean };
        setMsg({ text: err.message, tone: err.stale ? "neutral" : "danger" });
        if (err.stale) setList((l) => l.filter((x) => x.id !== id));
      } finally {
        setBusy(null);
      }
    },
    [currentId, saveMeta, mode, userId],
  );

  const goNext = useCallback(
    (afterId: string | null) => {
      const idx = list.findIndex((x) => x.id === afterId);
      const candidates = [...list.slice(idx + 1), ...list.slice(0, Math.max(0, idx))].filter((x) => x.id !== afterId && (!x.claimedFresh || x.claimedById === userId));
      const next = candidates[0];
      if (next) void open(next.id);
      else {
        setCurrentId(null);
        setState(null);
        router.refresh();
      }
    },
    [list, open, router, userId],
  );

  const finish = useCallback(
    async (label: string, body: Record<string, unknown>, okText: string) => {
      if (!currentId) return;
      setBusy(label);
      setMsg(null);
      try {
        await saveMeta(currentId);
        await moderationApi({ articleId: currentId, ...body }, mode);
        setMsg({ text: okText, tone: "ok" });
        const id = currentId;
        setList((l) => l.filter((x) => x.id !== id));
        setBusy(null);
        goNext(id);
      } catch (e) {
        const err = e as Error & { stale?: boolean };
        setMsg({ text: err.message, tone: err.stale ? "neutral" : "danger" });
        setBusy(null);
        if (err.stale) {
          const id = currentId;
          setList((l) => l.filter((x) => x.id !== id));
          goNext(id);
        }
      }
    },
    [currentId, saveMeta, mode, goNext],
  );

  const approve = useCallback(() => void finish("approve", { action: "review_approve", publishNow }, publishNow ? "Одобрено — публикуется с приоритетом" : "Одобрено — в очереди публикации"), [finish, publishNow]);
  const remove = useCallback(() => {
    if (!currentId || !state) return;
    if (!window.confirm(`Удалить статью «${state.article.keyword}» из системы совсем? Текст, фото и история пропадут, вернуть нельзя. Строка Google Таблицы (если есть) получит статус «удалено».`)) return;
    void finish("delete", { action: "delete" }, "Статья удалена");
  }, [currentId, state, finish]);
  const skip = useCallback(() => {
    if (!currentId) return;
    void (async () => {
      await saveMeta(currentId);
      await moderationApi({ action: "release", articleId: currentId }, mode).catch(() => {});
      setHistory((h) => [...h.slice(-19), currentId]);
      goNext(currentId);
    })();
  }, [currentId, saveMeta, mode, goNext]);
  const prev = useCallback(() => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    void open(last, false);
  }, [history, open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (!currentId || busy) return;
      if (e.key === "s" || e.key === "S" || e.key === "ы" || e.key === "Ы") {
        e.preventDefault();
        skip();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentId, busy, skip, prev]);

  const onGridState = useCallback((s: PhotoModerationState) => setState((prev) => (prev ? { ...prev, ...s } : prev)), []);
  const onStale = useCallback(
    (text: string) => {
      setMsg({ text: `${text}. Переходим к следующей.`, tone: "neutral" });
      if (currentId) {
        const id = currentId;
        setList((l) => l.filter((x) => x.id !== id));
        goNext(id);
      }
    },
    [currentId, goNext],
  );

  const sectionsByPhoto = useMemo(() => new Map((state?.sections ?? []).filter((s) => s.photoId).map((s) => [s.photoId!, s])), [state?.sections]);
  const noText = useMemo(() => (state ? state.photos.filter((p) => !p.excluded && (sectionsByPhoto.get(p.id)?.wordCount ?? 0) < 10).length : 0), [state, sectionsByPhoto]);

  const renderUnder = useCallback(
    (p: ModPhoto) => {
      const s = sectionsByPhoto.get(p.id);
      if (!s || (s.wordCount ?? 0) < 10) return <span className="badge bg-danger-soft text-danger">нет текста</span>;
      return (
        <details className="text-[12px] leading-snug">
          <summary className="cursor-pointer truncate text-ink-2" title={s.heading}>
            {s.heading || "без заголовка"} <span className="text-muted">· {s.wordCount} сл.</span>
          </summary>
          <div className="prose prose-sm mt-1 max-h-60 overflow-auto rounded-lg bg-surface-2 p-2 text-ink-2 [&_p]:mb-1.5" dangerouslySetInnerHTML={{ __html: s.html }} />
        </details>
      );
    },
    [sectionsByPhoto],
  );

  const field = (key: "h1" | "metaTitle" | "metaDescription", label: string, textarea = false) => {
    const v = meta[key] ?? "";
    const lim = LIMITS[key];
    const over = v.length > lim;
    const props = {
      className: "input",
      value: v,
      onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const v = e.target.value;
        setMeta((m) => ({ ...m, [key]: v } as typeof m));
        setDirty(true);
      },
      onBlur: () => currentId && void saveMeta(currentId),
    };
    return (
      <label className="block">
        <span className="label flex justify-between">
          <span>{label}</span>
          <span className={over ? "text-danger" : "text-muted"}>{v.length}/{lim}</span>
        </span>
        {textarea ? <textarea rows={2} {...props} /> : <input {...props} />}
      </label>
    );
  };

  const a = state?.article;
  const cur = list.find((x) => x.id === currentId);
  // Список рендерится частями (первые 30 + «Показать ещё»); выбранная статья всегда видна: порог только растёт,
  // при росте ShowMore пересоздаётся (key) с новым initial
  const listNeed = useRef(30);
  listNeed.current = Math.max(listNeed.current, list.findIndex((x) => x.id === currentId) + 1);

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      {/* Список */}
      <aside className="card p-2 max-h-56 overflow-auto lg:max-h-[80vh] lg:sticky lg:top-[4.5rem]">
        {list.length === 0 ? (
          <p className="help p-3">Статей нет.</p>
        ) : (
          <ShowMore key={listNeed.current} as="ul" className="space-y-0.5" controlsClassName="px-1 pb-1" initial={listNeed.current} step={30} noun="статей" items={list.map((x) => {
              const held = x.claimedFresh && x.claimedById && x.claimedById !== userId;
              return (
                <li key={x.id}>
                  <button type="button" className={`w-full text-left rounded-lg px-3 py-2 text-[13px] transition ${x.id === currentId ? "bg-ink text-bg" : "hover:bg-ink/5"}`} onClick={() => void open(x.id)} disabled={!!busy}>
                    <div className="truncate font-medium">{x.keyword}</div>
                    <div className={`truncate text-[11.5px] ${x.id === currentId ? "text-bg/70" : "text-muted"}`}>
                      {x.siteName}
                      {x.keywordRu ? ` · ${x.keywordRu}` : ""}
                      {held ? ` · 🔒 ${x.claimedByName}` : ""}
                    </div>
                  </button>
                </li>
              );
            })} />
        )}
      </aside>

      {/* Карточка */}
      <div ref={workRef} className="space-y-4 min-w-0 scroll-mt-16 pb-20 lg:pb-0">
        {!a || !state ? (
          <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center">
            <p className="font-medium">{list.length ? "Выберите статью в списке" : "Всё проверено"}</p>
            {msg && <p className={`mt-2 text-[13px] ${msg.tone === "danger" ? "text-danger" : "text-muted"}`}>{msg.text}</p>}
          </div>
        ) : (
          <>
            {/* Шапка закреплена только на десктопе; на телефоне главные кнопки — в нижней панели */}
            <div className="lg:sticky lg:top-14 z-20 -mx-4 px-4 py-3 bg-bg/95 backdrop-blur border-b border-line">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[17px] font-semibold uppercase tracking-wide min-w-0 [overflow-wrap:anywhere] sm:truncate">{a.keyword}</span>
                    {a.keywordRu && <span className="text-muted">🇷🇺 {a.keywordRu}</span>}
                  </div>
                  <div className="help flex flex-wrap gap-x-2">
                    <span>{a.siteName}</span>
                    <span>· фото {state.counts.active}</span>
                    {state.counts.excluded > 0 && <span className="text-warn">· снято {state.counts.excluded}</span>}
                    {noText > 0 && <span className="text-danger">· без текста {noText}</span>}
                    {mode === "rework" && (cur?.note || a.note) && <span className="text-danger">· замечание: {cur?.note || a.note}</span>}
                    <Link href={`/pinterest/articles/articles/${a.id}`} className="underline">карточка</Link>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn-ghost btn-sm max-lg:!hidden" disabled={!!busy || !history.length} onClick={prev} title="Назад (Backspace)">←</button>
                  <button type="button" className="btn-ghost btn-sm max-lg:!hidden" disabled={!!busy} onClick={skip} title="Пропустить (S)">Пропустить</button>
                  <button type="button" className="btn-ghost btn-sm text-danger" disabled={!!busy} onClick={remove} title="Удалить статью из системы совсем — если решили её не писать">Удалить</button>
                  {mode === "articles" && (
                    <button type="button" className={`btn-ghost btn-sm ${reworkOpen ? "bg-ink/10" : ""}`} disabled={!!busy} onClick={() => setReworkOpen((v) => !v)}>
                      В доработку
                    </button>
                  )}
                  <label className="inline-flex items-center gap-1.5 text-[13px]" title="После одобрения публиковать с приоритетом">
                    <input type="checkbox" checked={publishNow} onChange={(e) => togglePublishNow(e.target.checked)} /> публиковать сразу
                  </label>
                  <button type="button" className="btn-brand max-lg:!hidden" disabled={!!busy} onClick={approve} title="Enter">
                    {busy === "approve" ? "Сохраняю…" : publishNow ? "Одобрить и опубликовать" : "Одобрить"}
                  </button>
                </div>
              </div>
              {reworkOpen && (
                <div className="mt-3 card p-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <label className="block">
                    <span className="label">Причина</span>
                    <select className="input" value={reworkKind} onChange={(e) => setReworkKind(e.target.value)}>
                      {REWORK_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </label>
                  <label className="block flex-1">
                    <span className="label">Что именно (необязательно)</span>
                    <input className="input" value={reworkText} onChange={(e) => setReworkText(e.target.value)} placeholder="например: секции 3 и 7 повторяют друг друга" />
                  </label>
                  <div className="flex gap-2">
                    <button type="button" className="btn-ghost" onClick={() => setReworkOpen(false)}>Отмена</button>
                    <button type="button" className="btn-danger" disabled={!!busy} onClick={() => void finish("rework", { action: "rework", reason: [reworkKind, reworkText.trim()].filter(Boolean).join(": ") }, "Отправлено в доработку")}>
                      Отправить в доработку
                    </button>
                  </div>
                </div>
              )}
              {msg && <div className={`mt-2 text-[13px] ${msg.tone === "danger" ? "text-danger" : msg.tone === "ok" ? "text-ok" : "text-muted"}`}>{msg.text}</div>}
            </div>

            <div className="card p-4 grid gap-3 sm:grid-cols-2">
              {field("metaTitle", "SEO Title")}
              {field("h1", "H1")}
              <div className="sm:col-span-2">{field("metaDescription", "Описание (meta description)", true)}</div>
              <label className="block">
                <span className="label">Адрес (slug)</span>
                <input className="input mono" value={meta.slug} onChange={(e) => { setMeta((m) => ({ ...m, slug: e.target.value })); setDirty(true); }} onBlur={() => currentId && void saveMeta(currentId)} />
              </label>
              <label className="block">
                <span className="label">Категория на сайте</span>
                <select className="input" value={meta.wpCategoryId ?? ""} onChange={(e) => { setMeta((m) => ({ ...m, wpCategoryId: e.target.value ? Number(e.target.value) : null })); setDirty(true); }} onBlur={() => currentId && void saveMeta(currentId)}>
                  <option value="">— определить при публикации —</option>
                  {state.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              {(state.intro || state.outro) && (
                <div className="sm:col-span-2 grid gap-2 sm:grid-cols-2 text-[13px]">
                  {state.intro && (
                    <details className="rounded-xl border border-line p-2">
                      <summary className="cursor-pointer font-medium">Вступление</summary>
                      <div className="mt-1 text-ink-2 [&_p]:mb-1.5" dangerouslySetInnerHTML={{ __html: state.intro }} />
                    </details>
                  )}
                  {state.outro && (
                    <details className="rounded-xl border border-line p-2">
                      <summary className="cursor-pointer font-medium">Заключение</summary>
                      <div className="mt-1 text-ink-2 [&_p]:mb-1.5" dangerouslySetInnerHTML={{ __html: state.outro }} />
                    </details>
                  )}
                </div>
              )}
            </div>

            {gridInitial && (
              <PhotoModerationGrid key={a.id} initial={gridInitial} userKey={userId} mode={mode} onState={onGridState} onStale={onStale} onApprove={approve} renderUnderPhoto={renderUnder} hideReserve />
            )}

            {/* Телефон: главные действия внизу экрана */}
            <div className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-line bg-bg/95 p-2 pb-[max(.5rem,env(safe-area-inset-bottom))] lg:hidden">
              <button type="button" className="btn-ghost" disabled={!!busy || !history.length} onClick={prev} aria-label="Назад">
                ←
              </button>
              <button type="button" className="btn-ghost flex-1" disabled={!!busy} onClick={skip}>
                Пропустить
              </button>
              <button type="button" className="btn-brand flex-1" disabled={!!busy} onClick={approve}>
                {busy === "approve" ? "Сохраняю…" : publishNow ? "Одобрить и опубл." : "Одобрить"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
