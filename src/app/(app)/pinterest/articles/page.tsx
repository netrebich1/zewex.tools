import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Card, Empty, PageHeader } from "@/components/ui";
import { articlesInWork, errorsLastHour, moderationCounts, sitesFunnel, workerState } from "@/lib/articles/queries";
import { SiteFunnel, FunnelLegend } from "@/components/articles/SiteFunnel";
import { ArticlesBoard } from "@/components/articles/ArticlesBoard";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Обзор сервиса «Статьи»: воронка по сайтам, воркер, ошибки за час, модерация, живой список статей в работе. */
export default async function ArticlesHome() {
  const me = await requireUser();
  const sites = await sitesFunnel(me);
  const [worker, errors, mod, inWork] = await Promise.all([
    workerState(me),
    errorsLastHour(sites.map((s) => s.id)),
    moderationCounts(me),
    articlesInWork(me),
  ]);
  const active = sites.filter((s) => s.isActive);
  const archived = sites.filter((s) => !s.isActive);

  return (
    <>
      <PageHeader
        title="Статьи"
        subtitle="Статьи-подборки под Pinterest: поиск реальных фото → модерация → текст → публикация в WordPress. Здесь — что происходит по каждому сайту."
        actions={
          <>
            <Link href="/pinterest/articles/moderation/articles" className={`btn-ghost ${mod.photos ? "ring-2 ring-warn/40" : ""}`} title="Статьи, которые можно взять на проверку фото (без тех, что сейчас проверяет ИИ)">Модерация фото{mod.photos ? ` (${mod.photos})` : ""}</Link>
            {mod.insufficient > 0 && <Link href="/pinterest/articles/moderation/articles?tab=low" className="btn-ghost" title="Статьи с пометкой «Мало фото»: вернуть на модерацию, добрать или закрыть">Мало фото ({mod.insufficient})</Link>}
            <Link href="/pinterest/articles/moderation/articles?tab=review" className={`btn-ghost ${mod.articles ? "ring-2 ring-warn/40" : ""}`}>Модерация статей{mod.articles ? ` (${mod.articles})` : ""}</Link>
            <Link href="/pinterest/articles/automation" className="btn-ghost" title="Переключатели и лимиты цепочек по всем сайтам, что мешает запуску">Автозапуск всех сайтов</Link>
            <Link href="/pinterest/articles/runs/new" className="btn-brand">Новый запуск</Link>
          </>
        }
      />

      <div className="space-y-5">
        <Card title="Сейчас в работе" description="Статьи, которые выполняет воркер, и очередь. Обновляется само.">
          <ArticlesBoard initial={inWork} worker={worker} errorsHour={errors} />
        </Card>

        <Card title="Сайты" description={<FunnelLegend />} actions={<Link href="/pinterest/articles/sites" className="btn-ghost btn-sm">Все сайты и подключение</Link>}>
          {sites.length === 0 ? (
            <Empty title="Сайтов в сервисе нет" hint="Подключите сайт: он берётся из общего раздела «Сайты» (доступ WordPress), а ниша и рецепт задаются здесь." action={<Link href="/pinterest/articles/sites" className="btn-primary">Подключить сайт</Link>} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Сайт</th><th>Воронка</th><th className="hidden lg:table-cell">Всего / готово</th><th className="hidden md:table-cell">Активность</th><th></th></tr></thead>
                <tbody>
                  {active.map((s) => (
                    <tr key={s.id}>
                      <td className="min-w-[160px]">
                        <Link href={`/pinterest/articles/sites/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                        <div className="help">{s.teamName}{s.recipeName ? ` · ${s.recipeName}` : " · рецепт не задан"}{!s.hasAccess && <span className="text-warn"> · нет доступа WP</span>}</div>
                      </td>
                      <td><SiteFunnel siteId={s.id} f={s.funnel} /></td>
                      <td className="hidden lg:table-cell text-muted tabular-nums">{s.funnel.total} / {s.funnel.completed}</td>
                      <td className="hidden md:table-cell text-muted whitespace-nowrap">{s.lastAt ? fmtDate(s.lastAt) : "—"}</td>
                      <td className="text-right whitespace-nowrap"><Link href={`/pinterest/articles/runs/new?site=${s.id}`} className="btn-ghost btn-sm">Запуск</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {archived.length > 0 && <p className="help mt-3">В архиве: {archived.map((s) => <Link key={s.id} href={`/pinterest/articles/sites/${s.id}`} className="underline mr-2">{s.name}</Link>)}</p>}
        </Card>
      </div>
    </>
  );
}
