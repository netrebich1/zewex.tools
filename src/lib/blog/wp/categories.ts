/**
 * Категория записи для инфо-статьи: правила сайта → ИИ (слот text_fast проекта blog) → по умолчанию → первая из кэша.
 * Загрузка категорий и правила — чистые функции статей (src/lib/articles/wp/categories.ts); кэш — BlogSite.wpCategories.
 */
import { Prisma, type BlogSite } from "@prisma/client";
import { prisma } from "@/lib/db";
import { aiChat, type AiCtx } from "@/lib/blog/ai";
import { SLOTS, mergeSiteSettings } from "@/lib/blog/types";
import { cachedCategories, fetchCategories, matchCategoryRules, type CategoryResolution, type WpCategory } from "@/lib/articles/wp/categories";
import type { WpCreds } from "@/lib/pins/wp/client";

export type { CategoryResolution, WpCategory };

export async function syncBlogCategories(siteId: string, creds: WpCreds, opts: { signal?: AbortSignal } = {}): Promise<WpCategory[]> {
  const categories = await fetchCategories(creds, opts);
  await prisma.blogSite.update({ where: { id: siteId }, data: { wpCategories: categories as unknown as Prisma.InputJsonValue } });
  return categories;
}

export async function resolveBlogCategory(ctx: { site: BlogSite; ai: AiCtx; creds?: () => WpCreds; signal?: AbortSignal; log?: (m: string) => void }, opts: { keyword: string; title?: string | null }): Promise<CategoryResolution> {
  const settings = mergeSiteSettings(ctx.site.settings).categories;
  let categories = cachedCategories(ctx.site.wpCategories);
  if (!categories.length && ctx.creds) {
    try {
      categories = await syncBlogCategories(ctx.site.id, ctx.creds(), { signal: ctx.signal });
      ctx.log?.(`категории синхронизированы: ${categories.length}`);
    } catch (e) {
      ctx.log?.(`категории не синхронизированы: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const text = `${opts.keyword ?? ""} ${opts.title ?? ""}`.trim();
  const byRule = matchCategoryRules(settings.rules, text);
  if (byRule) return { id: byRule.id, name: categories.find((c) => c.id === byRule.id)?.name ?? null, source: "rule", detail: `правило: ${byRule.rule}` };
  if (settings.useAi && categories.length && text) {
    try {
      const list = categories.slice(0, 200).map((c) => `${c.id}: ${c.name}`).join("\n");
      const r = await aiChat(ctx.ai, {
        slot: SLOTS.textFast,
        system: `You assign one WordPress category to an article.\nPick exactly ONE category id from the list. Never invent ids or names.\nIf nothing fits, return {"id":null}.\nReturn ONLY JSON: {"id":<number|null>}`,
        user: `Article keyword: "${opts.keyword}"${opts.title ? `\nTitle: "${opts.title}"` : ""}\n\nCategories:\n${list}`,
        json: true, temperature: 0, maxTokens: 40, timeoutMs: 20_000,
      });
      const parsed = (r.json && typeof r.json === "object" ? r.json : {}) as { id?: unknown };
      const id = Number(parsed.id);
      const hit = categories.find((c) => c.id === id);
      if (hit) return { id: hit.id, name: hit.name, source: "ai", detail: "подобрано ИИ" };
    } catch (e) {
      ctx.log?.(`ИИ не подобрал категорию: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const def = Number(settings.defaultId) || null;
  if (def) return { id: def, name: categories.find((c) => c.id === def)?.name ?? null, source: "default", detail: "категория по умолчанию" };
  if (categories.length) {
    const first = categories.find((c) => c.slug === "uncategorized") ?? categories[0];
    return { id: first.id, name: first.name, source: "first", detail: "первая категория сайта" };
  }
  return { id: null, name: null, source: "none" };
}
