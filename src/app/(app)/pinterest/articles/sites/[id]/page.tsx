import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Alert, Badge, Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { syncSiteCategories, toggleArtSiteActive } from "@/actions/articles";
import { loadArtSite } from "@/lib/articles/access";
import { mergeSiteSettings } from "@/lib/articles/types";
import { STATUS_FILTER_GROUPS, queuePage, siteRuns, siteStats, sitesFunnel } from "@/lib/articles/queries";
import { ArticlesTable } from "@/components/articles/ArticlesTable";
import { SiteFunnel } from "@/components/articles/SiteFunnel";
import { SiteSettingsForm, type WpCategoryOption } from "@/components/articles/SiteSettingsForm";
import { SheetsCard } from "@/components/articles/SheetsCard";
import { sheetsConnection, siteDomains } from "@/lib/articles/sheets";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS = [["queue", "Очередь"], ["settings", "Настройки"], ["stats", "Статистика"]] as const;

/** Сайт в сервисе «Статьи»: очередь (фильтры, пагинация, массовые действия), настройки, статистика. */
export default async function ArticlesSitePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const q = await searchParams;
  const tab = (TABS.some(([k]) => k === sp(q, "tab")) ? sp(q, "tab") : "queue") as (typeof TABS)[number][0];
  const site = await loadArtSite(me, id);
  if (!site) notFound();
  const settings = mergeSiteSettings(site.settings);
  const funnelRow = (await sitesFunnel(me)).find((s) => s.id === id);
  const categories = ((site.wpCategories as WpCategoryOption[] | null) ?? []).filter((c) => typeof c?.id === "number");
  const nicheName = site.nicheCode ? (await prisma.artNiche.findUnique({ where: { code: site.nicheCode }, select: { name: true } }))?.name ?? site.nicheCode : "не задана";

  const subtitle = `${nicheName} · ${site.defaultRecipe?.name ?? "рецепт не задан"} · ${settings.photoCount.mode === "exact" ? `${settings.photoCount.min} фото` : `${settings.photoCount.min}–${settings.photoCount.max} фото`}${site.isActive ? "" : " · в архиве"}`;

  return (
    <>
      <PageHeader back={{ href: "/pinterest/articles/sites", label: "Сайты" }} title={site.name} subtitle={subtitle}
        actions={<>{site.accessId && <Link href={`/sites/${site.accessId}`} className="btn-ghost">Доступ и команды</Link>}{site.isActive && <Link href={`/pinterest/articles/runs/new?site=${id}`} className="btn-brand">Новый запуск</Link>}</>} />
      {funnelRow && <div className="mb-4"><SiteFunnel siteId={id} f={funnelRow.funnel} /></div>}
      <div className="mb-4 flex gap-2">
        {TABS.map(([k, l]) => <Link key={k} href={`/pinterest/articles/sites/${id}?tab=${k}`} className={`badge px-3 py-1 ${tab === k ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{l}</Link>)}
      </div>

      {tab === "queue" && <QueueTab siteId={id} q={q} />}

      {tab === "settings" && (
        <div className="space-y-4">
          {!site.accessId && <Alert tone="warn">Сайт не привязан к доступу WordPress: публикация и синхронизация категорий работать не будут. Привяжите доступ в разделе «Сайты».</Alert>}
          {site.access && site.access.lastCheckOk === false && <Alert tone="danger">Последняя проверка подключения к WordPress не прошла — проверьте доступ на <Link href={`/sites/${site.accessId}`} className="underline">странице сайта</Link>.</Alert>}
          <Card title="Настройки сайта в сервисе «Статьи»" description="Что относится к сайту целиком и значения по умолчанию для новых запусков. Ключи и партии задаются при запуске.">
            <SiteSettingsForm
              site={{ id: site.id, name: site.name, nicheCode: site.nicheCode, defaultRecipeId: site.defaultRecipeId }}
              settings={settings}
              categories={categories}
              niches={await prisma.artNiche.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, select: { code: true, name: true, parentCode: true } })}
              recipes={await prisma.artRecipe.findMany({ orderBy: [{ nicheCode: "asc" }, { name: "asc" }], select: { id: true, name: true, nicheCode: true, format: true, isActive: true } })}
            />
          </Card>
          <Card title="Категории WordPress" description={categories.length ? `В кэше ${categories.length} категорий. Обновите после изменений на сайте.` : "Категории ещё не загружались. Нужны для правил «ключ → категория» и выбора категории по умолчанию."}>
            <div className="flex flex-wrap items-center gap-3">
              <ActionForm action={syncSiteCategories} hidden={{ id }} className="inline">
                <SubmitButton className="btn-primary" pendingText="Загружаю…">Синхронизировать категории WordPress</SubmitButton>
              </ActionForm>
              {categories.length > 0 && <details className="text-[13px]"><summary className="help cursor-pointer">Показать список</summary><div className="mt-2 flex flex-wrap gap-1.5">{categories.map((c) => <Badge key={c.id}>{c.name} <span className="opacity-60">#{c.id}</span></Badge>)}</div></details>}
            </div>
          </Card>
          <SheetsCard siteId={id} domain={siteDomains(site)[0] ?? ""} sheetUrl={settings.sheetUrl} sheets={await sheetsConnection()} isAdmin={me.role === "ADMIN"} />
          <ActionForm action={toggleArtSiteActive} hidden={{ id }}>
            {site.isActive
              ? <SubmitButton className="btn-ghost" pendingText="…">Убрать сайт в архив</SubmitButton>
              : <SubmitButton className="btn-ghost" pendingText="…">Вернуть сайт из архива</SubmitButton>}
          </ActionForm>
          <p className="help">В архиве воркер не берёт статьи сайта; история и настройки сохраняются.</p>
        </div>
      )}

      {tab === "stats" && <StatsTab siteId={id} />}
    </>
  );
}

async function QueueTab({ siteId, q }: { siteId: string; q: SearchParams }) {
  const status = sp(q, "status") ?? "";
  const runId = sp(q, "run") ?? "";
  const search = sp(q, "q") ?? "";
  const page = Math.max(1, Number(sp(q, "page")) || 1);
  const [data, runs] = await Promise.all([queuePage(siteId, { status: status || undefined, runId: runId || undefined, q: search || undefined, page, perPage: 50 }), siteRuns(siteId)]);
  const link = (p: number) => { const u = new URLSearchParams({ tab: "queue" }); if (status) u.set("status", status); if (runId) u.set("run", runId); if (search) u.set("q", search); if (p > 1) u.set("page", String(p)); return `/pinterest/articles/sites/${siteId}?${u}`; };
  return (
    <Card title="Очередь" description="Все статьи сайта. Отметьте нужные — действия сверху таблицы. Клик по ключу открывает карточку статьи.">
      <form method="get" action={`/pinterest/articles/sites/${siteId}`} className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
        <input type="hidden" name="tab" value="queue" />
        <select name="status" className="input py-2" defaultValue={status}>
          <option value="">Все статусы</option>
          {STATUS_FILTER_GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
        <select name="run" className="input py-2" defaultValue={runId}>
          <option value="">Все запуски</option>
          {runs.map((r) => <option key={r.id} value={r.id}>{r.name || r.id.slice(0, 8)} · {r._count.articles} · {r.createdAt.toLocaleDateString("ru-RU")}</option>)}
        </select>
        <input name="q" className="input py-2" defaultValue={search} placeholder="Поиск по ключу или адресу" />
        <div className="flex gap-2"><button type="submit" className="btn-primary">Показать</button>{(status || runId || search) && <Link href={`/pinterest/articles/sites/${siteId}?tab=queue`} className="btn-ghost">Сбросить</Link>}</div>
      </form>
      <p className="help mb-2">Найдено: {data.total}{data.pages > 1 ? ` · страница ${data.page} из ${data.pages}` : ""}</p>
      <ArticlesTable rows={data.rows} showRun emptyText={status || runId || search ? "По фильтру ничего не найдено" : "У сайта ещё нет статей. Нажмите «Новый запуск»."} />
      {data.pages > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {data.page > 1 && <Link href={link(data.page - 1)} className="btn-ghost btn-sm">← Назад</Link>}
          <span className="help">{data.page} / {data.pages}</span>
          {data.page < data.pages && <Link href={link(data.page + 1)} className="btn-ghost btn-sm">Вперёд →</Link>}
        </div>
      )}
    </Card>
  );
}

async function StatsTab({ siteId }: { siteId: string }) {
  const s = await siteStats(siteId, 30);
  const max = Math.max(1, ...s.days.map((d) => d.count));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="kpi"><span className="help">Опубликовано за 30 дней</span><span className="kpi-value">{s.completed30}</span></div>
        <div className="kpi"><span className="help">Опубликовано всего</span><span className="kpi-value">{s.completed}</span></div>
        <div className="kpi"><span className="help">Средняя стоимость статьи</span><span className="kpi-value">{s.avgCost == null ? "—" : `$${s.avgCost.toFixed(2)}`}</span></div>
        <div className="kpi"><span className="help">Расход на опубликованные</span><span className="kpi-value">${s.totalCost.toFixed(2)}</span></div>
      </div>
      <Card title="Опубликовано по дням" description="Последние 30 дней. Высота столбика — статей за день.">
        <div className="flex h-32 items-end gap-[3px]">
          {s.days.map((d) => (
            <div key={d.day} className="flex-1 flex flex-col items-center justify-end gap-1" title={`${d.day}: ${d.count}`}>
              {d.count > 0 && <span className="text-[10px] tabular-nums text-muted">{d.count}</span>}
              <div className={`w-full rounded-t ${d.count ? "bg-ok" : "bg-ink/5"}`} style={{ height: `${Math.max(2, (d.count / max) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between help"><span>{s.days[0]?.day}</span><span>{s.days[s.days.length - 1]?.day}</span></div>
      </Card>
      <Card title="Ошибки сайта за 30 дней" description="Сгруппированы по похожему тексту. Клик по статье в очереди покажет подробности.">
        {s.errors.length === 0 ? <p className="help">Ошибок не было.</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Раз</th><th>Этап</th><th>Сообщение</th><th className="hidden md:table-cell">Последняя</th></tr></thead>
            <tbody>{s.errors.map((e) => (
              <tr key={e.signature}><td className="tabular-nums"><Badge tone={e.unresolved ? "danger" : "neutral"}>{e.count}</Badge></td><td className="text-muted">{e.stage}</td><td className="max-w-[520px]"><div className="truncate" title={e.message}>{e.message}</div></td><td className="hidden md:table-cell text-muted whitespace-nowrap">{fmtDate(e.last)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
