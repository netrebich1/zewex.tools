/**
 * Кто видит какой сайт и статью в сервисе «Статьи». Тот же механизм, что у Пинов:
 * сайт сервиса (ArtSite) наследует видимость своего доступа WordPress (SiteAccess); сайт без доступа — по команде.
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { canAccessSiteAccess, visibleAccessIds } from "@/lib/sites/access";

export async function artSiteWhere(me: CurrentUser): Promise<Prisma.ArtSiteWhereInput> {
  const ids = await visibleAccessIds(me);
  if (ids === null) return {};
  return { OR: [{ accessId: { in: ids } }, { accessId: null, teamId: { in: me.teamIds } }] };
}

export async function articleWhere(me: CurrentUser): Promise<Prisma.ArticleWhereInput> {
  const ids = await visibleAccessIds(me);
  if (ids === null) return {};
  return { site: { OR: [{ accessId: { in: ids } }, { accessId: null, teamId: { in: me.teamIds } }] } };
}

export async function canAccessArtSite(me: CurrentUser, site: { teamId: string; accessId: string | null }): Promise<boolean> {
  if (me.role === "ADMIN") return true;
  if (site.accessId && (await canAccessSiteAccess(me, site.accessId))) return true;
  return !site.accessId && me.teamIds.includes(site.teamId);
}

export async function canAccessArticle(me: CurrentUser, articleId: string): Promise<boolean> {
  if (me.role === "ADMIN") return true;
  const a = await prisma.article.findUnique({ where: { id: articleId }, select: { site: { select: { teamId: true, accessId: true } } } });
  return !!a && (await canAccessArtSite(me, a.site));
}

/** Сайт сервиса с проверкой доступа; null — нет сайта или нет прав. */
export async function loadArtSite(me: CurrentUser, siteId: string) {
  const site = await prisma.artSite.findUnique({ where: { id: siteId }, include: { access: { select: { id: true, name: true, baseUrl: true, username: true, lastCheckOk: true } }, defaultRecipe: { select: { id: true, name: true, format: true, nicheCode: true } } } });
  if (!site || !(await canAccessArtSite(me, site))) return null;
  return site;
}
