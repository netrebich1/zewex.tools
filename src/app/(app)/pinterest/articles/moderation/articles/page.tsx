import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ArticleReviewPanel, type ReviewListItem } from "@/components/articles/ArticleReviewPanel";
import { PhotoModerationPipeline } from "@/components/articles/PhotoModerationPipeline";
import { PhotoQueueList } from "@/components/articles/PhotoQueueList";
import { articleWhere } from "@/lib/articles/access";
import { activeClaims, claimArticle, nextForReview, photoQueue, photoState, reviewState, waitingCounts, type ArticleReviewState, type PhotoModerationState, type PhotoQueueGroup } from "@/lib/articles/moderation";
import { CLAIM_TTL_MIN, MIN_PHOTOS, type ArticleFacts } from "@/lib/articles/types";

export const dynamic = "force-dynamic";

const BASE = "/pinterest/articles/moderation/articles";

type Tab = PhotoQueueGroup | "review" | "rework";
const TABS: Tab[] = ["ai", "new", "low", "review", "rework"];
const PHOTO_HINT: Record<PhotoQueueGroup, string> = {
  ai: "ИИ проверил фото и отдал людям (или только предложил правки в тест-режиме) — причина под ключом. Enter — одобрить и писать, → — пропустить, ← — предыдущая.",
  new: "Фото, которые ИИ не смотрел: проверка ИИ у сайта выключена или ещё не дошла. Enter — одобрить и писать, → — пропустить, ← — предыдущая.",
  low: "Подходящих кадров не хватило. Верните на модерацию, отправьте добирать или закройте.",
};

/**
 * Модерация: фото (до текста) и готовые статьи на одной странице. Вкладки «Фото от ИИ» / «Фото без ИИ» / «Мало фото»
 * (PHOTO_REVIEW, INSUFFICIENT_PHOTOS, WAITING_FOR_PHOTOS) и «Статьи» (REVIEW_PENDING) / «В доработке» (NEEDS_REWORK).
 * Список слева, карточка справа. ?tab=…, ?site=<id>, ?article=<id> — открыть конкретную статью (вкладка по её статусу).
 */
export default async function ModerationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const siteId = sp(params, "site");
  const wanted = sp(params, "article");
  const t = sp(params, "tab");

  const [queue, counts, reworkCounts] = await Promise.all([photoQueue(me), waitingCounts(me, ["REVIEW_PENDING"]), waitingCounts(me, ["NEEDS_REWORK"])]);
  const total: Record<Tab, number> = { ai: queue.counts.ai, new: queue.counts.new, low: queue.counts.low, review: counts.total, rework: reworkCounts.total };

  // Вкладка: из адреса; для ?article= — по статусу статьи; иначе первая непустая (фото раньше статей).
  let tab: Tab | undefined = TABS.includes(t as Tab) ? (t as Tab) : undefined;
  if (!tab && wanted) {
    const inQueue = queue.items.find((i) => i.id === wanted);
    if (inQueue) tab = inQueue.group;
    else {
      const a = await prisma.article.findFirst({ where: { ...(await articleWhere(me)), id: wanted }, select: { status: true } });
      tab = a?.status === "NEEDS_REWORK" ? "rework" : "review";
    }
  }
  tab ??= (["ai", "new", "review", "rework", "low"] as Tab[]).find((k) => total[k] > 0) ?? "review";
  const photoTab = tab === "ai" || tab === "new" || tab === "low";

  const qs = (patch: { tab?: Tab; site?: string | null }) => {
    const u = new URLSearchParams();
    const tb = patch.tab ?? tab;
    const site = "site" in patch ? patch.site : siteId;
    u.set("tab", tb!);
    if (site) u.set("site", site);
    return `${BASE}?${u}`;
  };

  // Чипы сайтов: у вкладок фото — из очереди, у статей — по статусу.
  let sites: Array<{ siteId: string; siteName: string; count: number }>;
  if (photoTab) {
    const m = new Map<string, { siteId: string; siteName: string; count: number }>();
    for (const i of queue.items.filter((i) => i.group === tab)) {
      const s = m.get(i.siteId) ?? { siteId: i.siteId, siteName: i.siteName, count: 0 };
      s.count++;
      m.set(i.siteId, s);
    }
    sites = [...m.values()].sort((a, b) => a.siteName.localeCompare(b.siteName, "ru"));
  } else sites = (tab === "rework" ? reworkCounts : counts).sites;
  const tabTotal = total[tab];

  const label: Record<Tab, string> = { ai: "Фото от ИИ", new: "Фото без ИИ", low: "Мало фото", review: "Статьи", rework: "В доработке" };
  const head = (
    <Card>
      <div className="flex flex-wrap gap-2 items-center">
        {TABS.map((k, i) => (
          <span key={k} className="contents">
            {i === 3 && <span className="mx-1 h-5 w-px bg-line" aria-hidden />}
            <Link href={qs({ tab: k, site: null })} className={`tab ${tab === k ? "active" : ""}`}>
              {label[k]} · {total[k]}
            </Link>
          </span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 items-center">
        <Link href={qs({ site: null })} className={`badge px-3 py-1 ${!siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все сайты · {tabTotal}</Link>
        {sites.map((s) => (
          <Link key={s.siteId} href={qs({ site: s.siteId })} className={`badge px-3 py-1 ${siteId === s.siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>
            {s.siteName} · {s.count}
          </Link>
        ))}
      </div>
      <p className="help mt-3">
        {photoTab
          ? PHOTO_HINT[tab as PhotoQueueGroup]
          : tab === "rework"
            ? "Статьи с замечанием модератора. Исправьте фото или мета и нажмите «Одобрить» — статья пойдёт на публикацию; либо откройте карточку и перезапустите с нужного этапа."
            : "Готовые статьи: проверьте мета-поля, категорию и текст под каждым фото. Enter — одобрить, S — пропустить. Снятые фото удаляются из статьи при одобрении, HTML пересобирается."}
        {photoTab && queue.counts.aiBusy > 0 && ` Ещё ${queue.counts.aiBusy} сейчас проверяет ИИ — появятся после решения.`}
      </p>
    </Card>
  );
  const header = <PageHeader back={{ href: "/pinterest/articles", label: "Статьи" }} title="Модерация" subtitle="Фото до написания текста и готовые статьи перед публикацией — на одной странице." />;

  // «Мало фото» — список с действиями в строке.
  if (tab === "low") {
    const items = queue.items.filter((i) => i.group === "low" && (!siteId || i.siteId === siteId));
    return (
      <>
        {header}
        <div className="space-y-4">
          {head}
          <PhotoQueueList key={siteId ?? "all"} queue={{ items, counts: queue.counts }} siteId={siteId} minPhotos={MIN_PHOTOS} only="low" />
        </div>
      </>
    );
  }

  // Фото от ИИ / без ИИ — список слева, конвейер фото справа.
  if (tab === "ai" || tab === "new") {
    const items = queue.items.filter((i) => i.group === tab && (!siteId || i.siteId === siteId));
    const claims = await activeClaims(me);
    let articleId: string | null = null;
    let state: PhotoModerationState | null = null;
    let message: string | undefined;
    if (wanted) {
      try {
        const c = await claimArticle(me, wanted);
        if (c.claimed) articleId = wanted;
        else message = `Статью сейчас модерирует ${c.by}.`;
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
    }
    if (!articleId) {
      for (const i of items.filter((x) => !x.claimedByName || x.claimedMine).slice(0, 10)) {
        const c = await claimArticle(me, i.id).catch(() => null);
        if (c?.claimed) {
          articleId = i.id;
          break;
        }
      }
    }
    if (articleId) {
      try {
        state = await photoState(me, articleId);
      } catch {
        articleId = null;
      }
    }
    const list = items.map((i) => (i.id === articleId ? { ...i, claimedByName: "вы", claimedMine: true } : i));
    return (
      <>
        {header}
        <div className="space-y-4">
          {head}
          <PhotoModerationPipeline key={`${tab}:${siteId ?? "all"}:${articleId ?? "none"}`} userId={me.id} siteId={siteId} initialArticleId={articleId} initialState={state} initialMessage={message ?? (articleId || !items.length ? undefined : "Все статьи этой вкладки сейчас открыты у коллег.")} claims={claims} minPhotos={MIN_PHOTOS} items={list} />
        </div>
      </>
    );
  }

  // Статьи / В доработке.
  const status = tab === "rework" ? "NEEDS_REWORK" : "REVIEW_PENDING";
  const mode = tab === "rework" ? "rework" : "articles";
  const rows = await prisma.article.findMany({
    where: { ...(await articleWhere(me)), status, ...(siteId ? { siteId } : {}) },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: 200,
    select: { id: true, keyword: true, keywordRu: true, facts: true, status: true, note: true, claimedById: true, claimedAt: true, site: { select: { name: true } } },
  });
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

  return (
    <>
      {header}
      <div className="space-y-4">
        {head}
        <ArticleReviewPanel key={`${tab}:${siteId ?? "all"}:${articleId ?? "none"}`} userId={me.id} mode={mode} items={items} initialId={articleId} initialState={state} initialMessage={message} />
      </div>
    </>
  );
}
