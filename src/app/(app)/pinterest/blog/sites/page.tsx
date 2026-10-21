import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { siteAccessWhere } from "@/lib/sites/access";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { enableBlogForSite } from "@/actions/blog";
import { PROJECT_SLUG, PUBLISH_MODES, REVIEW_MODES, mergeSiteSettings } from "@/lib/blog/types";
import { sitesFunnel } from "@/lib/blog/queries";
import { SiteFunnel } from "@/components/blog/SiteFunnel";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Сайты сервиса инфо-статей + подключение сайтов из общего раздела «Сайты». */
export default async function BlogSitesPage() {
  const me = await requireUser();
  const [funnel, sites, accesses] = await Promise.all([
    sitesFunnel(me),
    prisma.blogSite.findMany({ select: { id: true, accessId: true, settings: true, access: { select: { baseUrl: true, username: true, appPasswordEnc: true } }, runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, name: true, createdAt: true } } } }),
    prisma.siteAccess.findMany({ where: { ...(await siteAccessWhere(me)), kind: "wordpress" }, orderBy: { name: "asc" }, select: { id: true, name: true, baseUrl: true, projects: true, teamId: true } }),
  ]);
  const teams = await prisma.team.findMany({ where: { id: { in: [...new Set(accesses.map((a) => a.teamId))] } }, select: { id: true, name: true } });
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? "другая команда";
  const extra = new Map(sites.map((s) => [s.id, s]));
  const connected = new Set(sites.map((s) => s.accessId).filter(Boolean));
  const available = accesses.filter((a) => { const pr = (a.projects as string[] | null) ?? []; return (!pr.length || pr.includes(PROJECT_SLUG)) && !connected.has(a.id); });

  return (
    <>
      <PageHeader title="Сайты" subtitle="Настройки сервиса для каждого сайта: рецепт по умолчанию, проверка, публикация, категории WordPress, лимит. Доступ по REST API, команды и видимость — в общем разделе «Сайты»." actions={<Link href="/sites" className="btn-ghost">Доступы и команды</Link>} />
      <div className="space-y-5">
        {funnel.length === 0 ? <Empty title="Сайтов в сервисе нет" hint="Подключите сайт из списка ниже. Если списка нет — добавьте сайт в общем разделе «Сайты» и отметьте там инструмент «Pin Blog Article»." /> : (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Сайт</th><th className="hidden md:table-cell">Рецепт · режим</th><th>Воронка</th><th className="hidden lg:table-cell">Последний запуск</th><th></th></tr></thead>
                <tbody>
                  {funnel.map((s) => {
                    const x = extra.get(s.id);
                    const st = mergeSiteSettings(x?.settings);
                    const last = x?.runs[0];
                    const noCreds = x?.access && (!x.access.username || !x.access.appPasswordEnc);
                    return (
                      <tr key={s.id} className={s.isActive ? "" : "opacity-60"}>
                        <td><Link href={`/pinterest/blog/sites/${s.id}`} className="font-medium hover:underline">{s.name}</Link>{!s.isActive && <span className="ml-2"><Badge>в архиве</Badge></span>}<div className="help">{s.teamName}{x?.access ? ` · ${x.access.baseUrl}` : " · без доступа WordPress"}{noCreds && <span className="text-warn"> · нет логина REST API</span>}</div></td>
                        <td className="hidden md:table-cell text-muted">{s.recipeName ?? "рецепт не задан"}<div className="help">{REVIEW_MODES.find((m) => m.value === st.review)?.label} · {PUBLISH_MODES.find((m) => m.value === st.publishMode)?.label}</div></td>
                        <td><SiteFunnel siteId={s.id} f={s.funnel} compact /></td>
                        <td className="hidden lg:table-cell text-muted">{last ? <Link href={`/pinterest/blog/runs/${last.id}`} className="hover:underline">{last.name || last.id.slice(0, 8)} · {fmtDate(last.createdAt)}</Link> : "—"}</td>
                        <td className="text-right whitespace-nowrap"><Link href={`/pinterest/blog/sites/${s.id}?tab=settings`} className="btn-ghost btn-sm">Настройки</Link> {s.isActive && <Link href={`/pinterest/blog/runs/new?site=${s.id}`} className="btn-ghost btn-sm">Запуск</Link>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
        <Card title="Подключить сайт" description="Сайты из общего раздела «Сайты», у которых разрешён инструмент «Pin Blog Article» и которые ещё не подключены.">
          {available.length === 0 ? <p className="help">Нет сайтов для подключения. Добавьте сайт в разделе <Link href="/sites/new" className="underline">«Сайты»</Link> или отметьте у существующего инструмент «Pin Blog Article».</p> : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {available.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1"><div className="font-medium truncate">{a.name}</div><div className="help truncate">{teamName(a.teamId)} · {a.baseUrl}</div></div>
                  <ActionForm action={enableBlogForSite} hidden={{ accessId: a.id }} className="inline"><SubmitButton className="btn-primary btn-sm" pendingText="Подключаю…">Подключить</SubmitButton></ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
