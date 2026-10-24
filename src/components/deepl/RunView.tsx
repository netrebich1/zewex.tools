"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { pollWhileVisible } from "@/lib/poll";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Badge, Card } from "@/components/ui";
import { publishDeeplItem, publishDeeplReady, retryDeeplItems, revertDeeplItem } from "@/actions/deepl";
import { ITEM_STATUS_LABELS, STAGE_LABELS, type DeeplSettings } from "@/lib/deepl/types";
import type { JobItemRow } from "@/lib/deepl/jobs";
import { ITEM_TONE } from "./DeeplNav";

const LIVE = new Set(["QUEUED", "RUNNING"]);
type Stage = { key: string; label: string; html: string; chars: number; changedWords?: number; status?: string };

/** Коды предупреждений, которые не стоит показывать как проблему (служебные). */
const QUIET = new Set(["resume", "cache_hit", "tags_drift", "key_switch"]);

export function RunView({ jobId, initialStatus, initialItems, publishDefaults }: { jobId: string; initialStatus: string; initialItems: JobItemRow[]; publishDefaults: DeeplSettings["publish"] }) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [items, setItems] = useState(initialItems);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "warning" | "error" | "done">("all");
  const prevStatus = useRef(initialStatus);

  useEffect(() => {
    setStatus(initialStatus);
    setItems(initialItems);
  }, [initialStatus, initialItems]);

  useEffect(() => {
    const live = LIVE.has(status) || items.some((i) => i.status === "pending" || i.status === "processing");
    if (!live) return;
    return pollWhileVisible(async () => {
      try {
        const res = await fetch(`/api/deepl/jobs/${jobId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        setItems(data.items);
        setStatus(data.job.status);
        if (LIVE.has(prevStatus.current) && !LIVE.has(data.job.status)) router.refresh();
        prevStatus.current = data.job.status;
      } catch {
        /* показываем прошлое */
      }
    }, 4_000);
  }, [status, items, jobId, router]);

  const by = (s: string) => items.filter((i) => i.status === s).length;
  const finished = by("done") + by("warning") + by("error");
  const cost = items.reduce((a, i) => a + i.costUsd, 0);
  const chars = items.reduce((a, i) => a + i.deeplChars, 0);
  const published = items.filter((i) => i.publishedAt).length;
  const pct = items.length ? Math.round((finished / items.length) * 100) : 0;
  const shown = items.filter((i) => filter === "all" || i.status === filter);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Статей", value: items.length },
          { label: "Готово", value: by("done") },
          { label: "Проверить", value: by("warning") },
          { label: "Ошибок", value: by("error") },
          { label: "Опубликовано", value: published },
          { label: "ИИ / DeepL", value: `$${cost.toFixed(3)} · ${Math.round(chars / 1000)}k`, small: true },
        ].map((s) => (
          <div key={s.label} className="kpi min-w-0">
            <div className={`kpi-value ${"small" in s ? "!text-[20px] whitespace-nowrap" : ""}`}>{s.value}</div>
            <div className="help">{s.label}</div>
          </div>
        ))}
      </div>

      {(LIVE.has(status) || by("processing") > 0) && (
        <div>
          <div className="mb-1 flex justify-between text-[13px] text-muted"><span>Обработано {finished} из {items.length} · в работе {by("processing")} · в очереди {by("pending")}</span><span>{pct}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-ink/10"><div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
        </div>
      )}

      <Card
        title="Статьи"
        description="Нажмите на статью, чтобы посмотреть версии по этапам, скопировать HTML, опубликовать или повторить."
        actions={
          <div className="flex flex-wrap gap-1.5">
            {(["all", "done", "warning", "error"] as const).map((f) => (
              <button key={f} type="button" className={`tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                {f === "all" ? `Все ${items.length}` : `${ITEM_STATUS_LABELS[f]} ${by(f)}`}
              </button>
            ))}
          </div>
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th className="col-sm">#</th><th>Статья</th><th>Статус</th><th className="col-sm">Ключи</th><th className="col-sm">WordPress</th><th></th></tr>
            </thead>
            <tbody>
              {shown.map((it) => {
                const warns = it.warnings.filter((w) => !QUIET.has(w.code));
                const kwOk = it.keywordReport.filter((k) => k.ok).length;
                return (
                  <Fragment key={it.id}>
                    <tr className={open === it.id ? "bg-ink/5" : ""}>
                      <td className="col-sm help">{it.position + 1}</td>
                      <td>
                        <div className="max-w-[420px]">
                        <button type="button" className="text-left font-medium hover:underline" onClick={() => setOpen(open === it.id ? null : it.id)}>{it.title || `Пост #${it.wpPostId}`}</button>
                        <div className="help">{it.wpDate ?? ""}{it.wpStatus ? ` · ${it.wpStatus}` : ""}{warns.length ? ` · замечаний ${warns.length}` : ""}</div>
                        {it.error && <div className="help text-danger line-clamp-2 [overflow-wrap:anywhere]">{it.error}</div>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap">
                        <Badge tone={ITEM_TONE[it.status] ?? "neutral"}>{ITEM_STATUS_LABELS[it.status] ?? it.status}</Badge>
                        {it.status === "processing" && <div className="help">{STAGE_LABELS[it.stage] ?? it.stage}</div>}
                      </td>
                      <td className="col-sm help whitespace-nowrap">{it.keywordReport.length ? `${kwOk}/${it.keywordReport.length} в норме` : "—"}</td>
                      <td className="col-sm whitespace-nowrap">
                        {it.publishedUrl ? <a href={it.publishedUrl} target="_blank" rel="noreferrer" className="hover:underline">{it.publishMode === "new" ? "новый пост" : "обновлён"} ↗</a> : it.revertedAt ? <span className="help">возвращён оригинал</span> : it.sourceUrl ? <a href={it.sourceUrl} target="_blank" rel="noreferrer" className="help hover:underline">исходник ↗</a> : "—"}
                      </td>
                      <td className="text-right"><button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(open === it.id ? null : it.id)}>{open === it.id ? "Скрыть" : "Открыть"}</button></td>
                    </tr>
                    {open === it.id && (
                      <tr>
                        <td colSpan={6} className="!p-0">
                          {/* На телефоне панель по ширине карточки и не уезжает при прокрутке таблицы вбок. */}
                          <div className="sticky left-4 w-[calc(100vw-4rem-2px)] sm:static sm:w-auto">
                            <ItemPanel jobId={jobId} item={it} publishDefaults={publishDefaults} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {!LIVE.has(status) && items.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Опубликовать готовые" description="Все готовые и ещё не опубликованные статьи прогона. Перед заменой исходного поста оригинал сохраняется для отката.">
            <ActionForm action={publishDeeplReady} className="flex flex-wrap items-center gap-2" hidden={{ id: jobId }}>
              <select name="mode" className="input w-auto" defaultValue={publishDefaults.target}>
                <option value="source">в исходные посты</option>
                <option value="new">новыми постами</option>
              </select>
              <select name="status" className="input w-auto" defaultValue={publishDefaults.status}>
                <option value="draft">черновик</option>
                <option value="pending">на утверждение</option>
                <option value="publish">опубликовать</option>
              </select>
              <label className="flex items-center gap-1.5 text-[14px]"><input type="checkbox" name="withWarnings" /> и «проверить»</label>
              <SubmitButton className="btn-primary" pendingText="Публикую…" confirm="Опубликовать готовые статьи в WordPress?">Опубликовать</SubmitButton>
            </ActionForm>
          </Card>
          {(by("error") + by("warning")) > 0 && (
            <Card title="Повторить проблемные" description="С ошибкой — продолжат с последнего готового этапа; «проверить» — заново с исходника (перевод возьмётся из кэша бесплатно).">
              <ActionForm action={retryDeeplItems} hidden={{ id: jobId }}>
                <SubmitButton className="btn-ghost" pendingText="…">Повторить {by("error") + by("warning")}</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function ItemPanel({ jobId, item, publishDefaults }: { jobId: string; item: JobItemRow; publishDefaults: DeeplSettings["publish"] }) {
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string>("final");
  const [mode, setMode] = useState<"view" | "side" | "html">("view");
  const [copied, setCopied] = useState(false);
  const stageSig = item.stageKeys.join("|") + item.status;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/deepl/items/${item.id}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) throw new Error(d.error);
        const list = (d.stages as Stage[]).filter((s) => !s.key.endsWith("#failed"));
        setStages(list);
        setActive((cur) => (list.some((s) => s.key === cur) ? cur : list[list.length - 1]?.key ?? "source"));
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [item.id, stageSig]);

  const idx = stages?.findIndex((s) => s.key === active) ?? -1;
  const cur = stages && idx >= 0 ? stages[idx] : null;
  const prev = stages && idx > 0 ? stages[idx - 1] : null;
  const warns = item.warnings.filter((w) => !QUIET.has(w.code));

  async function copy() {
    if (!cur) return;
    await navigator.clipboard.writeText(cur.html);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-4 border-t border-line bg-surface p-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {!stages && !error && <p className="help">Загружаю версии…</p>}
      {stages && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {stages.map((s) => (
              <button key={s.key} type="button" className={`tab ${active === s.key ? "active" : ""}`} onClick={() => setActive(s.key)}>
                {s.label}
                {typeof s.changedWords === "number" && <span className="opacity-60"> · {s.changedWords} сл.</span>}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(["view", "side", "html"] as const).map((m) => (
              <button key={m} type="button" className={`btn-ghost btn-sm ${mode === m ? "!bg-ink/10" : ""}`} onClick={() => setMode(m)}>
                {m === "view" ? "Текст" : m === "side" ? "Рядом с предыдущей" : "HTML"}
              </button>
            ))}
            <span className="help">{cur ? `${cur.chars.toLocaleString("ru-RU")} знаков с разметкой` : ""}</span>
            <button type="button" className="btn-primary btn-sm ml-auto" onClick={copy} disabled={!cur}>{copied ? "Скопировано" : "Копировать HTML"}</button>
          </div>
          {cur && mode === "html" && <textarea readOnly className="input h-[420px] font-mono text-[12px]" value={cur.html} />}
          {cur && mode === "view" && <Preview html={cur.html} />}
          {cur && mode === "side" && (
            <div className="grid gap-3 lg:grid-cols-2">
              <div><div className="label">{prev?.label ?? "—"}</div>{prev ? <Preview html={prev.html} /> : <p className="help">Это первая версия.</p>}</div>
              <div><div className="label">{cur.label}</div><Preview html={cur.html} /></div>
            </div>
          )}
        </>
      )}

      {item.keywordReport.length > 0 && (
        <div>
          <div className="label">Ключи (было в исходнике → сейчас, норма)</div>
          <div className="flex flex-wrap gap-1.5">
            {item.keywordReport.map((k) => (
              <Badge key={k.key} tone={k.ok ? "ok" : k.current < k.min ? "warn" : "danger"}>{k.key}: {k.source} → {k.current} ({k.min}–{k.max})</Badge>
            ))}
          </div>
        </div>
      )}

      {warns.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[14px] font-medium">Замечания ({warns.length})</summary>
          <ul className="mt-2 space-y-1 text-[13px] text-muted">
            {warns.slice(0, 60).map((w, i) => <li key={i}><span className="font-mono text-[12px]">{w.code}</span> — {w.detail}</li>)}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap items-start gap-4 border-t border-line pt-3">
        {(item.status === "done" || item.status === "warning") && (
          <ActionForm action={publishDeeplItem} className="flex flex-wrap items-center gap-2" hidden={{ id: jobId, itemId: item.id }}>
            <select name="mode" className="input w-auto" defaultValue={item.wpPostId ? publishDefaults.target : "new"}>
              {item.wpPostId && <option value="source">в исходный пост</option>}
              <option value="new">новым постом</option>
            </select>
            <select name="status" className="input w-auto" defaultValue={publishDefaults.status}>
              <option value="draft">черновик</option>
              <option value="pending">на утверждение</option>
              <option value="publish">опубликовать</option>
            </select>
            <SubmitButton className="btn-primary btn-sm" pendingText="Публикую…" confirm="Отправить итоговый текст в WordPress?">{item.publishedAt ? "Опубликовать ещё раз" : "Опубликовать"}</SubmitButton>
          </ActionForm>
        )}
        {item.status !== "processing" && item.status !== "pending" && (
          <ActionForm action={retryDeeplItems} className="inline" hidden={{ id: jobId, itemId: item.id }}>
            <SubmitButton className="btn-ghost btn-sm" pendingText="…">{item.status === "error" || item.status === "stopped" ? "Продолжить с места остановки" : "Обработать заново"}</SubmitButton>
          </ActionForm>
        )}
        {item.hasOriginal && item.publishMode === "replace" && !item.revertedAt && (
          <ActionForm action={revertDeeplItem} className="flex flex-wrap items-center gap-2" hidden={{ id: jobId, itemId: item.id }}>
            <input name="confirm" className="input w-36" placeholder="впишите «вернуть»" />
            <SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…">Вернуть оригинал в WP</SubmitButton>
          </ActionForm>
        )}
      </div>
    </div>
  );
}

/** Предпросмотр HTML статьи в изолированном фрейме (скрипты чужого контента не выполняются). */
function Preview({ html }: { html: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px/1.6 system-ui,sans-serif;color:#1a1a1a;margin:12px 16px;}img{max-width:100%;height:auto}h2{font-size:20px;margin:20px 0 8px}a{color:#c2410c}</style></head><body>${html.replace(/\[caption[^\]]*\]|\[\/caption\]/g, "")}</body></html>`;
  return <iframe sandbox="" srcDoc={doc} className="h-[480px] w-full rounded-lg border border-line bg-white" title="Предпросмотр" />;
}
