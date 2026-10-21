import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Alert, Badge, Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { syncBlogSiteCategories, toggleBlogSiteActive } from "@/actions/blog";
import { loadBlogSite } from "@/lib/blog/access";
import { mergeSiteSettings } from "@/lib/blog/types";
import { STATUS_FILTER_GROUPS, queuePage, siteRuns, sitesFunnel } from "@/lib/blog/queries";
import { PostsTable } from "@/components/blog/PostsTable";
import { SiteFunnel } from "@/components/blog/SiteFunnel";
import { BlogSiteSettingsForm, type WpCategoryOption } from "@/components/blog/BlogSiteSettingsForm";

export const dynamic = "force-dynamic";

const TABS = [["queue", "Очередь"], ["settings", "Настройки"]] as const;

/** Сайт в сервисе инфо-статей: очередь (фильтры, пагинация, массовые действия) и настройки. */
export default async function BlogSitePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const q = await searchParams;
  const tab = (TABS.some(([k]) => k === sp(q, "tab")) ? sp(q, "tab") : "queue") as (typeof TABS)[number][0];
  const site = await loadBlogSite(me, id);
  if (!site) notFound();
  const settings = mergeSiteSettings(site.settings);
  const funnelRow = (await sitesFunnel(me)).find((s) => s.id === id);
  const categories = ((site.wpCategories as WpCategoryOption[] | null) ?? []).filter((c) => typeof c?.id === "number");

  return (
    <>
      <PageHeader back={{ href: "/pinterest/blog/sites", label: "Сайты" }} title={site.name} subtitle={`${site.defaultRecipe?.name ?? "рецепт не задан"} · одновременно ${settings.concurrency}${site.isActive ? "" : " · в архиве"}`}
        actions={<>{site.accessId && <Link href={`/sites/${site.accessId}`} className="btn-ghost">Доступ и команды</Link>}{site.isActive && <Link href={`/pinterest/blog/runs/new?site=${id}`} className="btn-brand">Новый запуск</Link>}</>} />
      {funnelRow && <div className="mb-4"><SiteFunnel siteId={id} f={funnelRow.funnel} /></div>}
      <div className="mb-4 flex gap-2">{TABS.map(([k, l]) => <Link key={k} href={`/pinterest/blog/sites/${id}?tab=${k}`} className={`badge px-3 py-1 ${tab === k ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{l}</Link>)}</div>

      {tab === "queue" && <QueueTab siteId={id} q={q} />}
      {tab === "settings" && (
        <div className="space-y-4">
          {!site.accessId && <Alert tone="warn">Сайт не привязан к доступу WordPress: публикация и синхронизация категорий работать не будут.</Alert>}
          {site.access && site.access.lastCheckOk === false && <Alert tone="danger">Последняя проверка подключения к WordPress не прошла — проверьте доступ на <Link href={`/sites/${site.accessId}`} className="underline">странице сайта</Link>.</Alert>}
          <Card title="Настройки сайта" description="Что относится к сайту целиком и значения по умолчанию для новых запусков.">
            <BlogSiteSettingsForm site={{ id: site.id, name: site.name, defaultRecipeId: site.defaultRecipeId }} settings={settings} categories={categories} recipes={await prisma.blogRecipe.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, isActive: true } })} />
          </Card>
          <Card title="Категории WordPress" description={categories.length ? `В кэше ${categories.length} категорий.` : "Категории ещё не загружались. Нужны для правил «ключ → категория» и категории по умолчанию."}>
            <div className="flex flex-wrap items-center gap-3">
              <ActionForm action={syncBlogSiteCategories} hidden={{ id }} className="inline"><SubmitButton className="btn-primary" pendingText="Загружаю…">Синхронизировать категории WordPress</SubmitButton></ActionForm>
              {categories.length > 0 && <details className="text-[13px]"><summary className="help cursor-pointer">Показать список</summary><div className="mt-2 flex flex-wrap gap-1.5">{categories.map((c) => <Badge key={c.id}>{c.name} <span className="opacity-60">#{c.id}</span></Badge>)}</div></details>}
            </div>
          </Card>
          <ActionForm action={toggleBlogSiteActive} hidden={{ id }}>
            <SubmitButton className="btn-ghost" pendingText="…">{site.isActive ? "Убрать сайт в архив" : "Вернуть сайт из архива"}</SubmitButton>
          </ActionForm>
          <p className="help">В архиве воркер не берёт посты сайта; история и настройки сохраняются.</p>
        </div>
      )}
    </>
  );
}

async function QueueTab({ siteId, q }: { siteId: string; q: SearchParams }) {
  const status = sp(q, "status") ?? "";
  const runId = sp(q, "run") ?? "";
  const search = sp(q, "q") ?? "";
  const page = Math.max(1, Number(sp(q, "page")) || 1);
  const [data, runs] = await Promise.all([queuePage(siteId, { status: status || undefined, runId: runId || undefined, q: search || undefined, page, perPage: 50 }), siteRuns(siteId)]);
  const link = (p: number) => { const u = new URLSearchParams({ tab: "queue" }); if (status) u.set("status", status); if (runId) u.set("run", runId); if (search) u.set("q", search); if (p > 1) u.set("page", String(p)); return `/pinterest/blog/sites/${siteId}?${u}`; };
  return (
    <Card title="Очередь" description="Все статьи сайта. Отметьте нужные — действия сверху таблицы. Клик по ключу открывает карточку статьи.">
      <form method="get" action={`/pinterest/blog/sites/${siteId}`} className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
        <input type="hidden" name="tab" value="queue" />
        <select name="status" className="input py-2" defaultValue={status}><option value="">Все статусы</option>{STATUS_FILTER_GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</select>
        <select name="run" className="input py-2" defaultValue={runId}><option value="">Все запуски</option>{runs.map((r) => <option key={r.id} value={r.id}>{r.name || r.id.slice(0, 8)} · {r._count.posts} · {r.createdAt.toLocaleDateString("ru-RU")}</option>)}</select>
        <input name="q" className="input py-2" defaultValue={search} placeholder="Поиск по ключу, заголовку или адресу" />
        <div className="flex gap-2"><button type="submit" className="btn-primary">Показать</button>{(status || runId || search) && <Link href={`/pinterest/blog/sites/${siteId}?tab=queue`} className="btn-ghost">Сбросить</Link>}</div>
      </form>
      <p className="help mb-2">Найдено: {data.total}{data.pages > 1 ? ` · страница ${data.page} из ${data.pages}` : ""}</p>
      <PostsTable rows={data.rows} showRun emptyText={status || runId || search ? "По фильтру ничего не найдено" : "У сайта ещё нет статей. Нажмите «Новый запуск»."} />
      {data.pages > 1 && <div className="mt-3 flex flex-wrap items-center gap-2">{data.page > 1 && <Link href={link(data.page - 1)} className="btn-ghost btn-sm">← Назад</Link>}<span className="help">{data.page} / {data.pages}</span>{data.page < data.pages && <Link href={link(data.page + 1)} className="btn-ghost btn-sm">Вперёд →</Link>}</div>}
    </Card>
  );
}
