/**
 * Ошибки конвейера статей: группы по сигнатуре (сколько, когда впервые/последний раз, этап, сайты, образец текста,
 * затронутые статьи со ссылками и текущим статусом) с кнопками «Вернуть в работу» / «Устранено» / «Открыть снова»,
 * и временные сбои, которые воркер повторил сам. Данные — src/lib/articles/errorsView.ts.
 */
import Link from "next/link";
import { Badge } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { badgeTone } from "@/components/articles/StatusBadge";
import { requeueErrorsAction, resolveErrorsAction, unresolveErrorsAction } from "@/actions/articlesErrors";
import { EXTRA_ERROR_STAGES, type ErrorGroupView, type RetryGroup } from "@/lib/articles/errorsView";
import { stageLabel } from "@/lib/articles/stages";
import { fmtDate } from "@/lib/utils";

export const errStageLabel = (s: string) => EXTRA_ERROR_STAGES[s] ?? stageLabel(s);

/** Контекст фильтра, который уходит в действия (чтобы кнопка меняла ровно то, что видно). */
export type ErrorScope = { siteId?: string; runId?: string; stage?: string; days?: number };

export function ErrorGroups({ groups, scope, showSites = true, articlesLimit = 12, actions = true }: { groups: ErrorGroupView[]; scope: ErrorScope; showSites?: boolean; articlesLimit?: number; actions?: boolean }) {
  const hidden = (signature: string) => ({ signature, siteId: scope.siteId ?? "", runId: scope.runId ?? "", stage: scope.stage ?? "", days: scope.days ? String(scope.days) : "" });
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.signature} className={`rounded-xl border border-line p-3 ${g.open ? "" : "opacity-70"}`}>
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={g.open ? "danger" : "neutral"}>{g.count}{g.open && g.open !== g.count ? ` · откр. ${g.open}` : ""}</Badge>
                <Badge>{errStageLabel(g.stage)}</Badge>
                {g.kind && <Badge tone={g.kind === "bug" ? "warn" : "neutral"}>{g.kind === "bug" ? "поломка" : "внешняя причина"}</Badge>}
                {!g.open && <Badge tone="ok">устранено</Badge>}
                <span className="font-medium min-w-0 [overflow-wrap:anywhere]">{g.title ?? g.signature.replace(/^[^:]+:\s*/, "").slice(0, 140)}</span>
              </div>
              <div className="help mt-1 whitespace-pre-wrap break-words">{g.sample.slice(0, 600)}</div>
              {g.hint && <div className="help mt-1"><b>Что делать:</b> {g.hint}</div>}
              <div className="help mt-1">
                впервые {fmtDate(g.first)} · последний раз {fmtDate(g.last)} · статей {g.articles.length}
                {g.failedNow > 0 && <> · <span className="text-danger">сейчас с ошибкой {g.failedNow}</span></>}
                {g.recovered > 0 && <> · <span className="text-ok">дошли до публикации {g.recovered}</span></>}
                {showSites && g.sites.length > 0 && <> · сайты: {g.sites.map((s, i) => <span key={s.id}>{i ? ", " : ""}<Link href={`/pinterest/articles/sites/${s.id}`} className="underline">{s.name}</Link></span>)}</>}
              </div>
              {g.articles.length > 0 && (
                <details className="mt-2 text-[13px]">
                  <summary className="help cursor-pointer">Затронутые статьи ({g.articles.length})</summary>
                  <ul className="mt-2 space-y-1">
                    {g.articles.slice(0, articlesLimit).map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center gap-2">
                        <Badge tone={badgeTone(a.tone)}>{a.statusLabel}</Badge>
                        <Link href={`/pinterest/articles/articles/${a.id}`} className="hover:underline">{a.keyword}</Link>
                        <span className="help">· этап {stageLabel(a.stage)}{a.count > 1 ? ` · ошибка ${a.count} раз` : ""} · {fmtDate(a.lastAt)}</span>
                        {a.runId && !scope.runId && <Link href={`/pinterest/articles/runs/${a.runId}`} className="help underline">запуск</Link>}
                        {a.note && <span className="help w-full pl-1">↳ {a.note.slice(0, 300)}</span>}
                      </li>
                    ))}
                  </ul>
                  {g.articles.length > articlesLimit && <p className="help mt-1">…и ещё {g.articles.length - articlesLimit}</p>}
                </details>
              )}
            </div>
            {actions && (
              <div className="flex flex-wrap gap-2">
                {g.failedNow > 0 && (
                  <ActionForm action={requeueErrorsAction} hidden={hidden(g.signature)} className="inline">
                    <SubmitButton className="btn-primary btn-sm" pendingText="…">Вернуть в работу ({g.failedNow})</SubmitButton>
                  </ActionForm>
                )}
                {g.open > 0 ? (
                  <ActionForm action={resolveErrorsAction} hidden={hidden(g.signature)} className="inline">
                    <SubmitButton className="btn-ghost btn-sm" pendingText="…">Устранено</SubmitButton>
                  </ActionForm>
                ) : (
                  <ActionForm action={unresolveErrorsAction} hidden={hidden(g.signature)} className="inline">
                    <SubmitButton className="btn-ghost btn-sm" pendingText="…">Открыть снова</SubmitButton>
                  </ActionForm>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Временные сбои: этап упал, воркер повторил сам. Много повторов — повод разобраться (и лишние деньги). */
export function RetryGroups({ retries, limit = 20 }: { retries: RetryGroup[]; limit?: number }) {
  if (!retries.length) return <p className="help">Повторов не было.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th className="text-right">Раз</th><th className="text-right">Статей</th><th>Этап</th><th>Что случилось</th><th className="hidden md:table-cell">Последний</th></tr></thead>
        <tbody>
          {retries.slice(0, limit).map((r) => (
            <tr key={r.key}>
              <td className="text-right tabular-nums"><Badge tone="warn">{r.count}</Badge></td>
              <td className="text-right tabular-nums">{r.articles}</td>
              <td className="whitespace-nowrap text-muted">{stageLabel(r.stage)}</td>
              <td className="max-w-[560px]">
                {r.title && <div className="font-medium">{r.title}</div>}
                <div className="help break-words" title={r.sample}>{r.sample.slice(0, 300)}</div>
                {r.waitingNow.length > 0 && (
                  <div className="help mt-1">
                    ждут повтора сейчас: {r.waitingNow.slice(0, 5).map((a, i) => <span key={a.id}>{i ? ", " : ""}<Link href={`/pinterest/articles/articles/${a.id}`} className="underline" title={a.note}>{a.keyword}</Link></span>)}
                    {r.waitingNow.length > 5 ? ` и ещё ${r.waitingNow.length - 5}` : ""}
                  </div>
                )}
              </td>
              <td className="hidden md:table-cell help whitespace-nowrap">{fmtDate(r.last)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
