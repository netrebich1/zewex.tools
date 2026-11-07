/** Чтение для экранов партий Article Copy. */
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/auth";
import { artSiteWhere } from "@/lib/articles/access";
import { copySettings } from "./build";
import { availability } from "./batch";
import { groupOf } from "./keys";
import { siteNiches } from "./auto";

/** Порядок ниш в таблице квот; остальные — после. */
export const NICHE_ORDER = ["nails", "hair", "outfits", "interior"];

/** Данные формы новой партии: привязанные сайты с нишами и сколько тем есть в каждой клетке. */
export async function newBatchData(me: CurrentUser, word = "") {
  const [settings, bound, avail] = await Promise.all([copySettings(), prisma.copySite.findMany({ where: { publish: true }, select: { artSiteId: true } }), availability(word)]);
  const sites = await prisma.artSite.findMany({
    where: { ...(await artSiteWhere(me)), id: { in: bound.map((b) => b.artSiteId) }, isActive: true },
    select: { id: true, name: true, nicheCode: true, team: { select: { name: true } }, _count: { select: { articles: true } } },
    orderBy: [{ teamId: "asc" }, { name: "asc" }],
  });
  const withNiches = await Promise.all(sites.map(async (s) => {
    const n = await siteNiches(s.id);
    return { id: s.id, name: s.name, team: s.team.name, grp: s.nicheCode || n.size ? groupOf(s.nicheCode ?? [...n.keys()][0]) : null, niches: [...n.keys()], articles: s._count.articles };
  }));
  const niches = [...new Set([...NICHE_ORDER.filter((n) => avail[n]), ...Object.keys(avail).sort()])];
  return { settings, sites: withNiches, avail, niches };
}

export async function batchesData(me: CurrentUser) {
  const rows = await prisma.copyBatch.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true, email: true } });
  const by = new Map(users.map((u) => [u.id, u.name || u.email]));
  const ids = rows.map((r) => r.id);
  // Состояние статей партии в конвейере: опубликовано и потрачено.
  const stats = ids.length
    ? await prisma.$queryRaw<Array<{ batchId: string; published: bigint; cost: number | null; waiting: bigint }>>`
        SELECT c.batchId, SUM(a.status = 'COMPLETED') published, SUM(a.costUsd) cost, SUM(a.status IN ('REVIEW_PENDING','NEEDS_REWORK')) waiting
        FROM CopyArticle c JOIN Article a ON a.id = c.articleId WHERE c.batchId IN (${Prisma.join(ids)}) GROUP BY c.batchId`
    : [];
  const st = new Map(stats.map((s) => [s.batchId, { published: Number(s.published), cost: s.cost ?? 0, waiting: Number(s.waiting) }]));
  void me;
  return rows.map((r) => ({ ...r, author: by.get(r.createdById) ?? "—", ...(st.get(r.id) ?? { published: 0, cost: 0, waiting: 0 }) }));
}

export async function batchData(me: CurrentUser, id: string) {
  const batch = await prisma.copyBatch.findUnique({ where: { id } });
  if (!batch) return null;
  const [items, sites, author] = await Promise.all([
    prisma.copyBatchItem.findMany({ where: { batchId: id }, orderBy: { position: "asc" } }),
    prisma.artSite.findMany({ where: { id: { in: batch.siteIds as string[] } }, select: { id: true, name: true } }),
    prisma.user.findUnique({ where: { id: batch.createdById }, select: { name: true, email: true } }),
  ]);
  const artIds = items.map((i) => i.articleId).filter((x): x is string => !!x);
  const arts = artIds.length ? await prisma.article.findMany({ where: { id: { in: artIds } }, select: { id: true, status: true, stage: true, wpUrl: true, costUsd: true, error: true } }) : [];
  const art = new Map(arts.map((a) => [a.id, a]));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const published = arts.filter((a) => a.status === "COMPLETED").length;
  const waiting = arts.filter((a) => a.status === "REVIEW_PENDING" || a.status === "NEEDS_REWORK").length;
  const errors = arts.filter((a) => a.status === "FAILED" || a.status === "PUBLISH_ERROR").length;
  const cost = arts.reduce((s, a) => s + a.costUsd, 0);
  const perSite = new Map<string, number>();
  for (const i of items) perSite.set(i.siteId, (perSite.get(i.siteId) ?? 0) + 1);
  void me;
  return {
    batch, author: author?.name || author?.email || "—", sites: sites.map((s) => ({ ...s, items: perSite.get(s.id) ?? 0 })),
    items: items.map((i) => ({ ...i, site: siteName.get(i.siteId) ?? "—", art: i.articleId ? art.get(i.articleId) ?? null : null })),
    pending: items.filter((i) => i.status === "pending").length, published, waiting, errors, cost,
  };
}
