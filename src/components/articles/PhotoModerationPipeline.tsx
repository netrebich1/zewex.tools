"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PhotoModerationState } from "@/lib/articles/moderation";
import { moderationApi, PhotoModerationGrid } from "./PhotoModerationGrid";

/**
 * Конвейер модерации фото «следующая свободная статья» (режим «фото до текста»).
 * Sticky-шапка: ключ + перевод, сайт, план, «В статье X / нужно ≥ M», кнопки Одобрить и писать / Добрать фото /
 * Мало фото (встроенная панель причины) / Пропустить; плашка решения ИИ (почему отдано людям, что снято/добавлено,
 * «Отменить правки ИИ»); ниже — PhotoModerationGrid.
 * Клавиши: Enter — одобрить (если ИИ добавил кадры или фото больше плана — сначала подтверждение, второй Enter),
 * → следующая (пропустить), ← предыдущая, Esc — закрыть лайтбокс.
 * Закрепление: пинг раз в минуту, пока страница открыта; при уходе (смена статьи, переход, закрытие вкладки) —
 * release через navigator.sendBeacon.
 */

const HEARTBEAT_MS = 60_000;

/** Снять закрепление при уходе: sendBeacon переживает закрытие вкладки (тело — JSON строкой, сервер читает req.json()). */
function releaseBeacon(articleId: string) {
  const body = JSON.stringify({ action: "release", articleId, mode: "photos" });
  try {
    if (navigator.sendBeacon?.("/api/articles/moderation", body)) return;
  } catch {
    /* ниже fetch */
  }
  void fetch("/api/articles/moderation", { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {});
}

export type ClaimInfo = { articleId: string; keyword: string; siteName: string; userId: string; userName: string };

type Props = {
  userId: string;
  siteId?: string;
  initialArticleId: string | null;
  initialState: PhotoModerationState | null;
  initialMessage?: string;
  claims: ClaimInfo[];
  minPhotos: number;
  /** Ссылка на очередь списком */
  listHref: string;
};

type Blockers = { aiBusy: number; claimedByOthers: number };

type Current = { id: string; state: PhotoModerationState };

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

export function PhotoModerationPipeline({ userId, siteId, initialArticleId, initialState, initialMessage, claims, minPhotos, listHref }: Props) {
  const [current, setCurrent] = useState<Current | null>(initialArticleId && initialState ? { id: initialArticleId, state: initialState } : null);
  const [header, setHeader] = useState<PhotoModerationState | null>(initialState);
  const [history, setHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "danger" | "neutral" } | null>(initialMessage ? { text: initialMessage, tone: "neutral" } : null);
  const [panel, setPanel] = useState<"insufficient" | "topup" | "confirm" | null>(null);
  const [reason, setReason] = useState("");
  const [empty, setEmpty] = useState(!initialArticleId);
  const [blockers, setBlockers] = useState<Blockers | null>(null);
  const skipped = useRef<Set<string>>(new Set());
  const [skippedCount, setSkippedCount] = useState(0);

  // Закрепление открытой статьи: пинг раз в минуту, release при уходе со страницы/смене статьи.
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (!currentId) return;
    const id = currentId;
    const ping = async () => {
      try {
        const r = await moderationApi({ action: "heartbeat", articleId: id });
        const res = r.result as { claimed?: boolean; by?: string } | null;
        if (res && res.claimed === false) setMsg({ text: `Статью перехватил ${res.by ?? "другой сотрудник"} — ваши правки могут пересечься. Перейдите к следующей.`, tone: "danger" });
      } catch {
        /* статья ушла дальше — увидим при следующем действии */
      }
    };
    const timer = window.setInterval(() => void ping(), HEARTBEAT_MS);
    const onHide = () => releaseBeacon(id);
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void ping();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      // Ушли со статьи внутри приложения (список, другая статья, другой раздел) — отпускаем её коллегам.
      releaseBeacon(id);
    };
  }, [currentId]);

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
      const r = (await (await fetch(`/api/articles/moderation?${u}`, { cache: "no-store" })).json()) as { articleId: string | null; state: PhotoModerationState | null; blockers?: Blockers | null; error?: string };
      if (r.error) throw new Error(r.error);
      if (!r.articleId || !r.state) {
        setCurrent(null);
        setHeader(null);
        setEmpty(true);
        setBlockers(r.blockers ?? null);
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

  /** Почему перед одобрением нужно подтверждение: ИИ добавил кадры или фото больше плана. */
  const confirmWhy = useMemo(() => {
    if (!header) return null;
    const why: string[] = [];
    const aiAdded = header.ai?.applied ? Object.keys(header.ai.added).length : 0;
    if (aiAdded > 0) why.push(`ИИ добавил ${aiAdded} ${plural(aiAdded, "кадр", "кадра", "кадров")} из резерва`);
    if (header.article.photoCount > 0 && header.counts.active > header.article.photoCount) why.push(`в статье ${header.counts.active} фото при плане ${header.article.photoCount}`);
    return why.length ? why.join(", ") : null;
  }, [header]);

  const approve = useCallback(() => {
    if (!current || !header) return;
    if (!header.counts.canApprove) {
      setMsg({ text: `Нужно ещё ${header.counts.missing} фото: в статье ${header.counts.active}, нужно не меньше ${header.counts.needMin}. Добавьте из резерва или нажмите «Добрать фото».`, tone: "danger" });
      return;
    }
    if (confirmWhy && panel !== "confirm") {
      setPanel("confirm");
      return;
    }
    void finish("approve", { action: "approve" }, "Фото одобрены — статья ушла на написание");
  }, [current, header, finish, confirmWhy, panel]);

  const undoAi = useCallback(async () => {
    if (!current) return;
    if (!window.confirm("Отменить все правки ИИ? Снятые ИИ кадры вернутся, добавленные ИИ — уберутся, порядок станет как до проверки. Ваши правки после ИИ сохранятся, кадры, добавленные вами, останутся в конце.")) return;
    setBusy("undo_ai");
    setMsg(null);
    try {
      const r = await moderationApi({ action: "undo_ai", articleId: current.id });
      const res = r.result as { message?: string } | null;
      if (r.state) show(current.id, r.state);
      setMsg({ text: res?.message ?? "Правки ИИ отменены", tone: "ok" });
    } catch (e) {
      const err = e as Error & { stale?: boolean };
      setMsg({ text: err.message, tone: err.stale ? "neutral" : "danger" });
    } finally {
      setBusy(null);
    }
  }, [current, show]);

  const skip = useCallback(() => {
    if (!current) return;
    skipped.current.add(current.id);
    setSkippedCount(skipped.current.size);
    void finish("skip", { action: "skip" }, "Пропущено");
  }, [current, finish]);

  const prev = useCallback(() => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    void open(last);
  }, [history, open]);

  /** Пустой конвейер, но есть пропущенные вами — вернуться к ним (сбросить список пропущенных в этой вкладке). */
  const backToSkipped = useCallback(() => {
    skipped.current = new Set();
    setSkippedCount(0);
    void loadNext();
  }, [loadNext]);

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
              <Link href={listHref} className="btn-ghost btn-sm" title="Очередь списком (статья освободится для коллег)">
                Список
              </Link>
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
              <button type="button" className="btn-brand" disabled={!!busy || !counts.canApprove} onClick={approve} title={counts.canApprove ? (confirmWhy ? `Enter — сначала подтверждение: ${confirmWhy}` : "Enter") : `Нужно ещё ${counts.missing} фото`}>
                {busy === "approve" ? "Сохраняю…" : "Одобрить и писать"}
              </button>
            </div>
          </div>
        ) : (
          <div className="help">{busy === "next" ? "Ищу следующую статью…" : empty ? "Свободных статей на модерации фото нет." : ""}</div>
        )}
        {a && counts && header?.ai && <AiBanner ai={header.ai} active={counts.active} plan={a.photoCount} busy={!!busy} onUndo={() => void undoAi()} />}
        {panel === "confirm" && a && counts && (
          <div className="mt-3 card p-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <p className="flex-1 text-[14px]">
              Проверьте перед одобрением: {confirmWhy}. Одобрить {counts.active} фото и отправить писать текст?
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost" onClick={() => setPanel(null)}>
                Отмена
              </button>
              <button type="button" className="btn-brand" disabled={!!busy} onClick={approve} title="Enter">
                Да, одобрить
              </button>
            </div>
          </div>
        )}
        {panel && panel !== "confirm" && a && (
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
          <p className="font-medium">{skippedCount || blockers?.aiBusy || blockers?.claimedByOthers ? "Свободных статей сейчас нет" : "Всё проверено"}</p>
          <p className="help mt-1">{siteId ? "По этому сайту свободных статей на модерации фото нет." : "Свободных статей на модерации фото нет."}</p>
          {(skippedCount > 0 || !!blockers?.aiBusy || !!blockers?.claimedByOthers) && (
            <ul className="help mt-2 space-y-0.5">
              {skippedCount > 0 && <li>Вы пропустили: {skippedCount}</li>}
              {!!blockers?.aiBusy && <li>Сейчас проверяет ИИ: {blockers.aiBusy} — появятся после решения</li>}
              {!!blockers?.claimedByOthers && <li>Открыты у коллег: {blockers.claimedByOthers}</li>}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {skippedCount > 0 && (
              <button type="button" className="btn-brand" onClick={backToSkipped} disabled={!!busy}>
                Вернуться к пропущенным ({skippedCount})
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={() => void loadNext()} disabled={!!busy}>
              Проверить ещё раз
            </button>
            <Link href={listHref} className="btn-ghost">
              К списку
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Плашка решения ИИ в шапке: почему отдано людям, уверенность, что снято/добавлено, норма и сколько сейчас. */
function AiBanner({ ai, active, plan, busy, onUndo }: { ai: NonNullable<PhotoModerationState["ai"]>; active: number; plan: number; busy: boolean; onUndo: () => void }) {
  const norm = ai.norm || plan;
  const over = norm > 0 && active > norm;
  const tone = ai.status === "failed" ? "border-danger/25 bg-danger-soft" : "border-warn/25 bg-warn-soft";
  // Сводка ИИ начинается с «Итог: …» и «Людям: …» — это уже есть в цифрах и причинах, показываем только мнение модели.
  const title =
    ai.status === "sent_to_human"
      ? `Проверено ИИ: отдано людям${ai.reasons.length ? ` — ${ai.reasons.join("; ")}` : ""}${ai.decision === "approve" ? " (ИИ за одобрение, но не уверен)" : ""}`
      : ai.note;
  const opinion = ai.summary.replace(/^Итог:[^.]*\.\s*/, "").replace(/^Людям:[^.]*\.\s*/, "").trim();
  return (
    <div className={`mt-3 rounded-xl border px-3.5 py-2.5 text-[13.5px] ${tone}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-semibold text-ink">
            {title}
          </div>
          <div className="text-ink-2 flex flex-wrap gap-x-3 gap-y-0.5">
            {ai.confidence != null && <span>уверенность {ai.confidence}</span>}
            <span>{ai.applied ? "убрано" : "предлагает убрать"} {ai.removedCount}</span>
            <span>{ai.applied ? "добавлено" : "предлагает добавить"} {ai.addedCount}</span>
            {norm > 0 && <span>норма {norm}</span>}
            <span className={over ? "text-warn font-semibold" : ""}>
              сейчас {active}
              {over ? ` — больше нормы на ${active - norm}` : ""}
            </span>
          </div>
          {opinion && <div className="text-ink-2">{opinion}</div>}
        </div>
        {ai.canUndo && (
          <button type="button" className="btn-ghost btn-sm shrink-0 bg-surface" disabled={busy} onClick={onUndo} title="Вернуть снятые ИИ кадры, убрать добавленные ИИ, порядок как до проверки">
            Отменить правки ИИ
          </button>
        )}
      </div>
    </div>
  );
}
