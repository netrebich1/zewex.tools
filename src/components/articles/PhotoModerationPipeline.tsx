"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PhotoModerationState } from "@/lib/articles/moderation";
import { moderationApi, PhotoModerationGrid } from "./PhotoModerationGrid";

/**
 * Конвейер модерации фото «следующая свободная статья» (режим «фото до текста»).
 * Sticky-шапка: ключ + перевод, сайт, план, «В статье X / нужно ≥ M», кнопки Одобрить и писать / Добрать фото /
 * Мало фото (встроенная панель причины) / Пропустить; ниже — PhotoModerationGrid.
 * Клавиши: Enter — одобрить, → следующая (пропустить), ← предыдущая, Esc — закрыть лайтбокс.
 */

export type ClaimInfo = { articleId: string; keyword: string; siteName: string; userId: string; userName: string };

type Props = {
  userId: string;
  siteId?: string;
  initialArticleId: string | null;
  initialState: PhotoModerationState | null;
  initialMessage?: string;
  claims: ClaimInfo[];
  minPhotos: number;
};

type Current = { id: string; state: PhotoModerationState };

export function PhotoModerationPipeline({ userId, siteId, initialArticleId, initialState, initialMessage, claims, minPhotos }: Props) {
  const [current, setCurrent] = useState<Current | null>(initialArticleId && initialState ? { id: initialArticleId, state: initialState } : null);
  const [header, setHeader] = useState<PhotoModerationState | null>(initialState);
  const [history, setHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "danger" | "neutral" } | null>(initialMessage ? { text: initialMessage, tone: "neutral" } : null);
  const [panel, setPanel] = useState<"insufficient" | "topup" | null>(null);
  const [reason, setReason] = useState("");
  const [empty, setEmpty] = useState(!initialArticleId);
  const skipped = useRef<Set<string>>(new Set());

  const show = useCallback((id: string, state: PhotoModerationState) => {
    setCurrent({ id, state });
    setHeader(state);
    setPanel(null);
    setReason("");
    setEmpty(false);
    window.scrollTo({ top: 0 });
  }, []);

  const loadNext = useCallback(async () => {
    setBusy("next");
    try {
      const u = new URLSearchParams({ next: "1", mode: "photos" });
      if (siteId) u.set("site", siteId);
      if (skipped.current.size) u.set("exclude", [...skipped.current].join(","));
      const r = (await (await fetch(`/api/articles/moderation?${u}`, { cache: "no-store" })).json()) as { articleId: string | null; state: PhotoModerationState | null; error?: string };
      if (r.error) throw new Error(r.error);
      if (!r.articleId || !r.state) {
        setCurrent(null);
        setHeader(null);
        setEmpty(true);
        return;
      }
      show(r.articleId, r.state);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }, [siteId, show]);

  const open = useCallback(
    async (id: string) => {
      setBusy("open");
      try {
        const c = await moderationApi({ action: "claim", articleId: id });
        const res = c.result as { claimed: boolean; by?: string };
        if (!res?.claimed) {
          setMsg({ text: `Статью сейчас модерирует ${res?.by ?? "другой сотрудник"}`, tone: "neutral" });
          return;
        }
        const r = (await (await fetch(`/api/articles/moderation?article=${id}`, { cache: "no-store" })).json()) as { state?: PhotoModerationState; error?: string };
        if (!r.state) throw new Error(r.error || "Не удалось загрузить статью");
        show(id, r.state);
      } catch (e) {
        setMsg({ text: e instanceof Error ? e.message : String(e), tone: "danger" });
      } finally {
        setBusy(null);
      }
    },
    [show],
  );

  const finish = useCallback(
    async (label: string, body: Record<string, unknown>, okText: string) => {
      if (!current) return;
      setBusy(label);
      setMsg(null);
      try {
        await moderationApi({ articleId: current.id, ...body });
        setMsg({ text: okText, tone: "ok" });
        setHistory((h) => [...h.slice(-19), current.id]);
        await loadNext();
      } catch (e) {
        const err = e as Error & { stale?: boolean };
        setMsg({ text: err.message, tone: err.stale ? "neutral" : "danger" });
        if (err.stale) await loadNext();
      } finally {
        setBusy(null);
      }
    },
    [current, loadNext],
  );

  const approve = useCallback(() => {
    if (!current || !header) return;
    if (!header.counts.canApprove) {
      setMsg({ text: `Нужно ещё ${header.counts.missing} фото: в статье ${header.counts.active}, нужно не меньше ${header.counts.needMin}. Добавьте из резерва или нажмите «Добрать фото».`, tone: "danger" });
      return;
    }
    void finish("approve", { action: "approve" }, "Фото одобрены — статья ушла на написание");
  }, [current, header, finish]);

  const skip = useCallback(() => {
    if (!current) return;
    skipped.current.add(current.id);
    void finish("skip", { action: "skip" }, "Пропущено");
  }, [current, finish]);

  const prev = useCallback(() => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    void open(last);
  }, [history, open]);

  const onStale = useCallback(
    (text: string) => {
      setMsg({ text: `${text}. Переходим к следующей.`, tone: "neutral" });
      void loadNext();
    },
    [loadNext],
  );

  // Пустое состояние при первом заходе без статьи — попробовать загрузить
  useEffect(() => {
    if (!initialArticleId && !initialMessage) void loadNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const others = claims.filter((c) => c.userId !== userId);
  const a = header?.article;
  const counts = header?.counts;

  return (
    <div className="space-y-4">
      {/* Sticky-шапка статьи */}
      <div className="sticky top-0 z-20 -mx-4 px-4 py-3 bg-bg/95 backdrop-blur border-b border-line">
        {a && counts ? (
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[17px] font-semibold uppercase tracking-wide truncate">{a.keyword}</span>
                {a.keywordRu && <span className="text-muted">🇷🇺 {a.keywordRu}</span>}
              </div>
              <div className="help flex flex-wrap items-center gap-x-2">
                <span>{a.siteName}</span>
                <span>· план {a.photoCount} фото</span>
                <span className={counts.canApprove ? "text-ok font-semibold" : "text-danger font-semibold"} title={`Одобрить можно, когда фото не меньше ${minPhotos} или не меньше плана статьи (${a.photoCount}).`}>
                  · В статье {counts.active} / нужно ≥ {counts.needMin}
                </span>
                {a.trend && (
                  <details className="inline">
                    <summary className="cursor-pointer underline">тренды</summary>
                    <span className="block mt-1">
                      {a.trend.in.length > 0 && <span className="text-ok">Модно: {a.trend.in.join(", ")}. </span>}
                      {a.trend.out.length > 0 && <span className="text-danger">Устарело: {a.trend.out.join(", ")}.</span>}
                    </span>
                  </details>
                )}
                {a.error && <span className="text-danger">· {a.error}</span>}
                <Link href={`/pinterest/articles/articles/${a.id}`} className="underline">карточка</Link>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-ghost btn-sm" disabled={!!busy || !history.length} onClick={prev} title="Предыдущая (←)">
                ←
              </button>
              <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={skip} title="Пропустить: статья уйдёт в конец вашей очереди (→)">
                Пропустить
              </button>
              <button type="button" className={`btn-ghost btn-sm ${panel === "insufficient" ? "bg-ink/10" : ""}`} disabled={!!busy} onClick={() => setPanel((p) => (p === "insufficient" ? null : "insufficient"))} title="Подходящих кадров не хватает — статья уйдёт в список «Мало фото»">
                Мало фото
              </button>
              <button type="button" className={`btn-ghost btn-sm ${panel === "topup" ? "bg-ink/10" : ""}`} disabled={!!busy} onClick={() => setPanel((p) => (p === "topup" ? null : "topup"))} title="Новый поиск: статья вернётся на модерацию с пополненным резервом">
                Добрать фото
              </button>
              <button type="button" className="btn-brand" disabled={!!busy || !counts.canApprove} onClick={approve} title={counts.canApprove ? "Enter" : `Нужно ещё ${counts.missing} фото`}>
                {busy === "approve" ? "Сохраняю…" : "Одобрить и писать"}
              </button>
            </div>
          </div>
        ) : (
          <div className="help">{busy === "next" ? "Ищу следующую статью…" : empty ? "Свободных статей на модерации фото нет." : ""}</div>
        )}
        {panel && a && (
          <div className="mt-3 card p-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="block flex-1">
              <span className="label">{panel === "insufficient" ? "Почему мало фото (видно в списке «Мало фото»)" : "Что искать дополнительно (необязательно)"}</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={panel === "insufficient" ? "например: в выдаче только каталоги магазинов" : "например: больше уличных кадров"} autoFocus />
            </label>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost" onClick={() => setPanel(null)}>
                Отмена
              </button>
              {panel === "insufficient" ? (
                <button type="button" className="btn-danger" disabled={!!busy} onClick={() => void finish("insufficient", { action: "insufficient", reason }, "Отмечено «Мало фото»")}>
                  Отметить «Мало фото»
                </button>
              ) : (
                <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void finish("topup", { action: "topup", reason }, "Статья ушла добирать фото")}>
                  Добрать
                </button>
              )}
            </div>
          </div>
        )}
        {msg && <div className={`mt-2 text-[13px] ${msg.tone === "danger" ? "text-danger" : msg.tone === "ok" ? "text-ok" : "text-muted"}`}>{msg.text}</div>}
      </div>

      {others.length > 0 && (
        <p className="help">
          Сейчас модерируют: {others.map((c) => `${c.userName} — «${c.keyword}» (${c.siteName})`).join("; ")}
        </p>
      )}

      {current ? (
        <PhotoModerationGrid key={current.id} initial={current.state} userKey={userId} mode="photos" onState={setHeader} onStale={onStale} onApprove={approve} onNext={skip} onPrev={prev} />
      ) : empty ? (
        <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center">
          <p className="font-medium">Всё проверено</p>
          <p className="help mt-1">{siteId ? "По этому сайту статей на модерации фото нет." : "Статей на модерации фото нет."}</p>
          <button type="button" className="btn-ghost mt-4" onClick={() => void loadNext()} disabled={!!busy}>
            Проверить ещё раз
          </button>
        </div>
      ) : null}
    </div>
  );
}
