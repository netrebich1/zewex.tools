"use client";
import { useEffect, useState } from "react";
import { pollWhileVisible } from "@/lib/poll";
import { Card } from "@/components/ui";
import type { RunView as RunViewT, TaskView } from "@/lib/uploader/views";
import { RUN_LIVE, type VerifyResult } from "@/lib/uploader/types";
import { AgentBadge, RunBadge, TaskBadge, dt } from "./ui";

const fmtS = (ms: number) => `${Math.round(ms / 1000)} с`;
/** Как verifyText в lib/uploader/runs.ts (тот серверный, сюда не импортируется). */
const verifyLabel = (v: VerifyResult) =>
  v.scheduled != null ? (v.scheduled > 0 ? `в расписании ${v.scheduled} пинов` : "в расписании пинов нет") : v.processing ? "ещё обрабатывается" : v.published == null ? "статус не прочитан" : `опубликовано ${v.published}${v.failed ? `, ошибок ${v.failed}` : ""}`;

/** Из текста проверки (агент 0.1.6: «адрес Created», затем «Scheduled Pins 100 Pins · Only visible to you 0d …») — адрес и строка блока без хвоста. */
function createdInfo(v: VerifyResult | undefined): { url: string | null; line: string | null } | null {
  if (!v?.text || v.scheduled === undefined) return null;
  const [first, ...rest] = v.text.split("\n");
  const url = /^https?:\/\//.test(first) ? first.trim() : null;
  const body = (url ? rest.join(" ") : v.text).replace(/\s+/g, " ").trim();
  const m = /scheduled pins?.*?only visible to you/i.exec(body);
  return { url, line: m ? m[0] : body.slice(0, 120) || null };
}

function TaskRow({ t, runId }: { t: TaskView; runId: string }) {
  const [open, setOpen] = useState(false);
  // Автозаливка не прошла — тот же CSV можно скачать и залить руками.
  const manual = t.phase === "upload" && (t.status === "FAILED" || t.status === "SKIPPED") && t.errorKind !== "no_file";
  const v = t.result?.verify;
  const shot = t.result?.screenshot ?? v?.screenshot ?? null;
  const created = createdInfo(v);
  return (
    <>
      <tr className={t.status === "FAILED" ? "bg-danger-soft/30" : t.status === "SKIPPED" ? "bg-warn-soft/30" : ""}>
        <td className="font-medium">{t.siteName}<div className="help">{t.profileName ? `${t.profileName} · ${t.profileId}` : t.profileId}</div>
          {created ? (
            <div className="mt-1.5 rounded-lg border border-line bg-ink/5 px-2 py-1 text-[12.5px] font-normal">
              <div className={v?.scheduled ? "text-ok" : "text-warn"}><b>{created.line ?? verifyLabel(v!)}</b></div>
              {created.url ? <a href={created.url} target="_blank" rel="noreferrer" className="help underline break-all">{created.url.replace(/^https?:\/\/(www\.)?/, "")}</a> : null}
            </div>
          ) : null}
          {t.errorLabel ? <div className="sm:hidden text-[12.5px] font-normal text-danger">{t.errorLabel}</div> : null}</td>
        <td className="col-sm help">{t.phase === "verify" ? "проверка" : "заливка"}</td>
        <td><TaskBadge status={t.status} />{t.attempts > 1 ? <span className="help ml-1">попытка {t.attempts}</span> : null}</td>
        <td className="tabular-nums">{t.rows ?? "—"}<div className="help">{t.fileName ?? ""}</div>{manual ? <a href={`/api/uploader/runs/${runId}/file?task=${t.id}`} className="btn-secondary btn-sm mt-1.5 inline-flex">⬇ Скачать CSV</a> : null}</td>
        <td className="text-[12.5px]">
          {t.status === "LEASED" ? <span className="text-brand">{t.step ?? "в работе"}</span> : null}
          {t.errorLabel ? <div className="text-danger">{t.errorLabel}{t.error && t.error !== t.errorLabel ? <span className="help"> — {t.error}</span> : null}</div> : t.status === "SKIPPED" && t.error ? <div className="text-warn">{t.error}</div> : null}
          {t.status === "DONE" && t.phase === "upload" ? <div className="text-ok">файл принят{t.result?.rowsSeen != null ? `, строк ${t.result.rowsSeen}` : ""}{t.result?.message ? <span className="help"> · {t.result.message}</span> : null}</div> : null}
          {v ? <div className={v.processing || v.scheduled === 0 ? "text-warn" : "text-ok"}>проверка: {verifyLabel(v)}</div> : null}
        </td>
        <td className="col-sm help whitespace-nowrap">{t.startedAt ? dt(t.startedAt) : "—"}{t.finishedAt && t.result?.timings?.total ? ` · ${fmtS(t.result.timings.total)}` : ""}</td>
        <td className="text-right whitespace-nowrap">
          {shot ? <a href={shot} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">Скриншот</a> : null}
          {v?.screenshot && v.screenshot !== shot ? <a href={v.screenshot} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">Created</a> : null}
          {t.result?.html || v?.text ? <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(!open)}>{open ? "Скрыть" : "Подробнее"}</button> : null}
        </td>
      </tr>
      {open && (
        <tr><td colSpan={7} className="bg-ink/5">
          {v?.text ? <pre className="whitespace-pre-wrap text-[12px] max-h-64 overflow-auto">{v.text}</pre> : null}
          {t.result?.html ? <details className="mt-2"><summary className="text-[12.5px] cursor-pointer">HTML страницы при ошибке (для правки агента)</summary><pre className="whitespace-pre-wrap text-[11px] max-h-96 overflow-auto">{t.result.html.slice(0, 60_000)}</pre></details> : null}
        </td></tr>
      )}
    </>
  );
}

/** Живая карточка запуска: статус, агент, задания с шагами, ошибками, скриншотами; опрос каждые 5 с, пока запуск жив. */
export function RunView({ initial }: { initial: RunViewT }) {
  const [run, setRun] = useState(initial);
  const live = RUN_LIVE.has(run.status);
  useEffect(() => {
    if (!live) return;
    return pollWhileVisible(async () => {
      try {
        const res = await fetch(`/api/uploader/runs/${run.id}`, { cache: "no-store" });
        if (res.ok) setRun(await res.json());
      } catch { /* показываем прошлое */ }
    }, 5_000);
  }, [live, run.id]);
  const uploads = run.tasks.filter((t) => t.phase === "upload");
  const verifies = run.tasks.filter((t) => t.phase === "verify");
  const pct = run.total ? Math.round(((run.done + run.failed) / run.total) * 100) : 0;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3 text-[13.5px]">
          <RunBadge status={run.status} />
          <span>Агент: <b>{run.agent.name}</b> <AgentBadge status={run.agent.status} />{run.agent.state ? <span className="help"> · {run.agent.state}</span> : null}</span>
          <span className="help">профилей одновременно: {run.parallel}</span>
          {run.status === "VERIFY_WAIT" && run.verifyAt ? <span className="text-warn">проверка истории в {dt(run.verifyAt)}</span> : null}
          {run.verifyAttempts ? <span className="help">проверок: {run.verifyAttempts}</span> : null}
          {run.error ? <span className="text-danger">{run.error}</span> : null}
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-ink/10"><div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
        <div className="mt-1 help">Готово {run.done} из {run.total}{run.failed ? ` · ошибок ${run.failed}` : ""}{run.skipped ? ` · пропущено ${run.skipped}` : ""}{run.startedAt ? ` · начат ${dt(run.startedAt)}` : ""}{run.finishedAt ? ` · завершён ${dt(run.finishedAt)}` : ""}</div>
      </Card>
      <Card title={`Заливка · ${uploads.length}`}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Сайт / профиль</th><th className="col-sm">Фаза</th><th>Статус</th><th>Пинов</th><th>Что происходит</th><th className="col-sm">Начато</th><th></th></tr></thead>
          <tbody>{uploads.map((t) => <TaskRow key={t.id} t={t} runId={run.id} />)}</tbody>
        </table></div>
      </Card>
      {verifies.length > 0 && (
        <Card title={`Проверка истории загрузок · ${verifies.length}`} description="Через 10 минут после заливки агент снова открывает профиль и читает историю массовых загрузок Pinterest.">
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Сайт / профиль</th><th className="col-sm">Фаза</th><th>Статус</th><th>Пинов</th><th>Что происходит</th><th className="col-sm">Начато</th><th></th></tr></thead>
            <tbody>{verifies.map((t) => <TaskRow key={t.id} t={t} runId={run.id} />)}</tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}
