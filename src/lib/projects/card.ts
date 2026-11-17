/**
 * Карточка проекта: создаётся сама при первом открытии сайта в «Проектах».
 * При создании — предзаданные этапы и бэкфил истории из прогонов, выгрузок и публикаций (один раз).
 */
import { prisma } from "@/lib/db";
import { DEFAULT_STEPS } from "./steps";
import { eventText } from "./events";

export async function ensureCard(accessId: string) {
  let card = await prisma.prjCard.findUnique({ where: { accessId }, include: { steps: { orderBy: { order: "asc" } } } });
  if (!card) {
    await prisma.prjCard.upsert({ where: { accessId }, update: {}, create: { accessId } });
    card = await prisma.prjCard.findUnique({ where: { accessId }, include: { steps: { orderBy: { order: "asc" } } } });
  }
  if (!card) throw new Error("Карточка проекта не создалась");
  if (!card.steps.length) {
    await prisma.prjStep.createMany({ data: DEFAULT_STEPS.map((s, i) => ({ cardId: card!.id, key: s.key, title: s.title, order: i })), skipDuplicates: true });
    card = (await prisma.prjCard.findUnique({ where: { accessId }, include: { steps: { orderBy: { order: "asc" } } } }))!;
  }
  if (!card.backfilledAt) {
    await backfillHistory(card.id, accessId).catch(() => {});
    await prisma.prjCard.update({ where: { id: card.id }, data: { backfilledAt: new Date() } });
  }
  return card;
}

/** Всё, что уже известно системе по сайту, — в историю с настоящими датами. Дубли по (kind, refId) не создаются. */
export async function backfillHistory(cardId: string, accessId: string): Promise<number> {
  const [pinSites, artSites, blogSites] = await Promise.all([
    prisma.pinSite.findMany({ where: { wpConnectionId: accessId }, select: { id: true } }),
    prisma.artSite.findMany({ where: { accessId }, select: { id: true } }),
    prisma.blogSite.findMany({ where: { accessId }, select: { id: true } }),
  ]);
  const P = pinSites.map((s) => s.id), A = artSites.map((s) => s.id), B = blogSites.map((s) => s.id);
  const [runs, exportsLog, uploads, articles, posts, existing] = await Promise.all([
    P.length ? prisma.pinRun.findMany({ where: { siteId: { in: P }, NOT: { name: "__system__" } }, select: { id: true, name: true, status: true, createdAt: true, updatedAt: true, costUsd: true, blockedReason: true, createdById: true, _count: { select: { pages: true, items: { where: { status: { notIn: ["POOL", "REMOVED"] }, moderation: { not: "REJECTED" } } } } } } }) : [],
    P.length ? prisma.pinExportLog.findMany({ where: { siteId: { in: P } }, select: { id: true, day: true, rows: true, fileName: true, createdAt: true, userId: true } }) : [],
    P.length ? prisma.prjUpload.findMany({ where: { pinSiteId: { in: P } } }) : [],
    A.length ? prisma.article.findMany({ where: { siteId: { in: A }, status: "COMPLETED" }, select: { id: true, keyword: true, wpUrl: true, publishedAt: true, finishedAt: true, costUsd: true } }) : [],
    B.length ? prisma.blogPost.findMany({ where: { siteId: { in: B }, status: "COMPLETED" }, select: { id: true, keyword: true, wpUrl: true, publishedAt: true, finishedAt: true, costUsd: true } }) : [],
    prisma.prjEvent.findMany({ where: { cardId, refId: { not: null } }, select: { kind: true, refId: true } }),
  ]);
  const have = new Set(existing.map((e) => `${e.kind}|${e.refId}`));
  const rows: Array<{ cardId: string; kind: string; refId: string; summary: string; at: Date; userId: string | null; payload?: object }> = [];
  const push = (kind: string, refId: string, summary: string, at: Date, userId: string | null = null, payload?: object) => { if (!have.has(`${kind}|${refId}`)) rows.push({ cardId, kind, refId, summary, at, userId, payload }); };
  for (const r of runs) {
    push("run_created", r.id, eventText.runCreated(r.name, r._count.pages), r.createdAt, r.createdById);
    if (r.status === "DONE") push("run_done", r.id, eventText.runDone(r.name, r._count.items), r.updatedAt, null, { costUsd: r.costUsd });
    if (r.status === "FAILED") push("run_failed", r.id, eventText.runFailed(r.name, r.blockedReason), r.updatedAt);
  }
  for (const e of exportsLog) push("export_downloaded", e.id, eventText.exportDownloaded(e.day, e.rows, e.fileName), e.createdAt, e.userId);
  for (const u of uploads) push("export_uploaded", u.id, eventText.exportUploaded(u.day), u.uploadedAt, u.uploadedById);
  for (const a of articles) push("article_published", a.id, eventText.articlePublished(a.keyword, a.wpUrl), a.publishedAt ?? a.finishedAt ?? new Date(), null, { costUsd: a.costUsd });
  for (const p of posts) push("blog_published", p.id, eventText.articlePublished(p.keyword, p.wpUrl), p.publishedAt ?? p.finishedAt ?? new Date(), null, { costUsd: p.costUsd });
  if (rows.length) await prisma.prjEvent.createMany({ data: rows });
  return rows.length;
}

/** Строка ленты: событие или заметка. */
export type FeedItem = { id: string; at: string; kind: string; summary: string; userId: string | null; refId: string | null; isNote: boolean; costUsd: number | null };

export async function projectFeed(cardId: string, limit = 200): Promise<FeedItem[]> {
  const [events, notes] = await Promise.all([
    prisma.prjEvent.findMany({ where: { cardId }, orderBy: { at: "desc" }, take: limit }),
    prisma.prjNote.findMany({ where: { cardId }, orderBy: { createdAt: "desc" }, take: limit }),
  ]);
  const items: FeedItem[] = [
    ...events.map((e) => ({ id: e.id, at: e.at.toISOString(), kind: e.kind, summary: e.summary, userId: e.userId, refId: e.refId, isNote: false, costUsd: typeof (e.payload as { costUsd?: unknown } | null)?.costUsd === "number" ? ((e.payload as { costUsd: number }).costUsd) : null })),
    ...notes.map((n) => ({ id: n.id, at: n.createdAt.toISOString(), kind: "note", summary: n.text, userId: n.userId, refId: null, isNote: true, costUsd: null })),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

