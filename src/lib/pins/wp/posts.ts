/**
 * Статьи сайта по REST API WordPress для страницы «Новый прогон»:
 * доступ берётся из рецепта сайта (wpConnectionId) или привязки сайта,
 * к каждой статье добавляется флаг «уже использовалась в прогонах».
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { mergeRecipe, pagesDateWindow, type PagesSource } from "../types";
import { canAccessTeam } from "../runs/actions";
import { listAllPosts, listTaxonomies, type WpCreds, type WpPost, type WpTerm } from "./client";

export type SitePost = WpPost & { used: boolean };
export type SitePostsFilter = { categories?: number[]; excludeCategories?: boolean; after?: string; before?: string; search?: string; limit?: number; postType?: "posts" | "pages" };

async function siteCreds(me: CurrentUser, siteId: string): Promise<{ creds: WpCreds; siteId: string }> {
  const site = await prisma.pinSite.findUnique({ where: { id: siteId } });
  if (!site || !canAccessTeam(me, site.teamId)) throw new Error("Сайт не найден");
  const connId = mergeRecipe(site.recipe).publishing.wpConnectionId || site.wpConnectionId;
  if (!connId) throw new Error("У сайта нет доступа WordPress: откройте сайт в разделе «Сайты» и выберите доступ в рецепте.");
  const conn = await prisma.siteAccess.findFirst({ where: { id: connId, teamId: site.teamId } });
  if (!conn) throw new Error("Доступ WordPress не найден. Выберите другой в рецепте сайта.");
  return { creds: { baseUrl: conn.baseUrl, username: conn.username, appPassword: decryptSecret(conn.appPasswordEnc) }, siteId: site.id };
}

export async function siteTaxonomies(me: CurrentUser, siteId: string): Promise<{ categories: WpTerm[]; tags: WpTerm[] }> {
  const { creds } = await siteCreds(me, siteId);
  return listTaxonomies(creds, { timeoutMs: 30_000, maxRetries: 1 });
}

export async function sitePosts(me: CurrentUser, siteId: string, f: SitePostsFilter): Promise<{ posts: SitePost[]; total: number }> {
  const { creds } = await siteCreds(me, siteId);
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  const posts = await listAllPosts(creds, { categories: f.categories, excludeCategories: f.excludeCategories, after: f.after, before: f.before, search: f.search, postType: f.postType, limit, perPage: 100 }, { timeoutMs: 40_000, maxRetries: 1 });
  const used = new Set((await prisma.pinUrlHistory.findMany({ where: { siteId, url: { in: posts.map((p) => p.url) } }, select: { url: true } })).map((u) => u.url));
  return { posts: posts.map((p) => ({ ...p, used: used.has(p.url) })), total: posts.length };
}

/**
 * Статьи по настройке источника из рецепта («Откуда брать статьи»): используется при запуске
 * прогона, когда ссылки не вставлены руками. Период «за последние N дней» считается от сейчас.
 */
export async function sitePostsBySource(me: CurrentUser, siteId: string, p: PagesSource): Promise<{ urls: string[]; found: number; skippedUsed: number }> {
  const win = pagesDateWindow(p);
  const { posts } = await sitePosts(me, siteId, {
    categories: p.categories.length ? p.categories : undefined, excludeCategories: p.excludeCategories,
    after: win.after, before: win.before, postType: p.postType, limit: p.limit,
  });
  const fresh = p.skipUsed ? posts.filter((x) => !x.used) : posts;
  return { urls: fresh.map((x) => x.url), found: posts.length, skippedUsed: posts.length - fresh.length };
}
