import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, Empty, PageHeader, type SearchParams, sp } from "@/components/ui";
import { artSiteWhere, articleWhere } from "@/lib/articles/access";
import { ALL_STAGES, stageLabel } from "@/lib/articles/stages";
import { PROJECT_SLUG } from "@/lib/articles/types";
import { EXTRA_ERROR_STAGES, errorGroups, errorWhere, explainError, retryGroups, type ErrorState } from "@/lib/articles/errorsView";
import { costBreakdown } from "@/lib/articles/costs";
import { ErrorGroups, RetryGroups, errStageLabel } from "@/components/articles/ErrorsTable";
import { CostDays, CostMatrix, CostSummary } from "@/components/articles/CostBreakdown";
import { fmtDate, fmtMoney } from "@/lib/utils";
import { seesTeamCosts } from "@/lib/permissions";

export const dynamic = "force-dynamic";

type Tab = "errors" | "ai" | "costs";
const PERIODS: Array<{ v: number; label: string }> = [{ v: 1, label: "сутки" }, { v: 7, label: "7 дн." }, { v: 30, label: "30 дн." }, { v: 90, label: "90 дн." }, { v: 0, label: "всё время" }];
const STATES: Array<{ v: ErrorState; label: string }> = [{ v: "open", label: "Открытые" }, { v: "resolved", label: "Устранённые" }, { v: "all", label: "Все" }];

export default async function JournalPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const canCosts = seesTeamCosts(me);
  const tab: Tab = (["errors", "ai", "costs"] as Tab[]).find((t) => t === sp(q, "tab")) ?? "errors";
  const siteParam = sp(q, "site");
  const runId = sp(q, "run") || undefined;
  const stage = sp(q, "stage") || undefined;
  const state: ErrorState = STATES.find((s) => s.v === sp(q, "state"))?.v ?? "open";
  const articleId = sp(q, "article");
  const rawDays = sp(q, "days");
  const days = rawDays === "0" ? 0 : Math.min(365, Math.max(1, Number(rawDays) || 7));
  const since = days ? new Date(Date.now() - days * 86400_000) : undefined;

  const sites = await prisma.artSite.findMany({ where: await artSiteWhere(me), select: { id: true, name: true, teamId: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const siteIds = sites.map((s) => s.id);
  const siteId = siteParam && siteIds.includes(siteParam) ? siteParam : undefined;
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const qs = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const all = { tab, site: siteId, run: runId, stage, state: state === "open" ? undefined : state, article: articleId, days: days === 7 ? undefined : String(days), ...patch };
    for (const [k, v] of Object.entries(all)) if (v) u.set(k, v);
    const s = u.toString();
    return `/pinterest/articles/journal${s ? `?${s}` : ""}`;
  };
  const periodText = days ? `за ${days === 1 ? "сутки" : `${days} дн.`}` : "за всё время";

  const header = (
    <>
      <PageHeader back={{ href: "/pinterest/articles", label: "Статьи" }} title="Журнал" subtitle="Ошибки конвейера по группам, вызовы ИИ и расходы по сайтам, запускам и фазам." />
      <Card className="mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <Link href={qs({ tab: "errors", article: undefined })} className={`tab ${tab === "errors" ? "active" : ""}`}>Ошибки</Link>
          <Link href={qs({ tab: "ai" })} className={`tab ${tab === "ai" ? "active" : ""}`}>Вызовы ИИ</Link>
          {canCosts && <Link href={qs({ tab: "costs", article: undefined })} className={`tab ${tab === "costs" ? "active" : ""}`}>Расходы</Link>}
          <span className="ml-auto inline-flex flex-wrap gap-1">
            {PERIODS.map((p) => (
              <Link key={p.v} href={qs({ days: p.v === 7 ? undefined : String(p.v) })} className={`btn-ghost btn-sm ${days === p.v ? "bg-ink/10" : ""}`}>{p.label}</Link>
            ))}
          </span>
        </div>
        {sites.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            <Link href={qs({ site: undefined, run: undefined })} className={`badge px-3 py-1 max-sm:!py-1.5 max-sm:min-h-8 ${!siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все сайты</Link>
            {sites.map((s) => (
              <Link key={s.id} href={qs({ site: s.id, run: undefined })} className={`badge px-3 py-1 max-sm:!py-1.5 max-sm:min-h-8 ${siteId === s.id ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{s.name}</Link>
            ))}
          </div>
        )}
      </Card>
    </>
  );

  /* ───────── Ошибки ───────── */
  if (tab === "errors") {
    const runs = await prisma.artRun.findMany({ where: { siteId: siteId ? siteId : { in: siteIds } }, orderBy: { createdAt: "desc" }, take: 60, select: { id: true, name: true, siteId: true, createdAt: true } });
    const aWhere = { ...(await articleWhere(me)), ...(siteId ? { siteId } : {}), ...(runId ? { runId } : {}) };
    const [groups, retries, recent] = await Promise.all([
      errorGroups(me, { siteId, runId, stage, since, state }),
      retryGroups(aWhere, since).then((r) => (stage ? r.filter((x) => x.stage === stage) : r)),
      prisma.artError.findMany({ where: await errorWhere(me, { siteId, runId, stage, since: new Date(Date.now() - 2 * 3600_000), state: "all" }), select: { signature: true, stage: true, message: true, createdAt: true }, take: 3000 }),
    ]);
    // «Горит сейчас»: последний час против предыдущего (по сигнатурам, без учёта отметки «устранено»).
    const hourAgo = Date.now() - 3600_000;
    const burning = new Map<string, { title: string; stage: string; now: number; prev: number }>();
    for (const r of recent) {
      const e = burning.get(r.signature) ?? { title: explainError(r.message)?.title ?? r.message.slice(0, 120), stage: r.stage, now: 0, prev: 0 };
      if (r.createdAt.getTime() >= hourAgo) e.now++;
      else e.prev++;
      burning.set(r.signature, e);
    }
    const hot = [...burning.entries()].filter(([, e]) => e.now > 0).sort(([, a], [, b]) => b.now - a.now).slice(0, 8);
    const openTotal = groups.reduce((s, g) => s + g.open, 0);
    const failedNow = groups.reduce((s, g) => s + g.failedNow, 0);
    const stageOptions = [...ALL_STAGES, ...Object.keys(EXTRA_ERROR_STAGES)];

    return (
      <>
        {header}
        <div className="space-y-4">
          <Card>
            <form method="get" action="/pinterest/articles/journal" className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <input type="hidden" name="tab" value="errors" />
              {siteId && <input type="hidden" name="site" value={siteId} />}
              {days !== 7 && <input type="hidden" name="days" value={String(days)} />}
              <select name="run" className="input py-2" defaultValue={runId ?? ""}>
                <option value="">Все запуски</option>
                {runs.map((r) => <option key={r.id} value={r.id}>{r.name || r.id.slice(0, 8)} · {siteName.get(r.siteId) ?? ""} · {r.createdAt.toLocaleDateString("ru-RU")}</option>)}
              </select>
              <select name="stage" className="input py-2" defaultValue={stage ?? ""}>
                <option value="">Все этапы</option>
                {stageOptions.map((s) => <option key={s} value={s}>{errStageLabel(s)}</option>)}
              </select>
              <select name="state" className="input py-2" defaultValue={state}>
                {STATES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
              </select>
              <div className="flex gap-2">
                <button type="submit" className="btn-primary">Показать</button>
                {(runId || stage || state !== "open") && <Link href={qs({ run: undefined, stage: undefined, state: undefined })} className="btn-ghost">Сбросить</Link>}
              </div>
            </form>
            <p className="help mt-2">
              {periodText}: групп {groups.length} · {state === "resolved" ? "устранённых" : "открытых"} ошибок {state === "resolved" ? groups.reduce((s, g) => s + g.count - g.open, 0) : openTotal}
              {failedNow > 0 && <> · статей сейчас в «Ошибке» <b className="text-danger">{failedNow}</b></>}
              {retries.length > 0 && <> · временных сбоев {retries.reduce((s, r) => s + r.count, 0)}</>}
            </p>
          </Card>

          <Card title="Горит сейчас (последний час)" description="Сравнение с предыдущим часом: если ошибка растёт — это поломка, сообщите разработчику.">
            {hot.length === 0 ? (
              <p className="help">За последний час новых ошибок нет.</p>
            ) : (
              <ul className="space-y-1 text-[14px]">
                {hot.map(([sig, h]) => (
                  <li key={sig} className="flex flex-wrap items-center gap-2">
                    <Badge tone={h.now > h.prev ? "danger" : "warn"}>{h.now} за час</Badge>
                    <span className="help">было {h.prev}</span>
                    <span className="font-medium min-w-0 [overflow-wrap:anywhere]">{h.title}</span>
                    <span className="help">· {errStageLabel(h.stage)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {groups.length === 0 ? (
            <Empty title={state === "resolved" ? "Устранённых ошибок нет" : "Неустранённых ошибок нет"} hint={`${periodText[0].toUpperCase()}${periodText.slice(1)} по выбранным фильтрам.`} />
          ) : (
            <Card title={`Группы ошибок · ${groups.length}`} description="Одна группа — одна сигнатура (текст без чисел и id). «Вернуть в работу» ставит статьи группы со статусом «Ошибка» обратно в очередь с того же этапа; «Устранено» скрывает группу из открытых (в рамках фильтра).">
              <ErrorGroups groups={groups} scope={{ siteId, runId, stage, days: days || undefined }} showSites={!siteId} />
            </Card>
          )}

          <Card title="Временные сбои — воркер повторил сам" description="Этап упал на временной ошибке (сеть, лимит, таймаут) и был повторён. В «Ошибки» не попадают, но много повторов — повод разобраться: это задержки и лишний расход.">
            <RetryGroups retries={retries} />
          </Card>
        </div>
      </>
    );
  }

  /* ───────── Вызовы ИИ ───────── */
  if (tab === "ai") {
    const project = await prisma.project.findUnique({ where: { slug: PROJECT_SLUG }, select: { id: true } });
    const aiSince = since ?? new Date(Date.now() - 365 * 86400_000);
    let refIds: string[] | null = null;
    if (articleId) refIds = [articleId];
    else if (siteId) refIds = (await prisma.article.findMany({ where: { ...(await articleWhere(me)), siteId, updatedAt: { gte: aiSince } }, select: { id: true }, take: 2000 })).map((a) => a.id);
    else if (me.role !== "ADMIN") refIds = (await prisma.article.findMany({ where: { ...(await articleWhere(me)), updatedAt: { gte: aiSince } }, select: { id: true }, take: 5000 })).map((a) => a.id);
    const logs = project
      ? await prisma.usageLog.findMany({
          where: { projectId: project.id, createdAt: { gte: aiSince }, ...(refIds ? { refId: { in: refIds } } : {}) },
          orderBy: { createdAt: "desc" },
          take: 300,
          include: { provider: { select: { name: true } }, model: { select: { name: true, modelId: true } }, slot: { select: { key: true, name: true } }, user: { select: { name: true } } },
        })
      : [];
    const artIds = [...new Set(logs.map((l) => l.refId).filter((x): x is string => !!x))];
    const arts = artIds.length ? await prisma.article.findMany({ where: { id: { in: artIds } }, select: { id: true, keyword: true, site: { select: { name: true } } } }) : [];
    const totalCost = logs.reduce((a, l) => a + (l.costUsd ?? 0), 0);
    const failed = logs.filter((l) => !l.ok).length;
    return (
      <>
        {header}
        <Card title={`Вызовы ИИ · ${logs.length}${logs.length === 300 ? "+" : ""}`} description={`${articleId ? "Фильтр по статье. " : ""}${periodText[0].toUpperCase()}${periodText.slice(1)}: ${canCosts ? `${fmtMoney(totalCost)}, ` : ""}ошибок ${failed}.`} actions={articleId ? <Link href={qs({ article: undefined })} className="btn-ghost btn-sm">Снять фильтр статьи</Link> : null}>
          {!project ? (
            <p className="help">Проект «articles» не найден в портале — выполните seed.</p>
          ) : logs.length === 0 ? (
            <p className="help">Вызовов за период нет.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Когда</th>
                    <th>Статья</th>
                    <th>Слот</th>
                    <th className="col-md">Провайдер · модель</th>
                    <th className="col-md">Токены</th>
                    <th className="col-md">Время</th>
                    <th>Стоимость</th>
                    <th>Итог</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => {
                    const a = arts.find((x) => x.id === l.refId);
                    return (
                      <tr key={l.id}>
                        <td className="whitespace-nowrap">{fmtDate(l.createdAt)}</td>
                        <td className="max-w-xs">
                          {a ? (
                            <>
                              <Link href={`/pinterest/articles/articles/${a.id}`} className="hover:underline">{a.keyword}</Link>
                              <div className="help">{a.site.name} · <Link href={qs({ article: a.id })} className="underline">только эта</Link></div>
                            </>
                          ) : (
                            <span className="help">{l.refId ? l.refId.slice(0, 8) : "—"}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap">{l.slot?.name ?? l.slot?.key ?? "—"}</td>
                        <td className="col-md whitespace-nowrap">{l.provider.name}{l.model ? ` · ${l.model.modelId}` : ""}</td>
                        <td className="col-md whitespace-nowrap help">{l.inputTokens.toLocaleString("ru-RU")} / {l.outputTokens.toLocaleString("ru-RU")}</td>
                        <td className="col-md whitespace-nowrap help">{(l.durationMs / 1000).toFixed(1)} с</td>
                        <td className="whitespace-nowrap">{canCosts ? fmtMoney(l.costUsd) : "—"}</td>
                        <td>
                          {l.ok ? (
                            <Badge tone="ok">ок</Badge>
                          ) : l.error ? (
                            // текст ошибки по нажатию: title на телефоне не виден
                            <details title={l.error}>
                              <summary className="cursor-pointer list-none"><Badge tone="danger">ошибка</Badge></summary>
                              <div className="help mt-1 max-w-xs [overflow-wrap:anywhere]">{l.error}</div>
                            </details>
                          ) : (
                            <Badge tone="danger">ошибка</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </>
    );
  }

  /* ───────── Расходы ───────── */
  if (!canCosts) {
    return (
      <>
        {header}
        <Empty title="Расходы скрыты" hint="Нужно право «Расход: команда» или «все» — попросите администратора." />
      </>
    );
  }
  const c = await costBreakdown({ siteIds, siteId, since });
  const runIds = c.byRun.map((r) => r.id);
  const runRows = runIds.length ? await prisma.artRun.findMany({ where: { id: { in: runIds } }, select: { id: true, name: true, siteId: true, createdAt: true } }) : [];
  const runMap = new Map(runRows.map((r) => [r.id, r]));
  const noRun = c.bySite.reduce((s, x) => s + x.total, 0) - c.byRun.reduce((s, x) => s + x.total, 0);
  // Сайты × дни: только при небольшом числе сайтов и периоде (иначе таблица слишком широкая).
  const daySites = c.bySite.slice(0, 8).map((s) => s.id);
  const dayKeys = [...new Set(c.bySiteDay.map((x) => x.day))].sort().reverse();
  return (
    <>
      {header}
      <div className="space-y-4">
        <Card title={`Расходы ${periodText}`} description="Считаются по каждому платному вызову (журнал UsageLog, точная цена провайдера). Фаза определяется по времени вызова: окно этапа воркера или окно ИИ-модерации статьи. ИИ-модерация входит в общую сумму один раз.">
          <CostSummary c={c} periodNote={periodText} />
        </Card>
        {days > 0 && c.total > 0 && days <= 90 && (
          <Card title="По дням" description="Высота — расход за день (UTC), цвет — фаза.">
            <CostDays c={c} days={days} />
          </Card>
        )}
        <Card title="Сайты × фазы" description="Итог строки = сумма фаз; итог таблицы = общая сумма выше.">
          <CostMatrix firstCol="Сайт" rows={c.bySite.map((s) => ({ id: s.id, name: siteName.get(s.id) ?? s.id.slice(0, 8), href: `/pinterest/articles/sites/${s.id}?tab=stats`, articles: s.articles, total: s.total, phases: s.phases }))} empty="Расходов за период нет." />
        </Card>
        <Card title={`Запуски · ${c.byRun.length}`} description={`Расход статей каждого запуска ${periodText}.${noRun > 0.000_001 ? ` Статьи без запуска: ${fmtMoney(noRun)}.` : ""}`}>
          <CostMatrix firstCol="Запуск" rows={c.byRun.map((r) => { const run = runMap.get(r.id); return { id: r.id, name: run?.name || `Запуск ${r.id.slice(0, 8)}`, sub: run ? `${siteName.get(run.siteId) ?? ""} · ${fmtDate(run.createdAt)}` : undefined, href: `/pinterest/articles/runs/${r.id}`, articles: r.articles, total: r.total, phases: r.phases }; })} empty="Запусков с расходом за период нет." />
        </Card>
        {days > 0 && daySites.length > 0 && dayKeys.length > 0 && (
          <Card title="Сайты по дням" description="Расход каждого сайта за день (UTC).">
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>День</th>{daySites.map((id) => <th key={id} className="text-right whitespace-nowrap">{siteName.get(id) ?? id.slice(0, 8)}</th>)}<th className="text-right">Всего</th></tr></thead>
                <tbody>
                  {dayKeys.map((d) => {
                    const row = c.bySiteDay.filter((x) => x.day === d);
                    return (
                      <tr key={d}>
                        <td className="whitespace-nowrap">{d}</td>
                        {daySites.map((id) => { const v = row.find((x) => x.siteId === id)?.total ?? 0; return <td key={id} className="text-right tabular-nums">{v > 0 ? fmtMoney(v) : "—"}</td>; })}
                        <td className="text-right tabular-nums font-semibold">{fmtMoney(row.reduce((s, x) => s + x.total, 0))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {c.bySite.length > daySites.length && <p className="help mt-2">Показаны 8 самых дорогих сайтов; «Всего» — по всем.</p>}
          </Card>
        )}
      </div>
    </>
  );
}
