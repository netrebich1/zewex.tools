import { prisma } from "@/lib/db";

/** Что уйдёт вместе с сайтом и что мешает удалить его прямо сейчас — для страницы сайта и для самого удаления. */
export async function siteDeletionImpact(accessId: string) {
  const [pinSites, artSites] = await Promise.all([
    prisma.pinSite.findMany({ where: { wpConnectionId: accessId }, select: { id: true } }),
    prisma.artSite.findMany({ where: { accessId }, select: { id: true } }),
  ]);
  const pinSiteIds = pinSites.map((s) => s.id);
  const artSiteIds = artSites.map((s) => s.id);
  const [pinRuns, pins, activePinRuns, articles, activeArticles] = await Promise.all([
    prisma.pinRun.findMany({ where: { siteId: { in: pinSiteIds } }, select: { id: true } }),
    prisma.pinRunItem.count({ where: { run: { siteId: { in: pinSiteIds } } } }),
    prisma.pinRun.count({ where: { siteId: { in: pinSiteIds }, status: { in: ["QUEUED", "RUNNING"] } } }),
    prisma.article.findMany({ where: { siteId: { in: artSiteIds } }, select: { id: true } }),
    prisma.article.count({ where: { siteId: { in: artSiteIds }, status: { in: ["RUNNING", "PUBLISHING"] } } }),
  ]);
  return { pinSiteIds, artSiteIds, pinRunIds: pinRuns.map((r) => r.id), pins, activePinRuns, articleIds: articles.map((x) => x.id), activeArticles };
}
