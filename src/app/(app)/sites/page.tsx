import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { mergeRecipe } from "@/lib/pins/types";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Общий раздел портала: сайты команд. Сайт = доступ по REST API WordPress + команда + сервисы + настройки сервисов (Pinterest Pins). */
export default async function SitesPage() {
  const me = await requireUser();
  const isAdmin = me.role === "ADMIN";
  const [teams, projects] = await Promise.all([
    prisma.team.findMany({ where: isAdmin ? {} : { id: { in: me.teamIds } }, orderBy: { name: "asc" } }),
    prisma.project.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { slug: true, name: true } }),
  ]);
  const teamIds = teams.map((t) => t.id);
  const [rows, pinSites] = await Promise.all([
    prisma.siteAccess.findMany({ where: { teamId: { in: teamIds } }, orderBy: { name: "asc" } }),
    prisma.pinSite.findMany({ where: { teamId: { in: teamIds } }, orderBy: { name: "asc" }, include: { _count: { select: { boards: true } } } }),
  ]);
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? "";
  const projName = (slug: string) => projects.find((p) => p.slug === slug)?.name ?? slug;
  const pinsByAccess = new Map(pinSites.filter((s) => s.wpConnectionId).map((s) => [s.wpConnectionId as string, s]));
  const orphanPins = pinSites.filter((s) => !s.wpConnectionId);
  const byTeam = new Map<string, typeof rows>();
  for (const r of rows) byTeam.set(teamName(r.teamId), [...(byTeam.get(teamName(r.teamId)) ?? []), r]);

  const pinsSummary = (s: (typeof pinSites)[number]) => {
    const r = mergeRecipe(s.recipe);
    const mix = [r.mix.ai && `ИИ ${r.mix.ai}`, r.mix.photos && `фото ${r.mix.photos}`, r.mix.canvas && `canvas ${r.mix.canvas}`, r.mix.pinora && `pinora ${r.mix.pinora}`].filter(Boolean).join(" · ");
    return `${mix || "выключено"} · ${r.schedule.pinsPerDay}/день · досок ${s._count.boards}${s.isActive ? "" : " · в архиве"}`;
  };

  return (
    <>
      <PageHeader title="Сайты" subtitle="Доступ к сайту по REST API WordPress вводится один раз. Здесь же — какой команде он принадлежит, каким сервисам доступен и как настроен Pinterest Pins." actions={<Link href="/sites/new" className="btn-brand"><Icon.plus width={16} height={16} /> Добавить сайт</Link>} />
      {rows.length === 0 && orphanPins.length === 0 ? (
        <Empty title="Сайтов пока нет" hint="Добавьте первый сайт: адрес, логин и Application Password WordPress." action={<Link href="/sites/new" className="btn-primary">Добавить сайт</Link>} />
      ) : (
        <div className="space-y-4">
          {[...byTeam.entries()].map(([team, list]) => (
            <Card key={team} title={team}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Сайт</th><th>Адрес</th><th>Сервисы</th><th>Pinterest Pins</th><th>Проверка</th></tr></thead>
                  <tbody>
                    {list.map((w) => {
                      const pr = (w.projects as string[] | null) ?? [];
                      const ps = pinsByAccess.get(w.id);
                      return (
                        <tr key={w.id}>
                          <td><Link href={`/sites/${w.id}`} className="font-medium hover:underline">{w.name}</Link></td>
                          <td className="text-muted">{w.baseUrl}</td>
                          <td><span className="flex flex-wrap gap-1">{pr.length ? pr.map((s) => <Badge key={s}>{projName(s)}</Badge>) : <Badge>все сервисы</Badge>}</span></td>
                          <td className="text-muted">{ps ? pinsSummary(ps) : "не включён"}</td>
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
            <Card title="Сайты Pinterest Pins без доступа WordPress" description="Созданы раньше без привязки к доступу. Откройте сайт и выберите WordPress в рецепте, чтобы он появился в общем списке.">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Сайт</th><th>Команда</th><th>Pinterest Pins</th></tr></thead>
                  <tbody>{orphanPins.map((s) => (
                    <tr key={s.id}><td><Link href={`/sites/${s.id}`} className="font-medium hover:underline">{s.name}</Link><div className="help">{s.slug}</div></td><td>{teamName(s.teamId)}</td><td className="text-muted">{pinsSummary(s)}</td></tr>
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
