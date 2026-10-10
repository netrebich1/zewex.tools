import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { pinRunWhere, pinSiteWhere } from "@/lib/sites/access";
import { Badge, Card, Empty, PageHeader, type SearchParams, sp } from "@/components/ui";
import { RUN_STATUS_LABELS, STAGE_LABELS, runStatusTone } from "@/components/pins/labels";
import { RUN_RETENTION_DAYS } from "@/lib/pins/runs/cleanup";
import { fmtDate } from "@/lib/utils";
import type { PinRunStatus } from "@prisma/client";
import type { PinStage } from "@/lib/pins/types";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;
const STATUSES = Object.keys(RUN_STATUS_LABELS) as PinRunStatus[];

/** История прогонов: все прогоны видимых сайтов с фильтрами по сайту и статусу. Хранятся 90 дней после последнего пина. */
export default async function RunsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const p = await searchParams;
  const siteId = sp(p, "site");
  const status = STATUSES.find((s) => s === sp(p, "status"));
  const page = Math.max(1, Number(sp(p, "page")) || 1);
  const where = { ...(await pinRunWhere(me)), NOT: { name: { startsWith: "__" } }, ...(siteId ? { siteId } : {}), ...(status ? { status } : {}) };
  const [sites, total, runs] = await Promise.all([
    prisma.pinSite.findMany({ where: await pinSiteWhere(me), orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.pinRun.count({ where }),
    prisma.pinRun.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
      include: { site: { select: { name: true } }, _count: { select: { pages: true, items: { where: { kind: "pin", status: { not: "REMOVED" } } } } } },
    }),
  ]);
  const lastPins = runs.length ? await prisma.pinRunItem.groupBy({ by: ["runId"], where: { runId: { in: runs.map((r) => r.id) }, scheduledAt: { not: null } }, _max: { scheduledAt: true }, _min: { scheduledAt: true } }) : [];
  const span = (id: string) => { const x = lastPins.find((l) => l.runId === id); return x?._min.scheduledAt && x?._max.scheduledAt ? `${fmtDate(x._min.scheduledAt).slice(0, 10)} — ${fmtDate(x._max.scheduledAt).slice(0, 10)}` : "—"; };
  const qs = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ site: siteId, status, ...patch })) if (v) u.set(k, v);
    const s = u.toString();
    return `/pinterest/pins/runs${s ? `?${s}` : ""}`;
  };
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader title="Прогоны" subtitle={`История всех прогонов: ${total}. Прогон удаляется автоматически через ${RUN_RETENTION_DAYS} дней после даты последнего пина.`} actions={<Link href="/pinterest/pins/runs/new" className="btn-brand">Новый прогон</Link>} />
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap gap-2 items-center">
            <Link href={qs({ site: undefined, page: undefined })} className={`badge px-3 py-1 ${!siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все сайты</Link>
            {sites.map((s) => <Link key={s.id} href={qs({ site: s.id, page: undefined })} className={`badge px-3 py-1 ${siteId === s.id ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{s.name}</Link>)}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            <Link href={qs({ status: undefined, page: undefined })} className={`badge px-3 py-1 ${!status ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все статусы</Link>
            {STATUSES.map((s) => <Link key={s} href={qs({ status: s, page: undefined })} className={`badge px-3 py-1 ${status === s ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{RUN_STATUS_LABELS[s]}</Link>)}
          </div>
        </Card>
        {runs.length === 0 ? <Empty title="Прогонов нет" hint="По выбранному фильтру ничего не найдено." /> : (
          <Card>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Прогон</th><th>Сайт</th><th>Статус</th><th>Этап</th><th>Статей</th><th>Пинов</th><th>Даты пинов</th><th>Расход</th><th>Создан</th></tr></thead>
              <tbody>{runs.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/pinterest/pins/runs/${r.id}`} className="font-medium hover:underline">{r.name || r.id.slice(0, 8)}</Link>{r.stepByStep && <span className="help ml-1">пошаговый</span>}</td>
                  <td className="text-muted">{r.site?.name ?? "—"}</td>
                  <td><Badge tone={runStatusTone(r.status)}>{RUN_STATUS_LABELS[r.status]}</Badge></td>
                  <td className="text-muted">{STAGE_LABELS[r.stage as PinStage] ?? r.stage}</td>
                  <td>{r._count.pages}</td>
                  <td>{r._count.items}</td>
                  <td className="text-muted whitespace-nowrap">{span(r.id)}</td>
                  <td className="text-muted">${r.costUsd.toFixed(2)}</td>
                  <td className="text-muted whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {total > PAGE_SIZE && (
              <div className="mt-3 flex items-center gap-2 text-[13px]">
                {page > 1 && <Link href={qs({ page: String(page - 1) })} className="btn-ghost btn-sm">← Назад</Link>}
                <span className="help">страница {page} из {last}</span>
                {page < last && <Link href={qs({ page: String(page + 1) })} className="btn-ghost btn-sm">Дальше →</Link>}
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
