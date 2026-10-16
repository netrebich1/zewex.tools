import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAnalytics, accountWhere } from "@/lib/analytics/access";
import { analyticsContext, prevLabel } from "@/lib/analytics/page";
import { derive, dims, hasData, hourHeatmap, perSite, series, totals } from "@/lib/analytics/query";
import { DIM_LABELS } from "@/lib/analytics/types";
import { plural } from "@/lib/analytics/format";
import { AnalyticsNav } from "@/components/analytics/AnalyticsNav";
import { PeriodBar } from "@/components/analytics/PeriodBar";
import { GroupChips } from "@/components/analytics/GroupChips";
import { Kpis } from "@/components/analytics/Kpis";
import { TimeChart } from "@/components/analytics/TimeChart";
import { SitesTable, type SiteRow } from "@/components/analytics/SitesTable";
import { DimBars } from "@/components/analytics/DimBars";
import { HourHeatmap } from "@/components/analytics/HourHeatmap";
import { Alert, Card, Empty, PageHeader, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Обзор: все сайты (или группа) — показатели, график, таблица сайтов, каналы/страны/устройства, часы. */
export default async function AnalyticsHome({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireAnalytics();
  const params = await searchParams;
  const ctx = await analyticsContext(me, params);
  const { range: r, ids, list, groups, group } = ctx;

  if (!ctx.sites.length) {
    const accounts = await prisma.gaAccount.count({ where: accountWhere(me) });
    return (
      <>
        <PageHeader title="Трафик сайтов" subtitle="Все ваши сайты из Google Analytics в одном кабинете: визиты, страницы, источники, сравнение периодов." />
        <AnalyticsNav />
        <Empty
          title={accounts ? "Выберите, какие сайты показывать" : "Подключите Google-аккаунт"}
          hint={accounts ? "Аккаунт подключён, но ни один сайт пока не включён. В настройках отметьте сайты — история за год загрузится за несколько минут." : "Нажмите «Подключить Google-аккаунт» в настройках и выберите аккаунт, где есть доступ к Google Analytics. Аккаунтов можно подключить сколько угодно."}
          action={<Link href="/analytics/settings" className="btn-brand">Открыть настройки</Link>}
        />
      </>
    );
  }

  const [cur, prev, chart, stats, channels, countries, devices, heat, any] = await Promise.all([
    totals(ids, r.from, r.to),
    r.prev ? totals(ids, r.prev.from, r.prev.to) : null,
    series(ids, r),
    perSite(ids, r),
    dims(ids, r, "channel", 8),
    dims(ids, r, "country", 8),
    dims(ids, r, "device", 4),
    r.days <= 120 ? hourHeatmap(ids, r.from, r.to) : null,
    hasData(ids),
  ]);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const rows: SiteRow[] = list.map((s) => {
    const st = stats.get(s.id)!;
    const d = derive(st.cur);
    return { id: s.id, name: s.name, host: s.host, groups: s.groupIds.map((g) => groupById.get(g)!).filter(Boolean), sessions: st.cur.sessions, prevSessions: st.prev?.sessions ?? null, users: st.cur.users, pageviews: st.cur.pageviews, bounce: d.bounce, duration: d.duration, spark: st.spark, backfilling: s.backfilling, error: s.lastSyncError };
  });
  const loading = list.filter((s) => s.backfilling && !s.lastSyncError).length;
  const errors = list.filter((s) => s.lastSyncError).length;

  return (
    <>
      <PageHeader
        title={group ? group.name : "Трафик сайтов"}
        subtitle={group ? `Группа · ${list.length} ${plural(list.length, "сайт", "сайта", "сайтов")}` : `${list.length} ${plural(list.length, "сайт", "сайта", "сайтов")} из Google Analytics. Данные обновляются раз в час.`}
        actions={<a href={`/api/analytics/export?kind=sites&${ctx.qs}`} className="btn-ghost btn-sm">Скачать CSV</a>}
      />
      <AnalyticsNav />
      <PeriodBar range={r} />
      <GroupChips groups={groups} active={group?.id} total={ctx.sites.length} href={(id) => ctx.link("/analytics", { group: id })} />
      {!any && <div className="mb-4"><Alert tone="neutral">История ещё загружается из Google Analytics — первые цифры появятся через пару минут, обновите страницу.</Alert></div>}
      {any && (loading > 0 || errors > 0) && (
        <div className="mb-4"><Alert tone={errors ? "warn" : "neutral"}>
          {loading > 0 && <>Для {loading} {plural(loading, "сайта", "сайтов", "сайтов")} история ещё догружается — цифры за старые даты пока неполные. </>}
          {errors > 0 && <>У {errors} {plural(errors, "сайта", "сайтов", "сайтов")} ошибка синхронизации — подробности в <Link href="/analytics/settings" className="underline">настройках</Link>.</>}
        </Alert></div>
      )}
      <Kpis cur={cur} prev={prev} />
      <Card className="mb-4"><TimeChart cur={chart.cur} prev={chart.prev} grain={r.grain} metric={r.metric} prevLabel={prevLabel(r)} /></Card>
      <Card className="mb-4" title="Сайты" description="Нажмите на сайт, чтобы увидеть его страницы и источники. Столбцы сортируются.">
        <SitesTable rows={rows} qs={ctx.qs} />
      </Card>
      <div className="grid gap-4 md:grid-cols-3 mb-4">
        <Card title={DIM_LABELS.channel}><DimBars kind="channel" rows={channels} total={cur.sessions} /></Card>
        <Card title={DIM_LABELS.country}><DimBars kind="country" rows={countries} total={cur.sessions} /></Card>
        <Card title={DIM_LABELS.device}><DimBars kind="device" rows={devices} total={cur.sessions} /></Card>
      </div>
      {heat && <Card title="Визиты по часам" description="Когда приходят посетители: по дням недели и часам суток (в часовом поясе каждого сайта)."><HourHeatmap grid={heat} /></Card>}
    </>
  );
}

