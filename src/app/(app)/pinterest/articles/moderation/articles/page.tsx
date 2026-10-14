import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ArticleReviewPanel, type ReviewListItem } from "@/components/articles/ArticleReviewPanel";
import { articleWhere } from "@/lib/articles/access";
import { claimArticle, nextForReview, reviewState, waitingCounts, type ArticleReviewState } from "@/lib/articles/moderation";
import { CLAIM_TTL_MIN, type ArticleFacts } from "@/lib/articles/types";

export const dynamic = "force-dynamic";

/**
 * Модерация статей перед публикацией: вкладки «На модерации» (REVIEW_PENDING) и «В доработке» (NEEDS_REWORK),
 * фильтр сайта, список слева, карточка справа. ?article=<id> — открыть конкретную статью.
 */
export default async function ArticlesModerationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const tab = sp(params, "tab") === "rework" ? "rework" : "review";
  const siteId = sp(params, "site");
  const wanted = sp(params, "article");
  const status = tab === "rework" ? "NEEDS_REWORK" : "REVIEW_PENDING";
  const mode = tab === "rework" ? "rework" : "articles";

  const [counts, reworkCounts, rows] = await Promise.all([
    waitingCounts(me, ["REVIEW_PENDING"]),
    waitingCounts(me, ["NEEDS_REWORK"]),
    prisma.article.findMany({
      where: { ...(await articleWhere(me)), status, ...(siteId ? { siteId } : {}) },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 200,
      select: { id: true, keyword: true, keywordRu: true, facts: true, status: true, note: true, claimedById: true, claimedAt: true, site: { select: { name: true } } },
    }),
  ]);
  const claimerIds = [...new Set(rows.map((r) => r.claimedById).filter((x): x is string => !!x))];
  const users = claimerIds.length ? await prisma.user.findMany({ where: { id: { in: claimerIds } }, select: { id: true, name: true } }) : [];
  const stale = Date.now() - CLAIM_TTL_MIN * 60_000;
  const items: ReviewListItem[] = rows.map((r) => ({
    id: r.id,
    keyword: r.keyword,
    keywordRu: r.keywordRu || ((r.facts as ArticleFacts | null)?.keywordRu ?? ""),
    siteName: r.site.name,
    status: r.status,
    note: r.note,
    claimedById: r.claimedById,
    claimedByName: r.claimedById === me.id ? "вы" : users.find((u) => u.id === r.claimedById)?.name ?? null,
    claimedFresh: !!r.claimedAt && r.claimedAt.getTime() > stale,
  }));

  let articleId: string | null = null;
  let state: ArticleReviewState | null = null;
  let message: string | undefined;
  if (wanted) {
    try {
      const c = await claimArticle(me, wanted, [status]);
      if (c.claimed) articleId = wanted;
      else message = `Статью сейчас модерирует ${c.by}.`;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }
  if (!articleId && items.length) articleId = await nextForReview(me, { siteId, statuses: [status] });
  if (articleId) {
    try {
      state = await reviewState(me, articleId);
    } catch {
      articleId = null;
    }
  }

  const counted = tab === "rework" ? reworkCounts : counts;
  const qs = (patch: { tab?: string; site?: string }) => {
    const u = new URLSearchParams();
    const all = { tab: tab === "rework" ? "rework" : undefined, site: siteId, ...patch };
    for (const [k, v] of Object.entries(all)) if (v) u.set(k, v);
    const s = u.toString();
    return `/pinterest/articles/moderation/articles${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <PageHeader
        back={{ href: "/pinterest/articles", label: "Статьи" }}
        title="Модерация статей"
        subtitle="Проверьте мета-поля, категорию и текст под каждым фото. Enter — одобрить, S — пропустить. Снятые фото удаляются из статьи при одобрении, HTML пересобирается."
        actions={<Link href="/pinterest/articles/moderation/photos" className="btn-ghost">Модерация фото</Link>}
      />
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap gap-2 items-center">
            <Link href={qs({ tab: undefined })} className={`tab ${tab === "review" ? "active" : ""}`}>На модерации · {counts.total}</Link>
            <Link href={qs({ tab: "rework" })} className={`tab ${tab === "rework" ? "active" : ""}`}>В доработке · {reworkCounts.total}</Link>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            <Link href={qs({ site: undefined })} className={`badge px-3 py-1 ${!siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все сайты · {counted.total}</Link>
            {counted.sites.map((s) => (
              <Link key={s.siteId} href={qs({ site: s.siteId })} className={`badge px-3 py-1 ${siteId === s.siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>
                {s.siteName} · {s.count}
              </Link>
            ))}
          </div>
          {tab === "rework" && <p className="help mt-3">Статьи с замечанием модератора. Исправьте фото или мета и нажмите «Одобрить» — статья пойдёт на публикацию; либо откройте карточку и перезапустите с нужного этапа.</p>}
        </Card>
        <ArticleReviewPanel key={`${tab}:${siteId ?? "all"}:${articleId ?? "none"}`} userId={me.id} mode={mode} items={items} initialId={articleId} initialState={state} initialMessage={message} />
      </div>
    </>
  );
}
