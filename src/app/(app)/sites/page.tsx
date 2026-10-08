import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createSite } from "@/actions/pins";
import { mergeRecipe } from "@/lib/pins/types";

export const dynamic = "force-dynamic";

/** Общий раздел портала: все сайты команд и их настройки (рецепт, доски). Аналог страницы ключей. */
export default async function SitesPage() {
  const me = await requireUser();
  const isAdmin = me.role === "ADMIN";
  const teams = await prisma.team.findMany({ where: isAdmin ? {} : { id: { in: me.teamIds } }, orderBy: { name: "asc" } });
  const teamIds = teams.map((t) => t.id);
  const [sites, wps] = await Promise.all([
    prisma.pinSite.findMany({ where: { teamId: { in: teamIds } }, orderBy: [{ isActive: "desc" }, { name: "asc" }], include: { team: { select: { name: true } }, _count: { select: { boards: true, runs: true } } } }),
    prisma.siteAccess.findMany({ where: { teamId: { in: teamIds } }, select: { id: true, name: true } }),
  ]);
  const wpName = new Map(wps.map((w) => [w.id, w.name]));
  const byTeam = new Map<string, typeof sites>();
  for (const s of sites) byTeam.set(s.team.name, [...(byTeam.get(s.team.name) ?? []), s]);

  return (
    <>
      <PageHeader title="Сайты" subtitle="Настройки каждого сайта в одном месте: рецепт пинов, доски, WordPress. Сервисы берут их отсюда." actions={<a href="#new" className="btn-brand">Добавить сайт</a>} />
      <div className="space-y-4">
        {sites.length === 0 ? (
          <Empty title="Сайтов пока нет" hint="Добавьте первый сайт формой ниже, затем настройте его рецепт." />
        ) : [...byTeam.entries()].map(([teamName, list]) => (
          <Card key={teamName} title={teamName}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Сайт</th><th>Ниша</th><th>Пинов на ссылку</th><th>В день</th><th>WordPress</th><th>Доски</th><th>Прогонов</th><th>Статус</th></tr></thead>
                <tbody>
                  {list.map((s) => {
                    const r = mergeRecipe(s.recipe);
                    const mix = [r.mix.ai && `ИИ ${r.mix.ai}`, r.mix.photos && `фото ${r.mix.photos}`, r.mix.canvas && `canvas ${r.mix.canvas}`, r.mix.pinora && `pinora ${r.mix.pinora}`].filter(Boolean).join(" · ");
                    const wp = r.publishing.wpConnectionId ? wpName.get(r.publishing.wpConnectionId) : null;
                    return (
                      <tr key={s.id} className={s.isActive ? "" : "opacity-60"}>
                        <td><Link href={`/sites/${s.id}`} className="font-medium hover:underline">{s.name}</Link><div className="help">{s.slug}</div></td>
                        <td className="text-muted">{s.niche || "—"}</td>
                        <td>{mix || <span className="text-muted">выключено</span>}</td>
                        <td>{r.schedule.pinsPerDay}</td>
                        <td>{wp ?? <span className="text-muted">не выбран</span>}</td>
                        <td>{s._count.boards}</td>
                        <td>{s._count.runs}</td>
                        <td>{s.isActive ? <Badge tone="ok">активен</Badge> : <Badge>в архиве</Badge>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ))}

        <div id="new">
          <Card title="Новый сайт" description="Сайт получает рецепт по умолчанию, настроить его можно сразу после создания.">
            <ActionForm action={createSite} className="flex flex-wrap items-end gap-3">
              <Field label="Команда"><select name="teamId" className="input">{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
              <Field label="Домен сайта"><input name="name" className="input" required placeholder="site.com" /></Field>
              <SubmitButton pendingText="…">Создать сайт</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
