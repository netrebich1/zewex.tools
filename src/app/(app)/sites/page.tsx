import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { siteAccessWhere, pinSiteWhere } from "@/lib/sites/access";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Уровень системы: сайты = доступ по REST API WordPress + команды + сервисы + видимость. Настройки сервисов — внутри сервисов. */
export default async function SitesPage() {
  const me = await requireUser();
  const isAdmin = me.role === "ADMIN";
  const [teams, projects, rows, pinSites] = await Promise.all([
    prisma.team.findMany({ where: isAdmin ? {} : { id: { in: me.teamIds } }, orderBy: { name: "asc" } }),
    prisma.project.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { slug: true, name: true } }),
    prisma.siteAccess.findMany({ where: await siteAccessWhere(me), orderBy: { name: "asc" }, include: { teams: { select: { teamId: true } }, viewers: { select: { userId: true } } } }),
    prisma.pinSite.findMany({ where: await pinSiteWhere(me), orderBy: { name: "asc" }, include: { _count: { select: { boards: true, runs: true } } } }),
  ]);
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? "другая команда";
  const projName = (slug: string) => projects.find((p) => p.slug === slug)?.name ?? slug;
  const pinsByAccess = new Map(pinSites.filter((s) => s.wpConnectionId).map((s) => [s.wpConnectionId as string, s]));
  const orphanPins = pinSites.filter((s) => !s.wpConnectionId);
  const byTeam = new Map<string, typeof rows>();
  for (const r of rows) byTeam.set(teamName(r.teamId), [...(byTeam.get(teamName(r.teamId)) ?? []), r]);

  return (
    <>
      <PageHeader title="Сайты" subtitle="Уровень системы: доступ к сайту по REST API, какие команды и сотрудники его видят, в какие инструменты он интегрирован. Настройки инструментов (доски, шаблоны пинов) — внутри самих инструментов." actions={<Link href="/sites/new" className="btn-brand"><Icon.plus width={16} height={16} /> Добавить сайт</Link>} />
      {rows.length === 0 && orphanPins.length === 0 ? (
        <Empty title="Сайтов пока нет" hint="Добавьте первый сайт: адрес, логин и Application Password WordPress." action={<Link href="/sites/new" className="btn-primary">Добавить сайт</Link>} />
      ) : (
        <div className="space-y-4">
          {[...byTeam.entries()].map(([team, list]) => (
            <Card key={team} title={team}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Сайт</th><th>Адрес</th><th>Команды и видимость</th><th>Инструменты</th><th>Pinterest Pins</th><th>Проверка</th></tr></thead>
                  <tbody>
                    {list.map((w) => {
                      const pr = (w.projects as string[] | null) ?? [];
                      const ps = pinsByAccess.get(w.id);
                      return (
                        <tr key={w.id}>
                          <td><Link href={`/sites/${w.id}`} className="font-medium hover:underline">{w.name}</Link></td>
                          <td className="text-muted">{w.baseUrl}{(!w.username || !w.appPasswordEnc) && <span className="ml-2"><Badge tone="warn">нет доступа REST API</Badge></span>}</td>
                          <td className="text-muted">{w.teams.length ? `+ ${w.teams.map((t) => teamName(t.teamId)).join(", ")}` : "только владелец"}{w.viewers.length ? ` · видят ${w.viewers.length} сотр.` : ""}</td>
                          <td><span className="flex flex-wrap gap-1">{pr.length ? pr.map((s) => <Badge key={s}>{projName(s)}</Badge>) : <Badge>все инструменты</Badge>}</span></td>
                          <td className="text-muted">{ps ? <Link href={`/pinterest/pins/sites/${ps.id}?tab=settings`} className="hover:underline">{ps.isActive ? "включён" : "в архиве"} · настройки</Link> : "не включён"}</td>
                          <td>{w.lastCheckOk == null ? <span className="text-muted">—</span> : w.lastCheckOk ? <span className="text-ok" title={w.lastCheckNote ?? ""}>✓ {fmtDate(w.lastCheckedAt)}</span> : <span className="text-danger" title={w.lastCheckNote ?? ""}>✕ ошибка</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
          {orphanPins.length > 0 && (
            <Card title="Сайты Pinterest Pins без доступа WordPress" description="Созданы раньше без привязки к доступу. Откройте сайт в сервисе и выберите доступ WordPress в настройках.">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Сайт</th><th>Команда</th><th>Pinterest Pins</th></tr></thead>
                  <tbody>{orphanPins.map((s) => (
                    <tr key={s.id}><td><Link href={`/pinterest/pins/sites/${s.id}?tab=settings`} className="font-medium hover:underline">{s.name}</Link><div className="help">{s.slug}</div></td><td>{teamName(s.teamId)}</td><td className="text-muted">досок {s._count.boards} · прогонов {s._count.runs}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
