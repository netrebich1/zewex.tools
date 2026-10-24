/**
 * Категория записи на сайте: правила сайта (бесплатно) → ИИ (слот text_fast) → категория по умолчанию → первая из кэша.
 * Порт supabase/functions/_shared/wpCategories.ts, resolve-wp-category/index.ts, sync-wp-categories/index.ts.
 *
 * Кэш категорий — ArtSite.wpCategories ([{id, name, slug, parent}]); правила и настройки —
 * ArtSite.settings.categories ({defaultId, rules: [{pattern, categoryId}], useAi}).
 */
import { Prisma, type ArtSite } from "@prisma/client";
import { prisma } from "@/lib/db";
import { aiChat, type AiCtx } from "@/lib/articles/ai";
import { SLOTS, mergeSiteSettings } from "@/lib/articles/types";
import { assertPublicUrl } from "@/lib/pins/fetch";
import { normalizeBaseUrl, type WpCreds } from "@/lib/pins/wp/client";
import { updatePost } from "./posts";

export type WpCategory = { id: number; name: string; slug: string; parent: number };

export type CategoryResolution = {
  id: number | null;
  name: string | null;
  source: "rule" | "ai" | "default" | "first" | "none";
  detail?: string;
};

/** Одна страница категорий — 100 штук, не больше 20 страниц (оригинал wpCategories.ts:40-41). */
const PER_PAGE = 100;
const MAX_PAGES = 20;
const PAGE_TIMEOUT_MS = 15_000; // оригинал :46
/** ИИ видит не больше 200 категорий (оригинал :131). */
const AI_LIST_LIMIT = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Кэш из JSON-поля сайта с проверкой формы. */
export function cachedCategories(raw: unknown): WpCategory[] {
  if (!Array.isArray(raw)) return [];
  const out: WpCategory[] = [];
  for (const c of raw) {
    if (!isRecord(c)) continue;
    const id = Number(c.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    out.push({ id, name: String(c.name ?? ""), slug: String(c.slug ?? ""), parent: Number(c.parent ?? 0) || 0 });
  }
  return out;
}

/**
 * Все категории сайта по REST, постранично: GET /wp/v2/categories?per_page=100&page=N&_fields=id,name,slug,parent
 * (оригинал fetchWpCategories :29-62). 400 на странице > 1 означает «страниц больше нет».
 */
export async function fetchCategories(creds: WpCreds, opts: { signal?: AbortSignal } = {}): Promise<WpCategory[]> {
  const base = `${normalizeBaseUrl(creds.baseUrl)}/wp-json/wp/v2/categories`;
  await assertPublicUrl(base);
  const auth = `Basic ${Buffer.from(`${creds.username}:${creds.appPassword}`, "utf8").toString("base64")}`;
  const all: WpCategory[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("timeout")), PAGE_TIMEOUT_MS);
    const onOuter = () => ac.abort(opts.signal?.reason ?? new Error("aborted"));
    opts.signal?.addEventListener("abort", onOuter, { once: true });
    let res: Response;
    try {
      res = await fetch(`${base}?per_page=${PER_PAGE}&page=${page}&_fields=id,name,slug,parent&hide_empty=false`, {
        headers: { Accept: "application/json", Authorization: auth, "User-Agent": "ZewexArticles/1.0 (+https://zewex.tools)" },
        signal: ac.signal,
      });
    } catch (e) {
      throw new Error(`Категории WordPress: ${e instanceof Error && e.message === "timeout" ? `нет ответа за ${PAGE_TIMEOUT_MS / 1000} с` : e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuter);
    }
    if (res.status === 400 && page > 1) break;
    if (!res.ok) throw new Error(`Категории WordPress: HTTP ${res.status}`);
    const batch: unknown = await res.json().catch(() => null);
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...cachedCategories(batch));
    if (batch.length < PER_PAGE) break;
  }
  return all;
}

/** Синхронизировать категории сайта в кэш ArtSite.wpCategories (оригинал sync-wp-categories). */
export async function syncCategories(siteId: string, creds: WpCreds, opts: { signal?: AbortSignal } = {}): Promise<WpCategory[]> {
  const categories = await fetchCategories(creds, opts);
  await prisma.artSite.update({ where: { id: siteId }, data: { wpCategories: categories as unknown as Prisma.InputJsonValue } });
  return categories;
}

export type CategoryRule = { pattern: string; categoryId: number };

/**
 * Правила сайта: первое совпадение по подстрокам (через запятую / точку с запятой / перенос строки) в ключе и заголовке
 * (оригинал matchCategoryRules :65-82).
 */
export function matchCategoryRules(rules: CategoryRule[], text: string): { id: number; rule: string } | null {
  const hay = text.toLowerCase();
  for (const rule of rules ?? []) {
    const words = String(rule?.pattern ?? "")
      .split(/[,\n;]+/)
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    const id = Number(rule?.categoryId);
    if (!words.length || !Number.isFinite(id) || id <= 0) continue;
    if (words.some((w) => hay.includes(w))) return { id, rule: words.join(", ") };
  }
  return null;
}

export type ResolveCategoryCtx = {
  site: ArtSite;
  ai: AiCtx;
  /** Доступ WordPress (для дозаполнения пустого кэша); бросает, если доступа нет */
  creds?: () => WpCreds;
  signal?: AbortSignal;
  log?: (msg: string) => void;
};

/**
 * Категория для статьи (оригинал resolveCategory :101-180). Ключ — keyword/focusKeyword статьи, заголовок — h1 или title.
 * Пустой кэш категорий дозаполняется с сайта; ИИ зовётся только если правила не сработали и включён useAi.
 * Ошибки ИИ и сети не фатальны — статья уйдёт с категорией по умолчанию (WordPress сам поставит свою, если категории нет).
 */
export async function resolveCategory(ctx: ResolveCategoryCtx, opts: { keyword: string; title?: string | null }): Promise<CategoryResolution> {
  const settings = mergeSiteSettings(ctx.site.settings).categories;
  let categories = cachedCategories(ctx.site.wpCategories);

  if (!categories.length && ctx.creds) {
    try {
      categories = await syncCategories(ctx.site.id, ctx.creds(), { signal: ctx.signal });
      ctx.site.wpCategories = categories as unknown as Prisma.JsonValue;
      ctx.log?.(`категории синхронизированы: ${categories.length}`);
    } catch (e) {
      ctx.log?.(`категории не синхронизированы: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const text = `${opts.keyword ?? ""} ${opts.title ?? ""}`.trim();
  const byRule = matchCategoryRules(settings.rules, text);
  if (byRule) {
    const known = categories.find((c) => c.id === byRule.id);
    return { id: byRule.id, name: known?.name ?? null, source: "rule", detail: `правило: ${byRule.rule}` };
  }

  if (settings.useAi && categories.length && text) {
    try {
      const list = categories.slice(0, AI_LIST_LIMIT).map((c) => `${c.id}: ${c.name}`).join("\n");
      // оригинал :134-154: gemini-2.5-flash-lite через OpenRouter, temperature 0, maxTokens 40, 20 с; у нас — модель правила слота text_fast
      const r = await aiChat(ctx.ai, {
        slot: SLOTS.textFast,
        system:
          `You assign one WordPress category to an article.\n` +
          `Pick exactly ONE category id from the list. Never invent ids or names.\n` +
          `If nothing fits, return {"id":null}.\n` +
          `Return ONLY JSON: {"id":<number|null>}`,
        user: `Article keyword: "${opts.keyword}"${opts.title ? `\nTitle: "${opts.title}"` : ""}\n\nCategories:\n${list}`,
        json: true,
        temperature: 0,
        maxTokens: 40,
        timeoutMs: 20_000,
      });
      const parsed = isRecord(r.json) ? r.json : {};
      const id = Number(parsed.id);
      const hit = categories.find((c) => c.id === id);
      if (hit) return { id: hit.id, name: hit.name, source: "ai", detail: "подобрано ИИ" };
    } catch (e) {
      ctx.log?.(`ИИ не подобрал категорию: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const def = Number(settings.defaultId) || null;
  if (def) {
    const known = categories.find((c) => c.id === def);
    return { id: def, name: known?.name ?? null, source: "default", detail: "категория по умолчанию" };
  }
  // Ни правила, ни ИИ, ни категории по умолчанию: первая из кэша (обычно «Uncategorized»); пустой кэш — без категории,
  // WordPress поставит свою категорию по умолчанию сам.
  if (categories.length) {
    const first = categories.find((c) => c.slug === "uncategorized") ?? categories[0];
    return { id: first.id, name: first.name, source: "first", detail: "первая категория сайта" };
  }
  return { id: null, name: null, source: "none" };
}

/** Проставить категорию уже созданной записи (оригинал resolve-wp-category apply_to_wp :57-74). */
export async function applyCategoryToPost(creds: WpCreds, postId: number, categoryId: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
  await updatePost(creds, postId, { categories: [categoryId] }, { signal: opts.signal });
}
