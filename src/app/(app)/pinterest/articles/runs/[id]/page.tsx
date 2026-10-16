import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Alert, Badge, Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { canAccessArtSite } from "@/lib/articles/access";
import { PUBLISH_MODES, type ArtRunSettings } from "@/lib/articles/types";
import { STATUS_LABELS } from "@/lib/articles/labels";
import { runArticles, runProgress } from "@/lib/articles/queries";
import { ArticlesTable } from "@/components/articles/ArticlesTable";
import { badgeTone } from "@/components/articles/StatusBadge";
import { fmtDate, fmtMoney } from "@/lib/utils";
import { seesTeamCosts } from "@/lib/permissions";
import { costBreakdown } from "@/lib/articles/costs";
import { errorsSummary } from "@/lib/articles/errorsView";
import { CostArticlesTable, CostSummary } from "@/components/articles/CostBreakdown";
import { ErrorGroups, RetryGroups } from "@/components/articles/ErrorsTable";

export const dynamic = "force-dynamic";

/** Карточка запуска (партии ключей): прогресс по статусам, параметры, статьи с массовыми действиями, стоимость. */
export default async function ArticlesRunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const skipped = (sp(query, "skipped") ?? "").split("\n").filter(Boolean);
  const sheetWarn = sp(query, "sheetWarn") ?? "";
  const run = await prisma.artRun.findUnique({ where: { id }, include: { site: { select: { id: true, name: true, teamId: true, accessId: true } }, recipe: { select: { id: true, name: true, format: true } } } });
  if (!run || !(await canAccessArtSite(me, run.site))) notFound();
  const s = run.settings as unknown as ArtRunSettings;
  const canCosts = seesTeamCosts(me);
  const [progress, rows, author, costs, errs] = await Promise.all([
    runProgress(id), runArticles(id),
    run.createdById ? prisma.user.findUnique({ where: { id: run.createdById }, select: { name: true, email: true } }) : null,
    canCosts ? costBreakdown({ siteIds: [run.site.id], runId: id, withArticles: true }) : null,
    errorsSummary(me, { runId: id }, { runId: id }),
  ]);
  const pct = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  const search = [s.search?.country && `страна ${s.search.country}`, s.search?.language && `язык ${s.search.language}`, s.search?.freshness && `свежесть ${s.search.freshness}`].filter(Boolean).join(", ");

  return (
    <>
      <PageHeader back={{ href: `/pinterest/articles/sites/${run.site.id}`, label: run.site.name }} title={run.name || `Запуск ${id.slice(0, 8)}`}
        subtitle={`${run.site.name} · ${run.recipe?.name ?? (s.sheet ? "рецепты из таблицы" : "рецепт удалён")} · ${fmtDate(run.createdAt)}${author ? ` · ${author.name || author.email}` : ""}`}
        actions={<Link href={`/pinterest/articles/runs/new?site=${run.site.id}`} className="btn-ghost">Ещё запуск для сайта</Link>} />

      {sheetWarn && <div className="mb-4"><Alert tone="danger">{sheetWarn}</Alert></div>}
      {skipped.length > 0 && (
        <div className="mb-4"><Alert tone="warn"><div className="font-medium">{s.sheet ? "Строки таблицы, которые не взяты в работу" : "Пропущены ключи, которые уже есть у сайта"} ({skipped.length}):</div><ul className="mt-1 list-disc pl-5 text-[13px]">{skipped.map((k) => <li key={k}>{k}</li>)}</ul></Alert></div>
      )}

      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[14px]">Опубликовано <b>{progress.completed}</b> из <b>{progress.total}</b></span>
            {progress.live > 0 && <span className="help">в работе и очереди {progress.live}</span>}
            {progress.waiting > 0 && <span className="text-warn text-[13px]">ждут человека {progress.waiting}</span>}
            {progress.errors > 0 && <span className="text-danger text-[13px]">ошибок {progress.errors}</span>}
            {canCosts && <span className="ml-auto help">расход {fmtMoney(progress.costUsd)}</span>}
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-ink/5"><div className="h-full bg-ok transition-all" style={{ width: `${pct}%` }} /></div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {progress.byStatus.map((b) => <Badge key={b.status} tone={badgeTone(STATUS_LABELS[b.status].tone)}>{STATUS_LABELS[b.status].label}: {b.count}</Badge>)}
          </div>
        </Card>

        {costs && (
          <Card title={`Расходы запуска · ${fmtMoney(costs.total)}`} description="Все платные вызовы статей запуска (ИИ, поиск фото, ИИ-модерация) по фазам. Потеряно — статьи с ошибкой или остановленные.">
            <CostSummary c={costs} />
            {costs.articles.length > 0 && (
              <details className="mt-4">
                <summary className="help cursor-pointer">Расход по статьям ({costs.articles.length})</summary>
                <div className="mt-2"><CostArticlesTable c={costs} /></div>
              </details>
            )}
          </Card>
        )}

        <Card title={`Ошибки запуска${errs.open ? ` · открытых ${errs.open}` : ""}`} description="Ошибки статей этого запуска по группам и временные сбои, которые воркер повторил сам."
          actions={errs.groups.length > 0 ? <Link href={`/pinterest/articles/journal?tab=errors&site=${run.site.id}&run=${id}&days=0&state=all`} className="btn-ghost btn-sm">В журнале</Link> : null}>
          {errs.groups.length === 0 && errs.retries.length === 0 ? (
            <p className="help">Ошибок и повторов не было.</p>
          ) : (
            <div className="space-y-4">
              {errs.groups.length > 0 && <ErrorGroups groups={errs.groups.slice(0, 10)} scope={{ runId: id, siteId: run.site.id }} showSites={false} />}
              {errs.groups.length > 10 && <p className="help">Показаны 10 групп из {errs.groups.length} — остальные в журнале.</p>}
              {errs.retries.length > 0 && (
                <details>
                  <summary className="help cursor-pointer">Временные сбои: {errs.retryCount} повторов</summary>
                  <div className="mt-2"><RetryGroups retries={errs.retries} limit={10} /></div>
                </details>
              )}
            </div>
          )}
        </Card>

        <Card title="Параметры запуска" description="Сохранены в снимке каждой статьи: правка рецепта или настроек сайта на эту партию не влияет.">
          <dl className="grid gap-x-6 gap-y-1.5 text-[14px] sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex justify-between gap-3"><dt className="text-muted">Фото</dt><dd>{s.photoCount?.mode === "range" ? `${s.photoCount.min}–${s.photoCount.max}` : s.photoCount?.min ?? "—"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Модерация фото до текста</dt><dd>{s.sheet ? "по колонке «Режим»" : s.photoReview ? "да" : "нет"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Публикация</dt><dd>{PUBLISH_MODES.find((m) => m.value === s.publishMode)?.label ?? s.publishMode}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Поиск</dt><dd>{search || "как в рецепте"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Год в URL</dt><dd>{s.yearInUrlPercent == null ? "как в рецепте" : `${s.yearInUrlPercent}%`}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Тестовая метка</dt><dd>{s.testLabel || "—"}</dd></div>
            {s.sheet && <div className="flex justify-between gap-3"><dt className="text-muted">Источник ключей</dt><dd><a href={s.sheet.url} target="_blank" rel="noreferrer" className="text-info hover:underline">Google Таблица, вкладка «{s.sheet.tab}» ↗</a></dd></div>}
          </dl>
        </Card>

        <Card title={`Статьи · ${rows.length}`} description="Отметьте статьи для массовых действий. Клик по ключу — карточка статьи.">
          <ArticlesTable rows={rows} emptyText="В запуске нет статей" />
        </Card>
      </div>
    </>
  );
}
