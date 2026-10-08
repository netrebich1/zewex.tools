import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canAccessTeam } from "@/lib/pins/runs/actions";
import { Badge, Card, Empty, PageHeader, type SearchParams, sp } from "@/components/ui";
import { mergeRecipe } from "@/lib/pins/types";
import { RUN_STATUS_LABELS, runStatusTone } from "@/components/pins/labels";
import { fmtDate } from "@/lib/utils";
import { SiteCalendar } from "@/components/pins/SiteCalendar";
import { siteStock } from "@/lib/pins/runs/stats";

export const dynamic = "force-dynamic";

export default async function SitePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const tab = sp(await searchParams, "tab") ?? "overview";
  const site = await prisma.pinSite.findUnique({ where: { id }, include: { boards: { orderBy: { sortOrder: "asc" } }, team: true } });
  if (!site || !canAccessTeam(me, site.teamId)) notFound();
  const r = mergeRecipe(site.recipe);
  const [runs, stock] = await Promise.all([
    prisma.pinRun.findMany({ where: { siteId: id, NOT: { name: { startsWith: "__" } } }, orderBy: { createdAt: "desc" }, take: 50 }),
    siteStock(id, 35),
  ]);
  const tabs = [["overview", "Обзор"], ["runs", "Прогоны"]];

  return (
    <>
      <PageHeader back={{ href: "/pinterest/pins", label: "Сегодня" }} title={site.name} subtitle={`${site.team.name} · ИИ ${r.mix.ai}, фото ${r.mix.photos}, canvas ${r.mix.canvas}, pinora ${r.mix.pinora} на ссылку · ${r.schedule.pinsPerDay} в день`} actions={<><Link href={`/sites/${id}`} className="btn-ghost">Настройки сайта</Link><Link href={`/pinterest/pins/runs/new?site=${id}`} className="btn-brand">Новый прогон</Link></>} />
      <div className="mb-4 flex gap-2">
        {tabs.map(([k, l]) => <Link key={k} href={`/pinterest/pins/sites/${id}?tab=${k}`} className={`badge px-3 py-1 ${tab === k ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{l}</Link>)}
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          <Card title="Запас пинов по дням" description={`Цель: ${r.schedule.pinsPerDay} в день. Серым — дни без пинов, жёлтым — недобор, зелёным — норма.`}>
            <SiteCalendar days={stock} target={r.schedule.pinsPerDay} />
          </Card>
          <Card title="Доски и рецепт" description={`Досок: ${site.boards.length}. Рецепт, доски и WordPress настраиваются в общем разделе «Сайты».`}>
            <Link href={`/sites/${id}`} className="btn-primary">Открыть настройки сайта</Link>
          </Card>
        </div>
      )}

      {tab === "runs" && (
        <Card title="Прогоны сайта">
          {runs.length === 0 ? <Empty title="Прогонов ещё не было" /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Прогон</th><th>Статус</th><th>Этап</th><th>Создан</th></tr></thead>
              <tbody>{runs.map((x) => (
                <tr key={x.id}><td><Link href={`/pinterest/pins/runs/${x.id}`} className="font-medium underline decoration-line hover:decoration-ink">{x.name || x.id.slice(0, 8)}</Link></td><td><Badge tone={runStatusTone(x.status)}>{RUN_STATUS_LABELS[x.status]}</Badge></td><td className="text-muted">{x.stage}</td><td className="text-muted">{fmtDate(x.createdAt)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      )}

    </>
  );
}
