/**
 * Кто видит какой сайт и пост в сервисе инфо-статей. Тот же механизм, что у Пинов и Статей:
 * сайт сервиса (BlogSite) наследует видимость своего доступа WordPress (SiteAccess); сайт без доступа — по команде.
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { canAccessSiteAccess, visibleAccessIds } from "@/lib/sites/access";

export async function blogSiteWhere(me: CurrentUser): Promise<Prisma.BlogSiteWhereInput> {
  const ids = await visibleAccessIds(me);
  if (ids === null) return {};
  return { OR: [{ accessId: { in: ids } }, { accessId: null, teamId: { in: me.teamIds } }] };
}

export async function blogPostWhere(me: CurrentUser): Promise<Prisma.BlogPostWhereInput> {
  const ids = await visibleAccessIds(me);
  if (ids === null) return {};
  return { site: { OR: [{ accessId: { in: ids } }, { accessId: null, teamId: { in: me.teamIds } }] } };
}

export async function canAccessBlogSite(me: CurrentUser, site: { teamId: string; accessId: string | null }): Promise<boolean> {
  if (me.role === "ADMIN") return true;
  if (site.accessId && (await canAccessSiteAccess(me, site.accessId))) return true;
  return !site.accessId && me.teamIds.includes(site.teamId);
}

export async function canAccessBlogPost(me: CurrentUser, postId: string): Promise<boolean> {
  if (me.role === "ADMIN") return true;
  const p = await prisma.blogPost.findUnique({ where: { id: postId }, select: { site: { select: { teamId: true, accessId: true } } } });
  return !!p && (await canAccessBlogSite(me, p.site));
}

/** Сайт сервиса с проверкой доступа; null — нет сайта или нет прав. */
export async function loadBlogSite(me: CurrentUser, siteId: string) {
  const site = await prisma.blogSite.findUnique({ where: { id: siteId }, include: { access: { select: { id: true, name: true, baseUrl: true, username: true, lastCheckOk: true, appPasswordEnc: true } }, defaultRecipe: { select: { id: true, name: true } } } });
  if (!site || !(await canAccessBlogSite(me, site))) return null;
  return site;
}
