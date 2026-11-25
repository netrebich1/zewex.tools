import Link from "next/link";
import { requireAnalytics } from "@/lib/analytics/access";
import { analyticsContext, one } from "@/lib/analytics/page";
import { pages, PAGE_SORTS, type PageSort } from "@/lib/analytics/query";
import { AnalyticsNav } from "@/components/analytics/AnalyticsNav";
import { PeriodBar } from "@/components/analytics/PeriodBar";
import { GroupChips } from "@/components/analytics/GroupChips";
import { PagesTable } from "@/components/analytics/PagesTable";
import { SearchBox } from "@/components/analytics/SearchBox";
import { ParamSelect } from "@/components/analytics/ParamSelect";
import { Card, Empty, PageHeader, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";
const PER_PAGE = 50;

/** Все страницы всех сайтов: поиск по адресу и заголовку, фильтр по сайту и группе, рост и падение к прошлому периоду. */
export default async function PagesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireAnalytics();
  const sp = await searchParams;
  const ctx = await analyticsContext(me, sp);
  const { range: r, groups, group } = ctx;
  const siteId = one(sp, "site");
  const site = ctx.list.find((s) => s.id === siteId);
  const ids = site ? [site.id] : ctx.ids;
  const sort: PageSort = PAGE_SORTS.some((s) => s.key === one(sp, "sort")) ? (one(sp, "sort") as PageSort) : "views";
  const pg = Math.max(1, Number(one(sp, "pg")) || 1);
  const q = one(sp, "q");
  const keep = { site: site?.id, q, sort: sort === "views" ? undefined : sort };
  const link = (extra: Record<string, string | undefined>) => ctx.link("/analytics/pages", { ...keep, ...extra });

  if (!ctx.sites.length) {
    return (
      <>
        <PageHeader title="Страницы" />
        <AnalyticsNav />
        <Empty title="Сайты ещё не подключены" action={<Link href="/analytics/settings" className="btn-brand">Открыть настройки</Link>} />
      </>
    );
  }
  const { rows, total } = await pages(ids, r, { q, sort, limit: PER_PAGE, offset: (pg - 1) * PER_PAGE });
  const sites = new Map(ctx.sites.map((s) => [s.id, { id: s.id, name: s.name, host: s.host, url: s.url }]));

  return (
    <>
      <PageHeader title="Страницы" subtitle="Какие статьи растут и падают по всем сайтам сразу. Поиск — по адресу и заголовку." actions={<a href={`/api/analytics/export?kind=pages&${ctx.qs}${site ? `&site=${site.id}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}&sort=${sort}`} className="btn-ghost btn-sm">Скачать CSV</a>} />
      <AnalyticsNav />
      <PeriodBar range={r} />
      <GroupChips groups={groups} active={group?.id} total={ctx.sites.length} href={(id) => ctx.link("/analytics/pages", { ...keep, site: undefined, group: id })} />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SearchBox placeholder="Адрес или заголовок…" className="w-full sm:w-80" />
          <ParamSelect param="site" allLabel={group ? `Все сайты группы (${ctx.list.length})` : `Все сайты (${ctx.list.length})`} options={ctx.list.map((s) => ({ value: s.id, label: s.host || s.name }))} />
          <div className="inline-flex gap-1 rounded-xl bg-ink/5 p-1">
            {PAGE_SORTS.map((s) => <Link key={s.key} href={link({ sort: s.key === "views" ? undefined : s.key, pg: undefined })} className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${sort === s.key ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>{s.label}</Link>)}
          </div>
          <span className="help ml-auto">{sort === "growth" ? "Сначала страницы с наибольшим приростом просмотров." : sort === "decline" ? "Сначала страницы с наибольшим падением (включая упавшие до нуля)." : `Найдено страниц: ${total}`}</span>
        </div>
        <PagesTable rows={rows} sites={sites} showSite={!site} total={total} page={pg} perPage={PER_PAGE} pageHref={(p) => link({ pg: p > 1 ? String(p) : undefined })} />
      </Card>
    </>
  );
}
