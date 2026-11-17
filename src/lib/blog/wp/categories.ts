/**
 * Категория записи для инфо-статьи: раздел сайта (settings.categories.section, по умолчанию «Blog»; нет на сайте — создаётся)
 * → правила сайта → ИИ (слот text_fast проекта blog) → по умолчанию → первая из кэша.
 * Загрузка категорий и правила — чистые функции статей (src/lib/articles/wp/categories.ts); кэш — BlogSite.wpCategories.
 */
import { Prisma, type BlogSite } from "@prisma/client";
import { prisma } from "@/lib/db";
import { aiChat, type AiCtx } from "@/lib/blog/ai";
import { SLOTS, mergeSiteSettings } from "@/lib/blog/types";
import { cachedCategories, fetchCategories, matchCategoryRules, type CategoryResolution, type WpCategory } from "@/lib/articles/wp/categories";
import { assertPublicUrl } from "@/lib/pins/fetch";
import { normalizeBaseUrl, type WpCreds } from "@/lib/pins/wp/client";

export type { CategoryResolution, WpCategory };

export async function syncBlogCategories(siteId: string, creds: WpCreds, opts: { signal?: AbortSignal } = {}): Promise<WpCategory[]> {
  const categories = await fetchCategories(creds, opts);
  await prisma.blogSite.update({ where: { id: siteId }, data: { wpCategories: categories as unknown as Prisma.InputJsonValue } });
  return categories;
}

/** «Blog» и «Блог» — один раздел: сравнение по имени без регистра и по слагу. */
const SECTION_ALIASES: Record<string, string[]> = { blog: ["blog", "блог"], "блог": ["blog", "блог"] };
function findSection(categories: WpCategory[], section: string): WpCategory | undefined {
  const key = section.trim().toLowerCase();
  const names = SECTION_ALIASES[key] ?? [key];
  return categories.find((c) => names.includes(c.name.trim().toLowerCase())) ?? categories.find((c) => names.includes(c.slug.toLowerCase()));
}

/** POST /wp/v2/categories; «term_exists» (категорию создали параллельно) — берём существующий id из ответа. */
async function createCategory(creds: WpCreds, name: string, signal?: AbortSignal): Promise<WpCategory> {
  const url = `${normalizeBaseUrl(creds.baseUrl)}/wp-json/wp/v2/categories`;
  await assertPublicUrl(url);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.appPassword}`, "utf8").toString("base64")}`, "User-Agent": "ZewexArticles/1.0 (+https://zewex.tools)" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
  });
  const data = (await res.json().catch(() => null)) as { id?: number; name?: string; slug?: string; parent?: number; code?: string; message?: string; data?: { term_id?: number } } | null;
  if (res.ok && data?.id) return { id: data.id, name: data.name ?? name, slug: data.slug ?? "", parent: data.parent ?? 0 };
  if (data?.code === "term_exists" && data.data?.term_id) return { id: data.data.term_id, name, slug: "", parent: 0 };
  throw new Error(`WordPress не создал категорию «${name}»: HTTP ${res.status}${data?.message ? ` — ${data.message}` : ""}`);
}

/** Категория раздела: из кэша, после синхронизации или новая на сайте (кэш дополняется). */
async function sectionCategory(ctx: { site: BlogSite; creds?: () => WpCreds; signal?: AbortSignal; log?: (m: string) => void }, section: string, cached: WpCategory[]): Promise<CategoryResolution | null> {
  const hit = findSection(cached, section);
  if (hit) return { id: hit.id, name: hit.name, source: "default", detail: `раздел «${hit.name}»` };
  if (!ctx.creds) return null;
  const fresh = await syncBlogCategories(ctx.site.id, ctx.creds(), { signal: ctx.signal });
  const again = findSection(fresh, section);
  if (again) return { id: again.id, name: again.name, source: "default", detail: `раздел «${again.name}»` };
  const made = await createCategory(ctx.creds(), section, ctx.signal);
  const list = fresh.some((c) => c.id === made.id) ? fresh : [...fresh, made];
  await prisma.blogSite.update({ where: { id: ctx.site.id }, data: { wpCategories: list as unknown as Prisma.InputJsonValue } });
  ctx.log?.(`на сайте создан раздел «${made.name}» (#${made.id})`);
  return { id: made.id, name: made.name, source: "default", detail: `раздел «${made.name}» создан` };
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
  if (settings.section) {
    // Ошибка здесь — повтор публикации (временный сбой), а не запись в чужую категорию.
    const s = await sectionCategory(ctx, settings.section, categories);
    if (s) return s;
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
