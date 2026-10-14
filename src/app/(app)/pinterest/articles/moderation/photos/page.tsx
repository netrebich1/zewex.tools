import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { PhotoModerationPipeline } from "@/components/articles/PhotoModerationPipeline";
import { activeClaims, claimArticle, nextForReview, photoState, waitingCounts, type PhotoModerationState } from "@/lib/articles/moderation";
import { MIN_PHOTOS } from "@/lib/articles/types";

export const dynamic = "force-dynamic";

/**
 * Модерация фото (режим «фото до текста»): конвейер «следующая свободная статья».
 * ?site=<id> — только этот сайт; ?article=<id> — открыть конкретную статью (если её не держит другой).
 */
export default async function PhotoModerationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const siteId = sp(params, "site");
  const wanted = sp(params, "article");

  const [counts, claims] = await Promise.all([waitingCounts(me, ["PHOTO_REVIEW"]), activeClaims(me)]);

  let articleId: string | null = null;
  let state: PhotoModerationState | null = null;
  let message: string | undefined;
  if (wanted) {
    try {
      const c = await claimArticle(me, wanted);
      if (c.claimed) articleId = wanted;
      else message = `Статью сейчас модерирует ${c.by}. Показана следующая свободная.`;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }
  if (!articleId) articleId = await nextForReview(me, { siteId });
  if (articleId) {
    try {
      state = await photoState(me, articleId);
    } catch {
      articleId = null;
    }
  }

  const qs = (site?: string) => `/pinterest/articles/moderation/photos${site ? `?site=${site}` : ""}`;

  return (
    <>
      <PageHeader
        back={{ href: "/pinterest/articles", label: "Статьи" }}
        title="Модерация фото"
        subtitle={`Ждут проверки: ${counts.total}. Снимите лишние кадры, добавьте из резерва, расставьте порядок и нажмите «Одобрить и писать» (Enter). Одобрить можно при ${MIN_PHOTOS}+ фото или не меньше плана статьи.`}
        actions={<Link href="/pinterest/articles/moderation/articles" className="btn-ghost">Модерация статей</Link>}
      />
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap gap-2 items-center">
            <Link href={qs()} className={`badge px-3 py-1 ${!siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все сайты · {counts.total}</Link>
            {counts.sites.map((s) => (
              <Link key={s.siteId} href={qs(s.siteId)} className={`badge px-3 py-1 ${siteId === s.siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>
                {s.siteName} · {s.count}
              </Link>
            ))}
          </div>
        </Card>
        <PhotoModerationPipeline key={`${siteId ?? "all"}:${articleId ?? "none"}`} userId={me.id} siteId={siteId} initialArticleId={articleId} initialState={state} initialMessage={message} claims={claims} minPhotos={MIN_PHOTOS} />
      </div>
    </>
  );
}
