import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { pinSiteWhere } from "@/lib/sites/access";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { mergeRecipe } from "@/lib/pins/types";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Сайты в сервисе Pinterest Pins: доски, стили, язык, последний прогон. Доступы и команды — в общем разделе «Сайты». */
export default async function PinsSitesPage() {
  const me = await requireUser();
  const sites = await prisma.pinSite.findMany({
    where: await pinSiteWhere(me), orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: { team: { select: { name: true } }, _count: { select: { boards: true } }, runs: { where: { NOT: { name: { startsWith: "__" } } }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, name: true, createdAt: true, status: true } } },
  });

  return (
    <>
      <PageHeader title="Сайты" subtitle="Настройки сервиса для каждого сайта: доски, наборы стилей, язык. Доступ по REST API, команды и видимость — в общем разделе «Сайты» портала." actions={<Link href="/sites" className="btn-ghost">Доступы и команды</Link>} />
      {sites.length === 0 ? (
        <Empty title="Сайтов в сервисе нет" hint="Добавьте сайт в общем разделе «Сайты» и включите для него Pinterest Pins." action={<Link href="/sites" className="btn-primary">Открыть «Сайты»</Link>} />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Сайт</th><th>Команда</th><th>Доски</th><th>Стили</th><th>Язык</th><th>Последний прогон</th><th></th></tr></thead>
              <tbody>
                {sites.map((s) => {
                  const r = mergeRecipe(s.recipe);
                  const last = s.runs[0];
                  return (
                    <tr key={s.id} className={s.isActive ? "" : "opacity-60"}>
                      <td><Link href={`/pinterest/pins/sites/${s.id}`} className="font-medium hover:underline">{s.name}</Link>{!s.isActive && <span className="ml-2"><Badge>в архиве</Badge></span>}</td>
                      <td className="text-muted">{s.team.name}</td>
                      <td>{s._count.boards}</td>
                      <td className="text-muted">ИИ {r.sets.aiSetIds.length} · Canvas {r.sets.canvasStyleIds.length || "все"} · Pinora {r.sets.pinoraTypes.length}</td>
                      <td className="text-muted">{r.text.language}</td>
                      <td className="text-muted">{last ? <Link href={`/pinterest/pins/runs/${last.id}`} className="hover:underline">{last.name || last.id.slice(0, 8)} · {fmtDate(last.createdAt)}</Link> : "—"}</td>
                      <td className="text-right"><Link href={`/pinterest/pins/sites/${s.id}?tab=settings`} className="btn-ghost btn-sm">Настройки</Link> {s.isActive && <Link href={`/pinterest/pins/runs/new?site=${s.id}`} className="btn-ghost btn-sm">Прогон</Link>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
