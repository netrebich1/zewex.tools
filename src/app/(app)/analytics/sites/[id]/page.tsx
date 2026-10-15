import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { propertyWhere, requireAnalytics } from "@/lib/analytics/access";
import { analyticsContext, one, prevLabel } from "@/lib/analytics/page";
import { dims, hourHeatmap, pages, series, totals, PAGE_SORTS, type PageSort } from "@/lib/analytics/query";
import { DIM_LABELS } from "@/lib/analytics/types";
import { AnalyticsNav } from "@/components/analytics/AnalyticsNav";
import { PeriodBar } from "@/components/analytics/PeriodBar";
import { Kpis } from "@/components/analytics/Kpis";
import { TimeChart } from "@/components/analytics/TimeChart";
import { DimBars } from "@/components/analytics/DimBars";
import { HourHeatmap } from "@/components/analytics/HourHeatmap";
import { PagesTable } from "@/components/analytics/PagesTable";
import { SearchBox } from "@/components/analytics/SearchBox";
import { Realtime } from "@/components/analytics/Realtime";
import { Alert, Card, PageHeader, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "pages", label: "Страницы" },
  { key: "sources", label: "Источники" },
  { key: "geo", label: "География" },
  { key: "devices", label: "Устройства" },
  { key: "hours", label: "Часы" },
] as const;
type Tab = (typeof TABS)[number]["key"];
const PER_PAGE = 50;

/** Сайт: показатели и график за период, вкладки — страницы (поиск, рост/падение), источники, география, устройства, часы. */
export default async function SitePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireAnalytics();
  const { id } = await params;
  const sp = await searchParams;
  const site = await prisma.gaProperty.findFirst({ where: { id, ...propertyWhere(me) }, include: { groups: { include: { group: true } }, account: { select: { email: true, status: true } } } });
  if (!site) notFound();
  const ctx = await analyticsContext(me, sp, site.timezone);
  const r = ctx.range;
  const ids = [site.id];
  const tab: Tab = TABS.some((t) => t.key === one(sp, "tab")) ? (one(sp, "tab") as Tab) : "pages";
  const sort: PageSort = PAGE_SORTS.some((s) => s.key === one(sp, "sort")) ? (one(sp, "sort") as PageSort) : "views";
  const pg = Math.max(1, Number(one(sp, "pg")) || 1);
  const q = one(sp, "q");

  const [cur, prev, chart] = await Promise.all([totals(ids, r.from, r.to), r.prev ? totals(ids, r.prev.from, r.prev.to) : null, series(ids, r)]);
  const tabLink = (t: Tab) => ctx.link(`/analytics/sites/${site.id}`, { tab: t === "pages" ? undefined : t });
  const pagesLink = (extra: Record<string, string | undefined>) => ctx.link(`/analytics/sites/${site.id}`, { q, sort: sort === "views" ? undefined : sort, ...extra });

  return (
    <>
      <PageHeader
        back={{ href: ctx.link("/analytics"), label: "Все сайты" }}
        title={site.host || site.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {site.host && <span>{site.name}</span>}
            {site.url && <a href={site.url} target="_blank" rel="noopener noreferrer" className="hover:text-ink hover:underline">{site.url.replace(/^https?:\/\//, "")} ↗</a>}
            <span>· {site.gaAccountName} ({site.account.email})</span>
            {site.groups.map((g) => <span key={g.groupId} className="badge text-white" style={{ background: g.group.color }}>{g.group.name}</span>)}
          </span>
        }
        actions={<><Realtime ids={ids} /><a href={`/api/analytics/export?kind=pages&site=${site.id}&${ctx.qs}${q ? `&q=${encodeURIComponent(q)}` : ""}&sort=${sort}`} className="btn-ghost btn-sm">Скачать страницы CSV</a></>}
      />
      <AnalyticsNav />
      <PeriodBar range={r} />
      {site.lastSyncError && <div className="mb-4"><Alert tone="warn">Синхронизация с Google Analytics споткнулась: {site.lastSyncError}. Воркер повторит попытку сам; если ошибка про доступ — переподключите аккаунт в настройках.</Alert></div>}
      <Kpis cur={cur} prev={prev} />
      <Card className="mb-4"><TimeChart cur={chart.cur} prev={chart.prev} grain={r.grain} metric={r.metric} prevLabel={prevLabel(r)} /></Card>

      <div className="mb-4 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
        <div className="inline-flex gap-1 rounded-xl bg-ink/5 p-1 whitespace-nowrap">
          {TABS.map((t) => <Link key={t.key} href={tabLink(t.key)} className={`rounded-lg px-3.5 py-1.5 text-[14px] font-semibold transition ${tab === t.key ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>{t.label}</Link>)}
        </div>
      </div>

      {tab === "pages" && <PagesBlock siteId={site.id} ids={ids} r={r} q={q} sort={sort} pg={pg} link={pagesLink} site={{ id: site.id, name: site.name, host: site.host, url: site.url }} />}
      {tab === "sources" && <SourcesBlock ids={ids} r={r} total={cur.sessions} />}
      {tab === "geo" && <Card title={DIM_LABELS.country}><DimBars kind="country" rows={await dims(ids, r, "country", 30)} total={cur.sessions} /></Card>}
      {tab === "devices" && <Card title={DIM_LABELS.device}><DimBars kind="device" rows={await dims(ids, r, "device", 6)} total={cur.sessions} /></Card>}
      {tab === "hours" && <Card title="Визиты по часам" description={`Часовой пояс сайта: ${site.timezone}.`}>{r.days <= 120 ? <HourHeatmap grid={await hourHeatmap(ids, r.from, r.to)} /> : <p className="help">Выберите период до 120 дней.</p>}</Card>}
    </>
  );
}

async function PagesBlock({ ids, r, q, sort, pg, link, site }: { siteId: string; ids: string[]; r: Awaited<ReturnType<typeof analyticsContext>>["range"]; q?: string; sort: PageSort; pg: number; link: (extra: Record<string, string | undefined>) => string; site: { id: string; name: string; host: string | null; url: string | null } }) {
  const { rows, total } = await pages(ids, r, { q, sort, limit: PER_PAGE, offset: (pg - 1) * PER_PAGE });
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchBox placeholder="Адрес или заголовок страницы…" className="w-full sm:w-80" />
        <div className="inline-flex gap-1 rounded-xl bg-ink/5 p-1">
          {PAGE_SORTS.map((s) => <Link key={s.key} href={link({ sort: s.key === "views" ? undefined : s.key, pg: undefined })} className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${sort === s.key ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>{s.label}</Link>)}
        </div>
        <span className="help ml-auto">{sort === "growth" ? "Сначала страницы, которые прибавили больше всего просмотров к прошлому периоду." : sort === "decline" ? "Сначала страницы, которые потеряли больше всего просмотров (включая упавшие до нуля)." : `Страниц за период: ${total}`}</span>
      </div>
      <PagesTable rows={rows} sites={new Map([[site.id, site]])} showSite={false} total={total} page={pg} perPage={PER_PAGE} pageHref={(p) => link({ pg: p > 1 ? String(p) : undefined })} />
    </Card>
  );
}

async function SourcesBlock({ ids, r, total }: { ids: string[]; r: Awaited<ReturnType<typeof analyticsContext>>["range"]; total: number }) {
  const [channels, sources, referrers] = await Promise.all([dims(ids, r, "channel", 12), dims(ids, r, "source", 20), dims(ids, r, "referrer", 20)]);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title={DIM_LABELS.channel}><DimBars kind="channel" rows={channels} total={total} /></Card>
      <Card title={DIM_LABELS.source} description="Откуда пришёл визит (google, pinterest, direct…)."><DimBars kind="source" rows={sources} total={total} /></Card>
      <Card title={DIM_LABELS.referrer} description="Только переходы по ссылкам с других сайтов."><DimBars kind="referrer" rows={referrers} total={total} /></Card>
    </div>
  );
}
