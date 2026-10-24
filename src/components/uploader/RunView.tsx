"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import type { RunView as RunViewT, TaskView } from "@/lib/uploader/views";
import { RUN_LIVE } from "@/lib/uploader/types";
import { AgentBadge, RunBadge, TaskBadge, dt } from "./ui";

const fmtS = (ms: number) => `${Math.round(ms / 1000)} с`;

function TaskRow({ t }: { t: TaskView }) {
  const [open, setOpen] = useState(false);
  const v = t.result?.verify;
  const shot = t.result?.screenshot ?? v?.screenshot ?? null;
  return (
    <>
      <tr className={t.status === "FAILED" ? "bg-danger-soft/30" : t.status === "SKIPPED" ? "bg-warn-soft/30" : ""}>
        <td className="font-medium">{t.siteName}<div className="help">{t.profileName ?? t.profileId}</div>{t.errorLabel ? <div className="sm:hidden text-[12.5px] font-normal text-danger">{t.errorLabel}</div> : null}</td>
        <td className="col-sm help">{t.phase === "verify" ? "проверка" : "заливка"}</td>
        <td><TaskBadge status={t.status} />{t.attempts > 1 ? <span className="help ml-1">попытка {t.attempts}</span> : null}</td>
        <td className="tabular-nums">{t.rows ?? "—"}<div className="help">{t.fileName ?? ""}</div></td>
        <td className="text-[12.5px]">
          {t.status === "LEASED" ? <span className="text-brand">{t.step ?? "в работе"}</span> : null}
          {t.errorLabel ? <div className="text-danger">{t.errorLabel}{t.error && t.error !== t.errorLabel ? <span className="help"> — {t.error}</span> : null}</div> : t.status === "SKIPPED" && t.error ? <div className="text-warn">{t.error}</div> : null}
          {t.status === "DONE" && t.phase === "upload" ? <div className="text-ok">файл принят{t.result?.rowsSeen != null ? `, строк ${t.result.rowsSeen}` : ""}{t.result?.message ? <span className="help"> · {t.result.message}</span> : null}</div> : null}
          {v ? <div className={v.processing ? "text-warn" : "text-ok"}>проверка: {v.processing ? "ещё обрабатывается" : v.published == null ? "статус не прочитан" : `опубликовано ${v.published}${v.failed ? `, ошибок ${v.failed}` : ""}`}</div> : null}
        </td>
        <td className="col-sm help whitespace-nowrap">{t.startedAt ? dt(t.startedAt) : "—"}{t.finishedAt && t.result?.timings?.total ? ` · ${fmtS(t.result.timings.total)}` : ""}</td>
        <td className="text-right whitespace-nowrap">
          {shot ? <a href={shot} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">Скриншот</a> : null}
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
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/uploader/runs/${run.id}`, { cache: "no-store" });
        if (res.ok) setRun(await res.json());
      } catch { /* показываем прошлое */ }
    }, 5_000);
    return () => clearInterval(t);
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
          <tbody>{uploads.map((t) => <TaskRow key={t.id} t={t} />)}</tbody>
        </table></div>
      </Card>
      {verifies.length > 0 && (
        <Card title={`Проверка истории загрузок · ${verifies.length}`} description="Через 10 минут после заливки агент снова открывает профиль и читает историю массовых загрузок Pinterest.">
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Сайт / профиль</th><th className="col-sm">Фаза</th><th>Статус</th><th>Пинов</th><th>Что происходит</th><th className="col-sm">Начато</th><th></th></tr></thead>
            <tbody>{verifies.map((t) => <TaskRow key={t.id} t={t} />)}</tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}
