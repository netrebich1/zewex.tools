import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { RUN_STATUS_LABELS, runStatusTone } from "@/components/pins/labels";
import { mergeRecipe } from "@/lib/pins/types";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PinsHome() {
  const me = await requireUser();
  const teamFilter = me.role === "ADMIN" ? {} : { teamId: { in: me.teamIds } };
  const [sites, runs] = await Promise.all([
    prisma.pinSite.findMany({ where: { ...teamFilter, isActive: true }, orderBy: { name: "asc" }, include: { team: { select: { name: true } }, _count: { select: { boards: true, sets: true } } } }),
    prisma.pinRun.findMany({ where: { ...teamFilter, NOT: { name: { startsWith: "__" } } }, orderBy: { updatedAt: "desc" }, take: 20, include: { site: { select: { name: true } } } }),
  ]);
  const attention = runs.filter((r) => r.status === "WAITING_MODERATION" || r.status === "BLOCKED");

  return (
    <>
      <PageHeader title="Сегодня" subtitle="Что требует внимания, сайты и последние прогоны." actions={<><Link href="/sites" className="btn-ghost">Сайты и настройки</Link><Link href="/pinterest/pins/runs/new" className="btn-brand">Новый прогон</Link></>} />
      <div className="space-y-5">
        {attention.length > 0 && (
          <Card title="Нужно внимание">
            <ul className="divide-y divide-line">
              {attention.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.site?.name ?? "—"} · {r.name || r.id.slice(0, 8)}</div>
                    <div className="help truncate">{r.status === "BLOCKED" ? r.blockedReason : "Прогон ждёт модерации"}</div>
                  </div>
                  <Link href={`/pinterest/pins/runs/${r.id}`} className="btn-primary btn-sm">Открыть</Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Сайты" description="Рецепт сайта определяет, сколько и каких пинов делать на каждую ссылку. Настройки — в разделе «Сайты» портала.">
          {sites.length === 0 ? (
            <Empty title="Сайтов пока нет" hint="Добавьте сайт в разделе «Сайты» портала." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Сайт</th><th>Команда</th><th>Пинов на ссылку</th><th>В день</th><th>Доски</th><th></th></tr></thead>
                <tbody>
                  {sites.map((s) => {
                    const r = mergeRecipe(s.recipe);
                    const mix = [r.mix.ai && `ИИ ${r.mix.ai}`, r.mix.photos && `фото ${r.mix.photos}`, r.mix.canvas && `canvas ${r.mix.canvas}`, r.mix.pinora && `pinora ${r.mix.pinora}`].filter(Boolean).join(" · ");
                    return (
                      <tr key={s.id}>
                        <td><Link href={`/pinterest/pins/sites/${s.id}`} className="font-semibold underline decoration-line hover:decoration-ink">{s.name}</Link><div className="help">{s.slug}</div></td>
                        <td>{s.team.name}</td>
                        <td>{mix || <span className="text-muted">выключено</span>}</td>
                        <td>{r.schedule.pinsPerDay}</td>
                        <td>{s._count.boards}</td>
                        <td className="text-right"><Link href={`/pinterest/pins/runs/new?site=${s.id}`} className="btn-ghost btn-sm">Новый прогон</Link></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Последние прогоны">
          {runs.length === 0 ? (
            <Empty title="Прогонов ещё не было" action={<Link href="/pinterest/pins/runs/new" className="btn-brand">Запустить первый</Link>} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Прогон</th><th>Сайт</th><th>Статус</th><th>Этап</th><th>Обновлён</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td><Link href={`/pinterest/pins/runs/${r.id}`} className="font-medium underline decoration-line hover:decoration-ink">{r.name || r.id.slice(0, 8)}</Link></td>
                      <td>{r.site?.name ?? "—"}</td>
                      <td><Badge tone={runStatusTone(r.status)}>{RUN_STATUS_LABELS[r.status]}</Badge></td>
                      <td className="text-muted">{r.stage}</td>
                      <td className="text-muted">{fmtDate(r.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
