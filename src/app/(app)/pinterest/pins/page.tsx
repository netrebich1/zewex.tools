import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import { runDefaultsFrom } from "@/lib/pins/types";
import { pinRunWhere, pinSiteWhere } from "@/lib/sites/access";
import { StockCalendar } from "@/components/pins/StockCalendar";
import { sitesStock } from "@/lib/pins/runs/stats";
import { RunsBoard } from "@/components/pins/RunsBoard";
import { runsOverview } from "@/lib/pins/runs/status";

export const dynamic = "force-dynamic";

export default async function PinsHome() {
  const me = await requireUser();
  const sites = await prisma.pinSite.findMany({ where: { ...(await pinSiteWhere(me)), isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, recipe: true } });
  const [overview, stock, lastRuns] = await Promise.all([
    runsOverview(await pinRunWhere(me)),
    sitesStock(sites.map((s) => s.id), 92),
    prisma.pinRun.findMany({ where: { siteId: { in: sites.map((s) => s.id) }, NOT: { name: { startsWith: "__" } } }, orderBy: { createdAt: "desc" }, distinct: ["siteId"], select: { siteId: true, settings: true } }),
  ]);
  // Ориентир «пинов в день» — из последнего прогона сайта.
  const calendarSites = sites
    .map((s) => ({ id: s.id, name: s.name, target: runDefaultsFrom(s.recipe, lastRuns.find((x) => x.siteId === s.id)?.settings ?? null).schedule.pinsPerDay, counts: stock.bySite.get(s.id) ?? [] }))
    .sort((a, b) => {
      const run = (c: number[]) => { let n = 0; while (n < c.length && c[n] > 0) n++; return n; };
      return run(a.counts) - run(b.counts) || a.name.localeCompare(b.name);
    });

  return (
    <>
      <PageHeader title="Сегодня" subtitle="Прогоны в работе и запас пинов по сайтам." actions={<><Link href="/pinterest/pins/sites" className="btn-ghost">Сайты</Link><Link href="/pinterest/pins/runs/new" className="btn-brand">Новый прогон</Link></>} />
      <div className="space-y-5">
        <Card title="Прогоны" description="Что сейчас выполняется, на каком этапе, где нужна модерация или есть ошибка. Обновляется само.">
          <RunsBoard initial={overview} />
        </Card>

        <Card title="Запас по датам" description="Строка — сайт, столбцы — дни, цифра — пинов в день. Сайты без запаса сверху. Нажмите на сайт, чтобы открыть его, или «Прогон», чтобы запустить сборку.">
          <StockCalendar sites={calendarSites} days={stock.days} />
        </Card>

      </div>
    </>
  );
}
