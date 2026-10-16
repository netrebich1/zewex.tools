import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { siteAccessWhere } from "@/lib/sites/access";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { enableArticlesForSite } from "@/actions/articles";
import { PROJECT_SLUG, mergeSiteSettings, PUBLISH_MODES } from "@/lib/articles/types";
import { sitesFunnel } from "@/lib/articles/queries";
import { SiteFunnel } from "@/components/articles/SiteFunnel";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Сайты сервиса «Статьи» + подключение сайтов из общего раздела «Сайты» (у которых разрешён инструмент «Статьи»). */
export default async function ArticlesSitesPage() {
  const me = await requireUser();
  const [funnel, sites, niches, accesses] = await Promise.all([
    sitesFunnel(me),
    prisma.artSite.findMany({ where: {}, select: { id: true, accessId: true, settings: true, nicheCode: true, access: { select: { baseUrl: true, lastCheckOk: true, username: true, appPasswordEnc: true } }, runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, name: true, createdAt: true } } } }),
    prisma.artNiche.findMany({ select: { code: true, name: true } }),
    prisma.siteAccess.findMany({ where: { ...(await siteAccessWhere(me)), kind: "wordpress" }, orderBy: { name: "asc" }, select: { id: true, name: true, baseUrl: true, projects: true, teamId: true } }),
  ]);
  const teams = await prisma.team.findMany({ where: { id: { in: [...new Set(accesses.map((a) => a.teamId))] } }, select: { id: true, name: true } });
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? "другая команда";
  const extra = new Map(sites.map((s) => [s.id, s]));
  const connected = new Set(sites.map((s) => s.accessId).filter(Boolean));
  const available = accesses.filter((a) => { const pr = (a.projects as string[] | null) ?? []; return (!pr.length || pr.includes(PROJECT_SLUG)) && !connected.has(a.id); });
  const nicheName = (code: string | null) => niches.find((n) => n.code === code)?.name ?? (code ? code : "—");

  return (
    <>
      <PageHeader title="Сайты" subtitle="Настройки сервиса для каждого сайта: ниша, рецепт по умолчанию, фото, публикация, категории WordPress, автозапуск. Доступ по REST API, команды и видимость — в общем разделе «Сайты» портала." actions={<Link href="/sites" className="btn-ghost">Доступы и команды</Link>} />
      <div className="space-y-5">
        {funnel.length === 0 ? (
          <Empty title="Сайтов в сервисе нет" hint="Подключите сайт из списка ниже. Если списка нет — добавьте сайт в общем разделе «Сайты» и отметьте там инструмент «Статьи»." />
        ) : (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Сайт</th><th className="hidden md:table-cell">Ниша · рецепт</th><th className="hidden lg:table-cell">Режим</th><th>Воронка</th><th className="hidden lg:table-cell">Последний запуск</th><th></th></tr></thead>
                <tbody>
                  {funnel.map((s) => {
                    const x = extra.get(s.id);
                    const st = mergeSiteSettings(x?.settings);
                    const last = x?.runs[0];
                    const noCreds = x?.access && (!x.access.username || !x.access.appPasswordEnc);
                    return (
                      <tr key={s.id} className={s.isActive ? "" : "opacity-60"}>
                        <td>
                          <Link href={`/pinterest/articles/sites/${s.id}`} className="font-medium hover:underline">{s.name}</Link>{!s.isActive && <span className="ml-2"><Badge>в архиве</Badge></span>}
                          <div className="help">{s.teamName}{x?.access ? ` · ${x.access.baseUrl}` : " · без доступа WordPress"}{noCreds && <span className="text-warn"> · нет логина REST API</span>}</div>
                        </td>
                        <td className="hidden md:table-cell text-muted">{nicheName(s.nicheCode)}<div className="help">{s.recipeName ?? "рецепт не задан"}</div></td>
                        <td className="hidden lg:table-cell text-muted"><div>{st.photoCount.mode === "exact" ? `${st.photoCount.min} фото` : `${st.photoCount.min}–${st.photoCount.max} фото`}</div><div className="help">{st.photoReview ? "модерация фото" : "без модерации фото"} · {PUBLISH_MODES.find((m) => m.value === st.publishMode)?.label}</div></td>
                        <td><SiteFunnel siteId={s.id} f={s.funnel} compact /></td>
                        <td className="hidden lg:table-cell text-muted">{last ? <Link href={`/pinterest/articles/runs/${last.id}`} className="hover:underline">{last.name || last.id.slice(0, 8)} · {fmtDate(last.createdAt)}</Link> : "—"}</td>
                        <td className="text-right whitespace-nowrap"><Link href={`/pinterest/articles/sites/${s.id}?tab=settings`} className="btn-ghost btn-sm">Настройки</Link> {s.isActive && <Link href={`/pinterest/articles/runs/new?site=${s.id}`} className="btn-ghost btn-sm">Запуск</Link>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card title="Подключить сайт" description="Сайты из общего раздела «Сайты», у которых разрешён инструмент «Статьи» и которые ещё не подключены. После подключения задайте нишу и рецепт в настройках.">
          {available.length === 0 ? (
            <p className="help">Нет сайтов для подключения. Добавьте сайт в разделе <Link href="/sites/new" className="underline">«Сайты»</Link> или отметьте у существующего инструмент «Статьи».</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {available.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1"><div className="font-medium truncate">{a.name}</div><div className="help truncate">{teamName(a.teamId)} · {a.baseUrl}</div></div>
                  <ActionForm action={enableArticlesForSite} hidden={{ accessId: a.id }} className="inline">
                    <SubmitButton className="btn-primary btn-sm" pendingText="Подключаю…">Подключить</SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
