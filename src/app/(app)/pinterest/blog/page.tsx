import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { saveBlogSettings } from "@/actions/blog";
import { errorsLastHour, postsInWork, sitesFunnel, workerState } from "@/lib/blog/queries";
import { SiteFunnel } from "@/components/blog/SiteFunnel";
import { PostsTable } from "@/components/blog/PostsTable";
import { AutoRefresh } from "@/components/blog/AutoRefresh";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Обзор сервиса инфо-статей: воркер, статьи в работе, воронка по сайтам. */
export default async function BlogHome() {
  const me = await requireUser();
  const sites = await sitesFunnel(me);
  const [worker, errors, inWork, settings] = await Promise.all([workerState(me), errorsLastHour(sites.map((s) => s.id)), postsInWork(me), prisma.blogSettings.findUnique({ where: { id: "main" } })]);
  const active = sites.filter((s) => s.isActive);
  const archived = sites.filter((s) => !s.isActive);
  const live = inWork.some((p) => p.status === "RUNNING" || p.status === "PUBLISHING") || worker.pending > 0;

  return (
    <>
      <AutoRefresh enabled={live} />
      <PageHeader title="Инфо-статьи" subtitle="Pin Blog Article: исследование темы → план из блоков → реальные фото по разделам → текст → проверка → WordPress. Здесь — что происходит по каждому сайту."
        actions={<><Link href="/pinterest/blog/review" className={`btn-ghost ${worker.waiting ? "ring-2 ring-warn/40" : ""}`}>Проверка{worker.waiting ? ` (${worker.waiting})` : ""}</Link><Link href="/pinterest/blog/runs/new" className="btn-brand">Новый запуск</Link></>} />
      <div className="space-y-5">
        <Card title="Сейчас в работе" description="Статьи, которые выполняет воркер, и очередь. Страница обновляется сама, пока есть работа.">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
            <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${worker.alive ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger"}`} title="По живым арендам статей в работе">Воркер {worker.alive ? "работает" : "не отвечает"} · в работе {worker.running}{worker.workerCap ? ` из ${worker.workerCap}` : ""} · в очереди {worker.pending}</span>
            {!worker.master && <Badge tone="danger">мастер-выключатель выключен</Badge>}
            <Link href="/pinterest/blog/journal" className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${errors ? "bg-danger-soft text-danger" : "bg-ink/5 text-ink-2"}`}>Ошибок за час: <b className="tabular-nums">{errors}</b></Link>
          </div>
          <PostsTable rows={inWork} showRun showSite emptyText="Сейчас ничего не выполняется и очередь пуста. Нажмите «Новый запуск»." />
        </Card>

        <Card title="Сайты" description="Воронка: в очереди → в работе → на проверке → публикуются → ошибки → опубликовано за 24 ч. Клик по числу открывает очередь сайта." actions={<Link href="/pinterest/blog/sites" className="btn-ghost btn-sm">Все сайты и подключение</Link>}>
          {sites.length === 0 ? (
            <Empty title="Сайтов в сервисе нет" hint="Подключите сайт: он берётся из общего раздела «Сайты» (доступ WordPress)." action={<Link href="/pinterest/blog/sites" className="btn-primary">Подключить сайт</Link>} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Сайт</th><th>Воронка</th><th className="hidden lg:table-cell">Всего / готово</th><th className="hidden md:table-cell">Активность</th><th></th></tr></thead>
                <tbody>
                  {active.map((s) => (
                    <tr key={s.id}>
                      <td className="min-w-[160px]"><Link href={`/pinterest/blog/sites/${s.id}`} className="font-medium hover:underline">{s.name}</Link><div className="help">{s.teamName}{s.recipeName ? ` · ${s.recipeName}` : " · сценарий не задан"}{!s.hasAccess && <span className="text-warn"> · нет доступа WP</span>}</div></td>
                      <td><SiteFunnel siteId={s.id} f={s.funnel} /></td>
                      <td className="hidden lg:table-cell text-muted tabular-nums">{s.funnel.total} / {s.funnel.completed}</td>
                      <td className="hidden md:table-cell text-muted whitespace-nowrap">{s.lastAt ? fmtDate(s.lastAt) : "—"}</td>
                      <td className="text-right whitespace-nowrap"><Link href={`/pinterest/blog/runs/new?site=${s.id}`} className="btn-ghost btn-sm">Запуск</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {archived.length > 0 && <p className="help mt-3">В архиве: {archived.map((s) => <Link key={s.id} href={`/pinterest/blog/sites/${s.id}`} className="underline mr-2">{s.name}</Link>)}</p>}
        </Card>

        {me.role === "ADMIN" && (
          <Card title="Общие настройки" description="Мастер-выключатель останавливает захват новых постов на всех сайтах; потолок — сколько постов всего одновременно (0 — только потолок воркера).">
            <ActionForm action={saveBlogSettings} className="flex flex-wrap items-end gap-3">
              <label className="inline-flex items-center gap-2 text-[14px]"><input type="checkbox" name="master" defaultChecked={settings?.master ?? true} /> воркер берёт посты</label>
              <label className="block"><span className="label">Потолок одновременных постов</span><input name="maxConcurrent" type="number" min={0} max={200} className="input py-1.5 w-32" defaultValue={settings?.maxConcurrent ?? 0} /></label>
              <SubmitButton className="btn-ghost" pendingText="…">Сохранить</SubmitButton>
              <span className="help">Потолок воркера: {settings?.workerCap || "—"} (BLOG_WORKER_CONCURRENCY)</span>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
