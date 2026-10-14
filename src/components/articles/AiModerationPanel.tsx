"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Badge, Card, Empty } from "@/components/ui";
import type { AiOverview, AiResultRow, AiRunRow, InsufficientRow } from "@/lib/articles/aiModeration";

/**
 * Экран ИИ-модерации фото (оригинал: src/pages/AiModerationPage.tsx). Вкладка «Результаты»: карточка «Новый запуск»
 * (сайт, статей 10/50/200/Все/число, режим Тест/Авто, оценка цены), карточка «Запуски» (8 последних, Стоп), фильтры
 * решение/статус/запуск/сайт, сводка, массовые действия над отмеченными proposed, таблица решений, диалог решения
 * с миниатюрами «Итог / Удалено / Добавлено». Вкладка «Мало фото»: сводки по дням/сайтам/кто отметил, таблица статей
 * с действиями Добрать фото / На модерацию / Закрыть. Обновление: 8 с при бегущем запуске, иначе 30 с.
 */

const DECISION: Record<string, { label: string; tone: "ok" | "danger" | "warn" | "neutral" }> = {
  approve: { label: "Одобрить", tone: "ok" },
  insufficient: { label: "Мало фото", tone: "danger" },
  human: { label: "Человеку", tone: "warn" },
};
const STATUS: Record<string, string> = {
  proposed: "Ждёт решения",
  applied: "Применено",
  sent_to_human: "Отдано людям",
  excluded: "Исключено",
  failed: "Не применено",
  processing: "Проверяется…",
  applying: "Применяется…",
  superseded: "Перепроверено",
};
const RUN_STATUS: Record<string, { label: string; tone: "brand" | "ok" | "neutral" | "danger" }> = {
  running: { label: "идёт", tone: "brand" },
  done: { label: "готово", tone: "ok" },
  stopped: { label: "остановлен", tone: "neutral" },
  failed: { label: "сбой", tone: "danger" },
};

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const day = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
const usd = (v: number) => `$${v.toFixed(v < 0.1 ? 3 : 2)}`;

type ApiResp = { ok?: boolean; error?: string; count?: number; runId?: string; status?: string; stale?: boolean };

async function api(body: Record<string, unknown>): Promise<ApiResp> {
  const res = await fetch("/api/articles/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as ApiResp;
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

export function AiModerationPanel({ initial }: { initial: AiOverview }) {
  const [data, setData] = useState<AiOverview>(initial);
  const [tab, setTab] = useState<"results" | "insufficient">("results");
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "danger" | "neutral" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const res = await fetch("/api/articles/ai", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setData((await res.json()) as AiOverview);
    } catch {
      setMsg({ text: "Нет связи с сервером, показаны последние данные", tone: "danger" });
    }
  }, []);

  const anyRunning = data.runs.some((r) => r.status === "running");
  useEffect(() => {
    const t = setInterval(refresh, anyRunning ? 8_000 : 30_000);
    return () => clearInterval(t);
  }, [refresh, anyRunning]);

  useEffect(() => {
    if (!msg || msg.tone === "danger") return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  /** Действие с блокировкой и перезагрузкой данных. */
  const act = useCallback(async (key: string, body: Record<string, unknown>, okText: (r: ApiResp) => string) => {
    busyRef.current = true;
    setBusy(key);
    try {
      const r = await api(body);
      setMsg({ text: okText(r), tone: "ok" });
      return r;
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), tone: "danger" });
      return null;
    } finally {
      busyRef.current = false;
      setBusy(null);
      void refresh();
    }
  }, [refresh]);

  return (
    <div className="space-y-4">
      {!data.aiModMaster && <Alert tone="warn">ИИ-проверка фото выключена мастер-выключателем на экране «Автозапуск» — запуски не стартуют, пока его не включат.</Alert>}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={`tab ${tab === "results" ? "active" : ""}`} onClick={() => setTab("results")}>Результаты · {data.results.length}</button>
        <button type="button" className={`tab ${tab === "insufficient" ? "active" : ""}`} onClick={() => setTab("insufficient")}>Мало фото · {data.insufficient.length}</button>
        <span className="help ml-auto">Обновлено {new Date(data.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
        <button type="button" className="btn-ghost btn-sm" onClick={() => void refresh()}>Обновить</button>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {tab === "results" ? <ResultsTab data={data} busy={busy} act={act} notify={(text, tone) => setMsg({ text, tone })} /> : <InsufficientTab rows={data.insufficient} busy={busy} act={act} />}
    </div>
  );
}

type Act = (key: string, body: Record<string, unknown>, okText: (r: ApiResp) => string) => Promise<ApiResp | null>;

/* ───────────────────────── Вкладка «Результаты» ───────────────────────── */

function ResultsTab({ data, busy, act, notify }: { data: AiOverview; busy: string | null; act: Act; notify: (text: string, tone: "ok" | "danger") => void }) {
  const [siteId, setSiteId] = useState(data.sites.find((s) => s.waiting > 0)?.id ?? data.sites[0]?.id ?? "");
  const [limit, setLimit] = useState(10);
  const [mode, setMode] = useState<"auto" | "test">("auto");
  const [fDecision, setFDecision] = useState("all");
  const [fStatus, setFStatus] = useState("all");
  const [fRun, setFRun] = useState("all");
  const [fSite, setFSite] = useState("all");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<AiResultRow | null>(null);

  const site = data.sites.find((s) => s.id === siteId);
  const waiting = site?.untouched ?? 0;
  const siteName = useMemo(() => new Map(data.sites.map((s) => [s.id, s.name])), [data.sites]);

  const start = () =>
    act("start", { action: "start", siteId, limit, mode }, (r) => `Запущено: ${r.count ?? 0} статей${mode === "test" ? " (тест — только предложения)" : ""}`);
  const stop = (id: string) => act(`stop:${id}`, { action: "stop", runId: id }, () => "Запуск остановлен");

  /** По одной статье за запрос: одобрение скачивает фото и может идти долго (как в оригинале). */
  const resolve = async (ids: string[], op: string) => {
    if (!ids.length) return;
    let ok = 0, fail = 0;
    for (const id of ids) {
      const r = await act(`resolve:${id}`, { action: "resolve", resultId: id, op }, (x) => (x.error ? `Не применено: ${x.error}` : `${STATUS[String(x.status)] ?? x.status}`));
      if (r && !r.error) ok++; else fail++;
    }
    if (ids.length > 1) notify(fail ? `Готово: ${ok}, не удалось: ${fail}` : `Готово: ${ok}`, fail ? "danger" : "ok");
    setSel(new Set());
    setOpen(null);
  };
  const rerun = async (ids: string[]) => {
    if (!ids.length) return;
    await act("rerun", { action: "rerun", resultIds: ids }, (r) => `Перепроверка запущена: ${r.count ?? 0}`);
    setSel(new Set());
    setOpen(null);
  };

  const shown = data.results.filter((r) => (fDecision === "all" || (fDecision === "none" ? !r.decision : r.decision === fDecision)) && (fStatus === "all" || r.status === fStatus) && (fRun === "all" || r.runId === fRun) && (fSite === "all" || r.siteId === fSite));
  const selectable = shown.filter((r) => r.status === "proposed");
  const stats = useMemo(() => {
    const s = { total: data.results.length, approve: 0, insufficient: 0, human: 0, cost: 0 };
    for (const r of data.results) {
      if (r.decision === "approve") s.approve++;
      else if (r.decision === "insufficient") s.insufficient++;
      else if (r.decision === "human") s.human++;
      s.cost += r.costUsd;
    }
    return s;
  }, [data.results]);

  const estimate = Math.min(limit, waiting || limit);

  return (
    <div className="space-y-4">
      <Card title="Новый запуск" description="Берутся свободные статьи «Ждут проверки фото» этого сайта, которые ИИ ещё не проверял. Статьи закрепляются за запуском — сотрудники их не увидят до решения.">
        <div className="flex flex-wrap items-end gap-4">
          <label className="block min-w-56">
            <span className="label">Сайт</span>
            <select className="input" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              {!data.sites.length && <option value="">— сайтов нет —</option>}
              {data.sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name} · ждут {s.untouched}{s.running ? " · идёт проверка" : ""}</option>
              ))}
            </select>
          </label>
          <div className="block">
            <span className="label">Статей</span>
            <div className="flex flex-wrap items-center gap-1">
              {[10, 50, 200].map((n) => (
                <button key={n} type="button" className={`btn-ghost btn-sm ${limit === n ? "!bg-ink !text-bg" : ""}`} onClick={() => setLimit(n)}>{n}</button>
              ))}
              <button type="button" className={`btn-ghost btn-sm ${waiting && limit === waiting ? "!bg-ink !text-bg" : ""}`} disabled={!waiting} onClick={() => setLimit(Math.min(5000, waiting))}>Все{waiting ? ` (${waiting})` : ""}</button>
              <input type="number" className="input !w-24" min={1} max={5000} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))} />
            </div>
          </div>
          <div className="block">
            <span className="label">Режим</span>
            <div className="flex gap-1">
              <button type="button" className={`btn-ghost btn-sm ${mode === "test" ? "!bg-ink !text-bg" : ""}`} onClick={() => setMode("test")} title="ИИ только предлагает — решаете вы">Тест</button>
              <button type="button" className={`btn-ghost btn-sm ${mode === "auto" ? "!bg-ink !text-bg" : ""}`} onClick={() => setMode("auto")} title="Уверенные решения применяются сразу, сомнительные — людям">Авто</button>
            </div>
          </div>
          <div className="help max-w-sm">
            {site && <><b className="text-ink">Ждут проверки: {site.untouched}</b> из {site.waiting} на модерации. </>}
            Примерно {usd(estimate * 0.03)}–{usd(estimate * 0.08)}.
            <br />
            {mode === "test" ? "Тест: ИИ только предлагает, решаете вы." : site && !site.settings.autoApply ? "Авто, но у сайта выключено «применять автоматически» — предложения будут ждать решения." : "Авто: уверенные решения применяются сразу, сомнительные — людям."}
          </div>
          <button type="button" className="btn-primary" disabled={!!busy || !siteId || !data.aiModMaster} onClick={() => void start()}>{busy === "start" ? "Запускаем…" : "Запустить"}</button>
        </div>
      </Card>

      {data.runs.length > 0 && (
        <Card title="Запуски" description="8 последних. «Промодерировано X из Y» — сколько статей уже получили решение ИИ; $ — стоимость вызовов моделей.">
          <ul className="space-y-1.5 text-[13.5px]">
            {data.runs.slice(0, 8).map((r) => <RunLine key={r.id} r={r} canSeeCosts={data.canSeeCosts} busy={busy} onStop={() => void stop(r.id)} />)}
          </ul>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
        <span>Всего {stats.total} · одобрить {stats.approve} · мало фото {stats.insufficient} · людям {stats.human}{data.canSeeCosts ? ` · ${usd(stats.cost)}` : ""}</span>
        <select className="input !w-auto !py-1.5" value={fDecision} onChange={(e) => setFDecision(e.target.value)}>
          <option value="all">Все решения</option>
          {Object.entries(DECISION).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          <option value="none">Без решения (пропуск/ошибка)</option>
        </select>
        <select className="input !w-auto !py-1.5" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="all">Любой статус</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input !w-auto !py-1.5" value={fRun} onChange={(e) => setFRun(e.target.value)}>
          <option value="all">Все запуски</option>
          {data.runs.map((r) => <option key={r.id} value={r.id}>{fmt(r.createdAt)} · {r.siteName}</option>)}
        </select>
        {data.sites.length > 1 && (
          <select className="input !w-auto !py-1.5" value={fSite} onChange={(e) => setFSite(e.target.value)}>
            <option value="all">Все сайты</option>
            {data.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      {sel.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2/60 px-3 py-2 text-[13.5px]">
          <span>Отмечено {sel.size}:</span>
          <button type="button" className="btn-primary btn-sm" disabled={!!busy} onClick={() => void resolve([...sel], "approve")}>Одобрить</button>
          <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={() => void resolve([...sel], "human")}>Отправить человеку</button>
          <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={() => void resolve([...sel], "insufficient")}>Мало фото</button>
          <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={() => void resolve([...sel], "exclude")}>Исключить</button>
          <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={() => void rerun([...sel])}>Перепроверить</button>
          <button type="button" className="btn-ghost btn-sm ml-auto" onClick={() => setSel(new Set())}>Снять отметки</button>
        </div>
      )}

      <div className="card table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="w-8">
                <input type="checkbox" aria-label="Отметить все ждущие решения" checked={selectable.length > 0 && selectable.every((r) => sel.has(r.id))} disabled={!selectable.length} onChange={(e) => setSel(e.target.checked ? new Set(selectable.map((r) => r.id)) : new Set())} />
              </th>
              <th>Ключ</th><th>Сайт</th><th>Решение ИИ</th><th>Уверенность</th><th>Фото</th><th>−/+</th><th>Причина</th><th>Статус</th>{data.canSeeCosts && <th>$</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const d = r.decision ? DECISION[r.decision] : null;
              return (
                <tr key={r.id} className="cursor-pointer" onClick={() => setOpen(r)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label="Отметить" disabled={r.status !== "proposed"} checked={sel.has(r.id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                  </td>
                  <td className="font-medium max-w-xs">
                    <span className="block truncate" title={r.keyword}>{r.keyword}</span>
                    {r.runMode === "test" && <span className="text-[11px] text-muted">тест</span>}
                  </td>
                  <td className="whitespace-nowrap">{r.siteName}</td>
                  <td>{d ? <Badge tone={d.tone}>{d.label}</Badge> : <Badge tone="neutral">{r.status === "failed" ? "Ошибка" : r.status === "processing" ? "…" : "Пропущено"}</Badge>}</td>
                  <td className="tabular-nums">{r.confidence ?? "—"}</td>
                  <td className="tabular-nums whitespace-nowrap">{r.photosBefore} → {r.photosAfter}</td>
                  <td className="tabular-nums whitespace-nowrap">−{r.removed.length} / +{r.added.length}</td>
                  <td className="max-w-md text-muted"><span className="line-clamp-2" title={r.error || r.summary || ""}>{r.error || r.summary || "—"}</span></td>
                  <td className="whitespace-nowrap">{STATUS[r.status] ?? r.status}</td>
                  {data.canSeeCosts && <td className="tabular-nums text-muted">{r.costUsd ? usd(r.costUsd) : "—"}</td>}
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={10} className="p-6 text-center help">Нет результатов</td></tr>}
          </tbody>
        </table>
      </div>

      {open && <ResultDialog r={open} canSeeCosts={data.canSeeCosts} busy={busy} onClose={() => setOpen(null)} onResolve={(op) => void resolve([open.id], op)} onRerun={() => void rerun([open.id])} siteName={siteName} />}
    </div>
  );
}

function RunLine({ r, canSeeCosts, busy, onStop }: { r: AiRunRow; canSeeCosts: boolean; busy: string | null; onStop: () => void }) {
  const st = RUN_STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
  const stale = r.status === "running" && r.heartbeatAt && Date.now() - new Date(r.heartbeatAt).getTime() > 3 * 60_000;
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="text-muted tabular-nums">{fmt(r.createdAt)}</span>
      <span className="font-medium">{r.siteName}</span>
      <Badge tone="neutral">{r.mode === "auto" ? "Авто" : "Тест"}{r.source === "auto" ? " · автозапуск" : ""}</Badge>
      <span>Промодерировано <b className="tabular-nums">{r.processed}</b> из <b className="tabular-nums">{r.total}</b>{r.applied ? <span className="text-muted"> · применено {r.applied}</span> : null}</span>
      {canSeeCosts && <span className="text-muted tabular-nums">{usd(r.costUsd)}</span>}
      <Badge tone={st.tone}>{st.label}</Badge>
      {stale && <span className="text-[12px] text-danger" title="Воркер не обновлял heartbeat больше 3 минут — проверьте службу zewex-worker">воркер молчит</span>}
      {r.startedBy && <span className="text-[12px] text-muted">запустил: {r.startedBy}</span>}
      {r.error && <span className="text-[12px] text-danger">{r.error}</span>}
      {r.status === "running" && <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={onStop}>Стоп</button>}
    </li>
  );
}

/* ───────────────────────── Диалог решения ───────────────────────── */

function ResultDialog({ r, canSeeCosts, busy, onClose, onResolve, onRerun, siteName }: { r: AiResultRow; canSeeCosts: boolean; busy: string | null; onClose: () => void; onResolve: (op: string) => void; onRerun: () => void; siteName: Map<string, string> }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const d = r.decision ? DECISION[r.decision] : null;
  const sc = r.review?.scores ?? null;
  const addedBy = new Map(r.added.map((a) => [a.candidateId, a]));
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:p-8" onClick={onClose} role="dialog" aria-modal="true">
      <div className="card w-full max-w-6xl p-5 space-y-4 text-[14px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="h2">
              <Link href={`/pinterest/articles/articles/${r.articleId}`} className="hover:underline">{r.keyword}</Link>
              {d && <> · <Badge tone={d.tone}>{d.label}</Badge></>} · уверенность {r.confidence ?? "—"}
            </h2>
            <p className="help mt-0.5">{siteName.get(r.siteId) ?? r.siteName} · {fmt(r.createdAt)} · {r.runMode === "test" ? "тестовый запуск" : "авто"}{canSeeCosts && r.costUsd ? ` · ${usd(r.costUsd)}` : ""}{r.review?.model ? ` · ${r.review.model}` : ""}</p>
          </div>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>Закрыть (Esc)</button>
        </div>
        {r.summary && <p>{r.summary}</p>}
        {r.error && <Alert tone="danger">{r.error}</Alert>}
        <div className="flex flex-wrap gap-2">
          {sc && <>
            <Badge tone="neutral">Ключ: {sc.relevance ?? "—"}</Badge>
            <Badge tone="neutral">Pinterest: {sc.pinterest ?? "—"}</Badge>
            <Badge tone="neutral">Тренд: {sc.trend ?? "—"}</Badge>
            <Badge tone="neutral">Порядок: {sc.order ?? "—"}</Badge>
          </>}
          {r.review?.needed != null && <Badge tone="neutral">Нужно {r.review.needed}, минимум {r.review.minOk}</Badge>}
          {r.review?.passes != null && <Badge tone="neutral">Проходов: {r.review.passes}</Badge>}
          {!!r.review?.humanReasons?.length && <Badge tone="warn">Людям: {r.review.humanReasons.join(", ")}</Badge>}
        </div>
        <section>
          <h3 className="mb-2 font-medium">Итоговая подборка ({r.finalOrder.length})</h3>
          {r.finalOrder.length ? (
            <div className="grid grid-cols-4 gap-2 md:grid-cols-6 lg:grid-cols-8">
              {r.finalOrder.map((f, i) => (
                <Thumb key={f.id + i} url={f.url} fallback={f.kind === "R" ? addedBy.get(f.id)?.sourceUrl : undefined} tone={f.kind === "R" ? "add" : undefined} note={`${i + 1}${f.kind === "R" ? ` · добавлено (${f.src === "reject" ? "отклонённые ИИ" : "одобренные ИИ"})` : ""}`} />
              ))}
            </div>
          ) : <p className="help">—</p>}
        </section>
        {r.removed.length > 0 && (
          <section>
            <h3 className="mb-2 font-medium">Удалено ({r.removed.length})</h3>
            <div className="grid grid-cols-4 gap-2 md:grid-cols-6 lg:grid-cols-8">
              {r.removed.map((x) => <Thumb key={x.photoId} url={x.url} fallback={x.sourceUrl} tone="bad" note={x.reason} />)}
            </div>
          </section>
        )}
        {r.added.length > 0 && (
          <section>
            <h3 className="mb-2 font-medium">Добавлено из резерва ({r.added.length})</h3>
            <div className="grid grid-cols-4 gap-2 md:grid-cols-6 lg:grid-cols-8">
              {r.added.map((x) => <Thumb key={x.candidateId} url={x.url} fallback={x.sourceUrl} tone="add" note={`${x.src === "reject" ? "Отклонённые ИИ" : "Одобренные ИИ"}${x.reason ? ` · ${x.reason}` : ""}`} />)}
            </div>
          </section>
        )}
        {!!r.review?.overturned?.length && (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-muted">Снятые замечания ({r.review.overturned.length})</summary>
            <ul className="mt-1 list-disc pl-5 text-muted">{r.review.overturned.map((o, i) => <li key={i}>{o.id}: {o.why}</li>)}</ul>
          </details>
        )}
        {r.status === "proposed" ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <button type="button" className="btn-primary" disabled={!!busy} onClick={() => onResolve("approve")} title="Применить правки и отправить писать текст">Одобрить</button>
            <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => onResolve("human")} title="Применить правки (снятые кадры помечены ✕) и отдать сотруднику">Отправить человеку</button>
            <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => onResolve("insufficient")}>Мало фото</button>
            <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => onResolve("exclude")} title="Ничего не менять, отдать сотруднику">Исключить (без правок)</button>
            <button type="button" className="btn-ghost" disabled={!!busy} onClick={onRerun}>Перепроверить</button>
            {busy && <span className="help">Применяем… добавление фото из резерва может занять до минуты</span>}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3 text-muted">
            <span>Статус: {STATUS[r.status] ?? r.status}</span>
            {r.status === "sent_to_human" && r.articleStatus === "PHOTO_REVIEW" && <Link href={`/pinterest/articles/moderation/photos?article=${r.articleId}`} className="btn-ghost btn-sm">Открыть в модерации фото</Link>}
            <Link href={`/pinterest/articles/articles/${r.articleId}`} className="btn-ghost btn-sm">Карточка статьи</Link>
          </div>
        )}
      </div>
    </div>
  );
}

/** Миниатюра: наш файл, при ошибке — внешний источник (фото могли удалить после одобрения), затем ссылка. */
function Thumb({ url, fallback, note, tone }: { url: string; fallback?: string; note?: string | null; tone?: "bad" | "add" }) {
  const [step, setStep] = useState(0);
  const srcs = [url, fallback].filter((x): x is string => !!x);
  const src = srcs[step];
  return (
    <div className={`overflow-hidden rounded-lg border ${tone === "bad" ? "border-danger" : tone === "add" ? "border-ok" : "border-line"}`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" className="aspect-[3/4] w-full bg-surface-2 object-cover" onError={() => setStep((s) => s + 1)} />
      ) : (
        <a href={fallback || url} target="_blank" rel="noreferrer" className="flex aspect-[3/4] w-full items-center justify-center bg-surface-2 p-2 text-center text-[11px] text-muted">Фото не открылось — открыть</a>
      )}
      {note && <div className="p-1 text-[11px] leading-tight text-muted">{note}</div>}
    </div>
  );
}

/* ───────────────────────── Вкладка «Мало фото» ───────────────────────── */

function InsufficientTab({ rows, busy, act }: { rows: InsufficientRow[]; busy: string | null; act: Act }) {
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [fSite, setFSite] = useState("all");
  const sites = useMemo(() => [...new Map(rows.map((r) => [r.siteId, r.siteName])).entries()], [rows]);
  const shown = rows.filter((r) => fSite === "all" || r.siteId === fSite);

  const byDay = useMemo(() => {
    const m = new Map<string, { ai: number; human: number }>();
    for (const r of rows) {
      const d = day(r.at);
      const v = m.get(d) ?? { ai: 0, human: 0 };
      if (r.byAi) v.ai++; else v.human++;
      m.set(d, v);
    }
    return [...m.entries()].slice(0, 14);
  }, [rows]);
  const bySite = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.siteName, (m.get(r.siteName) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const byWho = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) { const w = r.byName ?? "Владелец"; m.set(w, (m.get(w) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const doAct = (id: string, op: "topup" | "return" | "close") =>
    act(`ins:${id}`, { action: "insufficient", articleId: id, op }, () => (op === "topup" ? "Добор запущен — статья вернётся на модерацию с пополненным резервом" : op === "return" ? "Возвращено на модерацию фото" : "Статья закрыта"));

  const list = (items: Array<[string, ReactNode]>) => (items.length ? <ul className="space-y-1 text-[13.5px]">{items.map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span className="truncate">{k}</span><span className="tabular-nums font-medium">{v}</span></li>)}</ul> : <p className="help">—</p>);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Card title="По дням (ИИ / люди)">{list(byDay.map(([d, v]) => [d, `${v.ai} / ${v.human}`]))}</Card>
        <Card title="По сайтам">{list(bySite.map(([s, n]) => [s, n]))}</Card>
        <Card title="Кто отметил">{list(byWho.map(([w, n]) => [w, n]))}</Card>
      </div>
      {sites.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`badge px-3 py-1 ${fSite === "all" ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`} onClick={() => setFSite("all")}>Все сайты · {rows.length}</button>
          {sites.map(([id, name]) => <button key={id} type="button" className={`badge px-3 py-1 ${fSite === id ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`} onClick={() => setFSite(id)}>{name} · {rows.filter((r) => r.siteId === id).length}</button>)}
        </div>
      )}
      {shown.length ? (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Ключ</th><th>Сайт</th><th>Кто</th><th>Когда</th><th>Причина</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium max-w-xs">
                    <Link href={`/pinterest/articles/articles/${r.id}`} className="block truncate hover:underline" title={r.keyword}>{r.keyword}</Link>
                    {r.status === "WAITING_FOR_PHOTOS" && <span className="text-[11px] text-muted">воркер не набрал фото</span>}
                  </td>
                  <td className="whitespace-nowrap">{r.siteName}</td>
                  <td className="whitespace-nowrap">{r.byName ?? "Владелец"}</td>
                  <td className="whitespace-nowrap tabular-nums text-muted">{fmt(r.at)}</td>
                  <td className="max-w-md text-muted"><span className="line-clamp-2" title={r.reason ?? ""}>{r.reason || "—"}</span></td>
                  <td className="whitespace-nowrap">
                    <div className="flex flex-wrap justify-end gap-1">
                      <button type="button" className="btn-ghost btn-sm" disabled={busy === `ins:${r.id}`} onClick={() => void doAct(r.id, "topup")} title="Поиск фото продолжится, статья вернётся на модерацию с пополненным резервом">Добрать фото</button>
                      <button type="button" className="btn-ghost btn-sm" disabled={busy === `ins:${r.id}`} onClick={() => void doAct(r.id, "return")} title="Вернуть в очередь модерации фото как есть">На модерацию</button>
                      {confirmClose === r.id ? (
                        <>
                          <button type="button" className="btn-danger btn-sm" disabled={busy === `ins:${r.id}`} onClick={() => { setConfirmClose(null); void doAct(r.id, "close"); }}>Точно закрыть</button>
                          <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirmClose(null)}>Отмена</button>
                        </>
                      ) : (
                        <button type="button" className="btn-ghost btn-sm" disabled={busy === `ins:${r.id}`} onClick={() => setConfirmClose(r.id)} title="Остановить статью: фото и резерв остаются, писать не будем">Закрыть</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="Пока нет статей с пометкой «Мало фото»" hint="Сюда попадают статьи, которым ИИ или сотрудник поставили «Мало фото», и статьи, где воркер не набрал нужного числа кадров." />
      )}
    </div>
  );
}
