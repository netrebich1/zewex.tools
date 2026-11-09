import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Empty, PageHeader, type SearchParams, sp } from "@/components/ui";
import { StatusBadge } from "@/components/articles/StatusBadge";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { articleWhere } from "@/lib/articles/access";
import { retryAllPublishAction, retryPublishAction } from "@/actions/articlesModeration";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Tab = "errors" | "queued" | "published";
const PUBLISHED_DAYS = 7;

/** Условие вкладки (оригинал PublicationsPage: error / queued+retry+publishing / published). */
function tabWhere(tab: Tab): Prisma.ArticleWhereInput {
  if (tab === "errors") return { status: "PUBLISH_ERROR" };
  if (tab === "queued") return { OR: [{ status: { in: ["PUBLISH_QUEUED", "PUBLISHING"] } }, { status: { in: ["PENDING", "RUNNING"] }, stage: "publish" }] };
  return { status: "COMPLETED", publishedAt: { gte: new Date(Date.now() - PUBLISHED_DAYS * 86400_000) } };
}

export default async function PublicationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const tab: Tab = (["errors", "queued", "published"] as Tab[]).find((t) => t === sp(params, "tab")) ?? "errors";
  const siteId = sp(params, "site");
  const base = await articleWhere(me);
  const siteFilter = siteId ? { siteId } : {};

  const [errors, queued, published, rows, sites] = await Promise.all([
    prisma.article.count({ where: { ...base, ...siteFilter, ...tabWhere("errors") } }),
    prisma.article.count({ where: { ...base, ...siteFilter, ...tabWhere("queued") } }),
    prisma.article.count({ where: { ...base, ...siteFilter, ...tabWhere("published") } }),
    prisma.article.findMany({
      where: { ...base, ...siteFilter, ...tabWhere(tab) },
      orderBy: tab === "published" ? { publishedAt: "desc" } : { updatedAt: "desc" },
      take: 200,
      select: { id: true, keyword: true, status: true, stage: true, publishAttempts: true, nextRunAt: true, publishedAt: true, updatedAt: true, error: true, wpUrl: true, wpPostId: true, wpStatus: true, site: { select: { id: true, name: true } } },
    }),
    prisma.artSite.findMany({ where: { articles: { some: { ...base, status: { in: ["PUBLISH_ERROR", "PUBLISH_QUEUED", "PUBLISHING", "COMPLETED", "PENDING", "RUNNING"] } } } }, select: { id: true, name: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
  ]);

  const qs = (patch: { tab?: string; site?: string }) => {
    const u = new URLSearchParams();
    const all = { tab, site: siteId, ...patch };
    for (const [k, v] of Object.entries(all)) if (v) u.set(k, v);
    const s = u.toString();
    return `/pinterest/articles/publications${s ? `?${s}` : ""}`;
  };
  const counts: Record<Tab, number> = { errors, queued, published };
  const TAB_LABELS: Record<Tab, string> = { errors: "Ошибки", queued: "В очереди", published: `Опубликовано за ${PUBLISHED_DAYS} дн.` };

  return (
    <>
      <PageHeader
        back={{ href: "/pinterest/articles", label: "Статьи" }}
        title="Публикации"
        subtitle="Что не опубликовалось, что ждёт очереди публикации и что вышло на сайт за последние дни."
        actions={<Link href="/pinterest/articles/moderation/articles" className="btn-ghost">К модерации статей</Link>}
      />
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap gap-2 items-center">
            {(["errors", "queued", "published"] as Tab[]).map((t) => (
              <Link key={t} href={qs({ tab: t })} className={`tab ${tab === t ? "active" : ""}`}>
                {TAB_LABELS[t]} · {counts[t]}
              </Link>
            ))}
            {tab === "errors" && errors > 0 && (
              <ActionForm action={retryAllPublishAction} hidden={{ siteId: siteId ?? "" }} className="ml-auto">
                <SubmitButton className="btn-primary btn-sm" pendingText="Ставлю в очередь…" confirm={`Повторить публикацию всех ${errors} статей с ошибкой?`}>
                  Повторить все ({errors})
                </SubmitButton>
              </ActionForm>
            )}
          </div>
          {sites.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2 items-center">
              <Link href={qs({ site: undefined })} className={`badge px-3 py-1 max-sm:!py-1.5 max-sm:min-h-8 ${!siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все сайты</Link>
              {sites.map((s) => (
                <Link key={s.id} href={qs({ site: s.id })} className={`badge px-3 py-1 max-sm:!py-1.5 max-sm:min-h-8 ${siteId === s.id ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{s.name}</Link>
              ))}
            </div>
          )}
        </Card>

        {rows.length === 0 ? (
          <Empty title={tab === "errors" ? "Ошибок публикации нет" : tab === "queued" ? "Очередь публикации пуста" : "За этот период ничего не опубликовано"} />
        ) : (
          <Card className="p-0 sm:p-0">
            <div className="table-wrap !mx-0 !px-0">
              <table className="table">
                <thead>
                  <tr>
                    <th>Статья</th>
                    <th className="col-sm">Сайт</th>
                    <th>Состояние</th>
                    {tab !== "published" && <th className="col-sm">Попыток</th>}
                    <th className="col-sm">{tab === "published" ? "Опубликована" : tab === "queued" ? "Следующая попытка" : "Зафиксировано"}</th>
                    <th className="col-sm"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    return (
                      <tr key={r.id}>
                        <td>
                          <Link href={`/pinterest/articles/articles/${r.id}`} className="font-medium hover:underline">{r.keyword}</Link>
                          {tab === "errors" && r.error && <div className="help mt-0.5 max-w-xl whitespace-pre-wrap break-words">{r.error.slice(0, 400)}</div>}
                          {/* Телефон: скрытые колонки — строкой под ключом, кнопки — здесь же */}
                          <div className="help mt-0.5 sm:hidden">
                            {r.site.name}
                            {tab !== "published" && ` · попыток ${r.publishAttempts}`} · {tab === "published" ? fmtDate(r.publishedAt) : tab === "queued" ? (r.nextRunAt ? fmtDate(r.nextRunAt) : "сейчас") : fmtDate(r.updatedAt)}
                          </div>
                          {(r.wpUrl || tab === "errors") && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 sm:hidden">
                              {r.wpUrl && (
                                <a href={r.wpUrl} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">На сайте ↗</a>
                              )}
                              {tab === "errors" && (
                                <ActionForm action={retryPublishAction} hidden={{ id: r.id }} className="inline">
                                  <SubmitButton className="btn-primary btn-sm" pendingText="…">Повторить</SubmitButton>
                                </ActionForm>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="col-sm whitespace-nowrap">{r.site.name}</td>
                        <td>
                          <StatusBadge status={r.status} />
                          {r.wpStatus && tab !== "published" && <div className="help mt-0.5">WP: {r.wpStatus}</div>}
                        </td>
                        {tab !== "published" && <td className="col-sm">{r.publishAttempts}</td>}
                        <td className="col-sm whitespace-nowrap">{tab === "published" ? fmtDate(r.publishedAt) : tab === "queued" ? (r.nextRunAt ? fmtDate(r.nextRunAt) : "сейчас") : fmtDate(r.updatedAt)}</td>
                        <td className="col-sm">
                          <div className="flex flex-wrap items-center gap-1.5 justify-end">
                            {r.wpUrl && (
                              <a href={r.wpUrl} target="_blank" rel="noreferrer" className="btn-ghost btn-sm" title="Открыть на сайте">На сайте ↗</a>
                            )}
                            <Link href={`/pinterest/articles/articles/${r.id}`} className="btn-ghost btn-sm">Карточка</Link>
                            {tab === "errors" && (
                              <ActionForm action={retryPublishAction} hidden={{ id: r.id }} className="inline">
                                <SubmitButton className="btn-primary btn-sm" pendingText="…">Повторить</SubmitButton>
                              </ActionForm>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
