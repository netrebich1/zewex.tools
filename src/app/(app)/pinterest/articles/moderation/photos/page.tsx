import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { PhotoModerationPipeline } from "@/components/articles/PhotoModerationPipeline";
import { PhotoQueueList } from "@/components/articles/PhotoQueueList";
import { activeClaims, claimArticle, nextForReview, photoQueue, photoState, waitingCounts, type PhotoModerationState, type PhotoQueueGroup } from "@/lib/articles/moderation";
import { MIN_PHOTOS } from "@/lib/articles/types";

export const dynamic = "force-dynamic";

const BASE = "/pinterest/articles/moderation/photos";

/**
 * Модерация фото (режим «фото до текста»).
 * Без параметров — очередь списком (группы «От ИИ» / «Новые» / «Мало фото»), ничего не закрепляет.
 * ?work=1 — конвейер «следующая свободная статья» (закрепляет); ?article=<id> — открыть конкретную статью.
 * ?site=<id> — только этот сайт; ?group=ai|new|low — вкладка списка.
 */
export default async function PhotoModerationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const siteId = sp(params, "site");
  const wanted = sp(params, "article");
  const work = sp(params, "work") === "1";
  const g = sp(params, "group");
  const group: PhotoQueueGroup | undefined = g === "ai" || g === "new" || g === "low" ? g : undefined;

  const counts = await waitingCounts(me, ["PHOTO_REVIEW"]);
  const qs = (patch: { site?: string; work?: boolean }) => {
    const u = new URLSearchParams();
    const site = "site" in patch ? patch.site : siteId;
    if (site) u.set("site", site);
    if (patch.work ?? (work || !!wanted)) u.set("work", "1");
    const s = u.toString();
    return `${BASE}${s ? `?${s}` : ""}`;
  };
  const siteChips = (
    <Card>
      <div className="flex flex-wrap gap-2 items-center">
        <Link href={qs({ site: undefined })} className={`badge px-3 py-1 ${!siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все сайты · {counts.total}</Link>
        {counts.sites.map((s) => (
          <Link key={s.siteId} href={qs({ site: s.siteId })} className={`badge px-3 py-1 ${siteId === s.siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>
            {s.siteName} · {s.count}
          </Link>
        ))}
      </div>
    </Card>
  );

  // Очередь списком: просто посмотреть, что ждёт, — статьи не закрепляются.
  if (!wanted && !work) {
    const queue = await photoQueue(me, { siteId });
    const ready = queue.counts.ai + queue.counts.new;
    return (
      <>
        <PageHeader
          back={{ href: "/pinterest/articles", label: "Статьи" }}
          title="Модерация фото"
          subtitle={`Ждут проверки: ${ready}${queue.counts.low ? ` · мало фото: ${queue.counts.low}` : ""}${queue.counts.aiBusy ? ` · у ИИ на проверке: ${queue.counts.aiBusy}` : ""}. Откройте статью из списка или начните проверку по очереди.`}
          actions={
            <>
              <Link href="/pinterest/articles/moderation/articles" className="btn-ghost">Модерация статей</Link>
              <Link href={qs({ work: true })} className={`btn-brand ${ready ? "" : "pointer-events-none opacity-50"}`} aria-disabled={!ready}>
                Начать проверку
              </Link>
            </>
          }
        />
        <div className="space-y-4">
          {siteChips}
          <PhotoQueueList key={siteId ?? "all"} queue={queue} siteId={siteId} initialGroup={group} minPhotos={MIN_PHOTOS} />
        </div>
      </>
    );
  }

  const claims = await activeClaims(me);
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

  return (
    <>
      <PageHeader
        back={{ href: `${BASE}${siteId ? `?site=${siteId}` : ""}`, label: "Очередь модерации фото" }}
        title="Модерация фото"
        subtitle={`Ждут проверки: ${counts.total}. Снимите лишние кадры, добавьте из резерва, расставьте порядок и нажмите «Одобрить и писать» (Enter). Одобрить можно при ${MIN_PHOTOS}+ фото или не меньше плана статьи.`}
        actions={<Link href="/pinterest/articles/moderation/articles" className="btn-ghost">Модерация статей</Link>}
      />
      <div className="space-y-4">
        {siteChips}
        <PhotoModerationPipeline key={`${siteId ?? "all"}:${articleId ?? "none"}`} userId={me.id} siteId={siteId} initialArticleId={articleId} initialState={state} initialMessage={message} claims={claims} minPhotos={MIN_PHOTOS} listHref={`${BASE}${siteId ? `?site=${siteId}` : ""}`} />
      </div>
    </>
  );
}
