import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Alert, Badge, Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { canAccessBlogSite } from "@/lib/blog/access";
import { PUBLISH_MODES, REVIEW_MODES, type BlogRunSettings } from "@/lib/blog/types";
import { STATUS_LABELS } from "@/lib/blog/labels";
import { runPosts, runProgress } from "@/lib/blog/queries";
import { PostsTable } from "@/components/blog/PostsTable";
import { badgeTone } from "@/components/blog/StatusBadge";
import { AutoRefresh } from "@/components/blog/AutoRefresh";
import { fmtDate, fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function BlogRunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const skipped = (sp(query, "skipped") ?? "").split("\n").filter(Boolean);
  const run = await prisma.blogRun.findUnique({ where: { id }, include: { site: { select: { id: true, name: true, teamId: true, accessId: true } }, recipe: { select: { id: true, name: true } } } });
  if (!run || !(await canAccessBlogSite(me, run.site))) notFound();
  const s = run.settings as unknown as BlogRunSettings;
  const [progress, rows, author] = await Promise.all([runProgress(id), runPosts(id), run.createdById ? prisma.user.findUnique({ where: { id: run.createdById }, select: { name: true, email: true } }) : null]);
  const pct = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  return (
    <>
      <AutoRefresh enabled={progress.live > 0} everyMs={20_000} />
      <PageHeader back={{ href: `/pinterest/blog/sites/${run.site.id}`, label: run.site.name }} title={run.name || `Запуск ${id.slice(0, 8)}`} subtitle={`${run.site.name} · ${run.recipe?.name ?? "рецепт удалён"} · ${fmtDate(run.createdAt)}${author ? ` · ${author.name || author.email}` : ""}`} actions={<Link href={`/pinterest/blog/runs/new?site=${run.site.id}`} className="btn-ghost">Ещё запуск для сайта</Link>} />
      {skipped.length > 0 && <div className="mb-4"><Alert tone="warn"><div className="font-medium">Пропущены ключи, которые уже есть у сайта ({skipped.length}):</div><ul className="mt-1 list-disc pl-5 text-[13px]">{skipped.map((k) => <li key={k}>{k}</li>)}</ul></Alert></div>}
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[14px]">Опубликовано <b>{progress.completed}</b> из <b>{progress.total}</b></span>
            {progress.live > 0 && <span className="help">в работе и очереди {progress.live}</span>}
            {progress.waiting > 0 && <span className="text-warn text-[13px]">ждут проверки {progress.waiting}</span>}
            {progress.errors > 0 && <span className="text-danger text-[13px]">ошибок {progress.errors}</span>}
            <span className="ml-auto help">расход {fmtMoney(progress.costUsd)}</span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-ink/5"><div className="h-full bg-ok transition-all" style={{ width: `${pct}%` }} /></div>
          <div className="mt-3 flex flex-wrap gap-1.5">{progress.byStatus.map((b) => <Badge key={b.status} tone={badgeTone(STATUS_LABELS[b.status].tone)}>{STATUS_LABELS[b.status].label}: {b.count}</Badge>)}</div>
        </Card>
        <Card title="Параметры запуска" description="Сохранены в снимке каждой статьи: правка рецепта или настроек сайта на эту партию не влияет.">
          <dl className="grid gap-x-6 gap-y-1.5 text-[14px] sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex justify-between gap-3"><dt className="text-muted">Проверка</dt><dd>{REVIEW_MODES.find((m) => m.value === s.review)?.label ?? s.review}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Публикация</dt><dd>{PUBLISH_MODES.find((m) => m.value === s.publishMode)?.label ?? s.publishMode}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Объём</dt><dd>{s.length ? `${s.length.min}–${s.length.max} слов` : "как в рецепте"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Картинок</dt><dd>{s.images ? `${s.images.min}–${s.images.max}` : "как в рецепте"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Поиск фото</dt><dd>{[s.search?.country && `страна ${s.search.country}`, s.search?.language && `язык ${s.search.language}`].filter(Boolean).join(", ") || "как в рецепте"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Год в URL</dt><dd>{s.yearInUrlPercent == null ? "как в рецепте" : `${s.yearInUrlPercent}%`}</dd></div>
          </dl>
        </Card>
        <Card title={`Статьи · ${rows.length}`} description="Отметьте статьи для массовых действий. Клик по ключу — карточка статьи."><PostsTable rows={rows} emptyText="В запуске нет статей" /></Card>
      </div>
    </>
  );
}
