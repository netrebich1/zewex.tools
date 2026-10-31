/**
 * Тип статьи для выбора шаблона пина (2026-10-26). Прогон пинов делит статьи на «подборки идей»
 * (25 Fall Nail Ideas — обычные Canvas-стили) и блоговые / информационные статьи, у которых свой набор
 * шаблонов (Canvas-стили с тегом `blog`, `src/lib/pins/canvas/curated.ts`, `zxb:*`).
 *
 * Как определяется (по порядку):
 *  1. Статья сделана нашим сервисом Pin Blog Article: URL страницы совпадает с `BlogPost.wpUrl` статьи того же сайта
 *     (`BlogSite.accessId` = `PinSite.wpConnectionId`) — тип берётся из сценария статьи (`recipe.scenario.key`)
 *     и интента исследования (`brief.intent`), число пунктов — из сценария / плана (`scenario.n`, `outline.listCount`).
 *  2. Иначе — по заголовку страницы (title/H1/ключ): «How to…», «Why…», «… Checklist», «… Recipe», «X vs Y»…
 *     Заголовки-подборки («25 Fall Nail Ideas», «30 Outfits…») всегда остаются подборками.
 *  3. Ничего не подошло — подборка идей (как было до появления блоговых шаблонов).
 *
 * С 2026-10-29 тип решается ОДИН раз на этапе meta (`detectArticleKinds`) и хранится в странице прогона
 * (`PinRunPage.articleKind / kindSource / kindInfo`): статья нашего блога → анализатор страницы
 * (`articleAnalyzer.ts`, если статьи в блоге уже нет) → заголовок. Ручная отметка сотрудника и настройка
 * прогона «все статьи блоговые / все подборки» сильнее автоматики. Остальные этапы читают сохранённое.
 */
import { prisma } from "@/lib/db";
import { kindFromStructure, type PageStructure } from "./articleAnalyzer";

export const ARTICLE_KINDS = ["how_to", "tips", "checklist", "fix", "explain", "compare", "recipe", "plan"] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];
export type ArticleInfo = {
  kind: ArticleKind | null;
  count: number | null;
  source: "blog" | "title" | "none" | "analyzer" | "manual" | "run";
  /** Заголовок статьи (H1 нашей статьи или страницы) — основа заголовка пина. */
  title?: string;
  /** Короткие пункты статьи (шаги, ошибки, советы, что понадобится) — только у статей нашего блога. */
  points?: string[];
  /** Пункты по разделам статьи нашего блога (steps, mistakes, tips, what_you_need, …) и полный размер каждого раздела. */
  pointsBy?: Record<string, string[]>;
  sizes?: Record<string, number>;
};

/** Раздел статьи, который «считает» тип статьи: его размер — число на пине («7 Steps», «24 Tips»). */
export const PRIMARY_SECTION: Record<ArticleKind, string[]> = {
  how_to: ["steps"], tips: ["tips", "list_item", "list_group"], checklist: ["list_group", "list_item"], fix: ["methods"],
  explain: [], compare: [], recipe: ["steps"], plan: ["plan_table", "list_item"],
};

/**
 * Пункты и число для конкретного блогового стиля: первый раздел из `pointsFrom` стиля, где есть хотя бы 2 пункта.
 * Число — только у «считающих» стилей: размер показанного раздела, а для главного раздела типа — число статьи.
 */
export function pointsForStyle(info: ArticleInfo, style: { pointsFrom?: string[]; countable?: boolean }): { points: string[]; count: number | null; section: string | null } {
  for (const sec of style.pointsFrom ?? []) {
    const pts = info.pointsBy?.[sec] ?? [];
    if (pts.length >= 2) {
      const primary = !!info.kind && PRIMARY_SECTION[info.kind].includes(sec);
      const size = (primary ? info.count : null) ?? info.sizes?.[sec] ?? null;
      return { points: pts.slice(0, 5), count: style.countable && size && size >= 3 ? size : null, section: sec };
    }
  }
  // Пунктов нет (статья не нашего блога): число из заголовка — только «считающим» стилям.
  return { points: [], count: style.countable ? info.count : null, section: null };
}

export const ARTICLE_KIND_LABELS: Record<ArticleKind, string> = {
  how_to: "Как сделать (шаги)", tips: "Советы / список", checklist: "Чек-лист", fix: "Проблема и решение",
  explain: "Почему / что такое", compare: "Какой выбрать / сравнение", recipe: "Рецепт", plan: "План / тренировка",
};

/** Надзаголовок пина по типу статьи. Английский — по умолчанию; для ru/uk свои. */
const KICKERS: Record<"en" | "ru" | "uk", Record<ArticleKind, string>> = {
  en: { how_to: "Step-by-step guide", tips: "Tips that work", checklist: "Checklist", fix: "Quick fix", explain: "Explained", compare: "Buyer's guide", recipe: "Easy recipe", plan: "Free plan" },
  ru: { how_to: "Пошагово", tips: "Советы", checklist: "Чек-лист", fix: "Как исправить", explain: "Простыми словами", compare: "Как выбрать", recipe: "Рецепт", plan: "Готовый план" },
  uk: { how_to: "Покроково", tips: "Поради", checklist: "Чек-лист", fix: "Як виправити", explain: "Простими словами", compare: "Як обрати", recipe: "Рецепт", plan: "Готовий план" },
};
export function kindKicker(kind: ArticleKind, language: string): string {
  const l = (language || "en").toLowerCase().slice(0, 2);
  return (KICKERS[(l === "ru" || l === "uk" ? l : "en") as "en" | "ru" | "uk"])[kind];
}

/** Тег Canvas-стиля, которым стиль объявляет, к каким типам статей подходит (`k:any` — к любым блоговым). */
export const kindTag = (k: ArticleKind) => `k:${k}`;
export const BLOG_TAG = "blog";

/* ------------------------------ по заголовку ------------------------------ */

/** Слова после числа, при которых нумерованный заголовок — советы / шаги, а не подборка идей. */
const TIP_NOUNS = "tips|ways|mistakes|hacks|rules|things|reasons|signs|steps|questions|secrets|habits|tricks|facts|benefits|myths|exercises|stretches";
const NUMBERED = /^\s*(\d{1,3})\+?\s+((?:[\w'’&-]+\s+){0,4}?)([\w'’-]+)/i;
const IDEAS = /\b(ideas|inspo|inspiration)\b|идей|идеи|образ(ов|ы)/i;

const RULES: Array<[RegExp, ArticleKind]> = [
  [/\bcheck\s?-?list\b|чек-?лист/i, "checklist"],
  [/\b\d+[- ](day|week)\b|\bmeal plan\b|\b(workout|training|exercise) (plan|routine|program)\b|\bworkout for\b|\bat-home .*workout\b|план питания|план тренировок/i, "plan"],
  [/\brecipe\b|\bhow to make\b|рецепт/i, "recipe"],
  [/\bvs\.?(\s|$)|\bversus\b|^which\b|^(the )?best .* for\b|\bcompar(e|ison)\b|сравнен|какой (лучше|выбрать)|что лучше/i, "compare"],
  [/^(how to )?(get rid of|fix|stop|remove|repair|treat|prevent)\b|\bhow to (get rid of|fix|stop|remove|repair|treat|prevent|get .* off)\b|избавиться|как убрать|как исправить|что делать,? если/i, "fix"],
  [/^(why|what is|what are|what does|what causes|is it|can you|does)\b|\bexplained\b|^почему|^что такое|^зачем/i, "explain"],
  [/^how to\b|\bhow to\b|\bstep[- ]by[- ]step\b|\b(beginner'?s?|complete|ultimate) guide\b|\btutorial\b|^как |пошагов|инструкция/i, "how_to"],
];

/** Заголовок страницы без хвоста с названием сайта («… | Best For You», «… – Lyntrico»). */
function stripSiteSuffix(t: string): string {
  const parts = t.split(/\s+[|–—]\s+|\s+-\s+/);
  return parts.length > 1 && parts[0].length >= 12 ? parts[0] : t;
}

/**
 * Тип по заголовку страницы; null — подборка идей или не понятно. Смотрим H1, затем <title> без хвоста сайта, затем ключ.
 * Нумерованный заголовок («30 Easy NYE Snacks», «25 Healthy Christmas Recipes») — подборка, если за числом не идут
 * «tips / ways / steps / mistakes…» (тогда это советы с числом пунктов).
 */
export function kindFromTitle(title?: string | null, h1?: string | null, keyword?: string | null): ArticleInfo {
  const list = [h1, title ? stripSiteSuffix(title) : "", keyword].map((t) => (t ?? "").replace(/&#0?38;|&amp;/g, "&").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!list.length) return { kind: null, count: null, source: "none" };
  for (const t of list) {
    const m = NUMBERED.exec(t);
    if (m) {
      const n = Number(m[1]);
      // Первые пять слов после числа до двоеточия: «24 Clear Skin Tips…», «100 Would You Rather Questions…».
      // Подборка, если перед «советами» стоит предмет подборки («35 Blouse Outfits 2027: Ways…») или это френч-маникюр.
      const words = t.replace(/^\s*\d{1,3}\+?\s+/, "").split(":")[0].split(/\s+/).slice(0, 5).join(" ").toLowerCase();
      const roundup = /\b(outfits?|nails?|dress(es)?|hairstyles?|haircuts?|skirts?|looks?|designs?|manicures?|ponytails?|braids?|bangs|colors?|decor|rooms?|french tips)\b/.test(words);
      if ((!roundup && new RegExp(`\\b(${TIP_NOUNS})\\b`).test(words)) || /^\d+\s+(советов|способов|ошибок|правил|причин|признаков|шагов|вопросов)/i.test(t)) return { kind: "tips", count: n >= 3 ? n : null, source: "title" };
      return { kind: null, count: null, source: "none" };
    }
    if (IDEAS.test(t)) return { kind: null, count: null, source: "none" };
  }
  for (const t of list) for (const [re, kind] of RULES) if (re.test(t)) return { kind, count: null, source: "title" };
  return { kind: null, count: null, source: "none" };
}

/* ------------------------------ по нашей статье ------------------------------ */

type BlogLike = { recipe?: unknown; brief?: unknown; outline?: unknown; h1?: string | null };

/** Пункт для пина: без **разметки**, до двоеточия или первой запятой, не длиннее 6 слов. */
function shortPoint(raw: unknown): string {
  let t = String(raw ?? "").replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
  const colon = t.indexOf(":");
  if (colon > 2 && colon < 60) t = t.slice(0, colon);
  else t = t.split(/[.;,(]/)[0];
  const words = t.split(" ").filter(Boolean).slice(0, 6);
  // Обрезка по словам не должна кончаться служебным словом («…heat setting for»).
  const TAIL = new Set(["a", "an", "the", "for", "of", "to", "and", "or", "with", "in", "on", "is", "are", "your", "you", "that", "by", "from", "but"]);
  while (words.length > 2 && TAIL.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ""))) words.pop();
  return words.join(" ").replace(/[.,;:]+$/, "");
}

/** Какие разделы статьи дают пункты для пина каждого типа (по порядку предпочтения). */
const POINT_SECTIONS: Record<ArticleKind, string[]> = {
  how_to: ["steps", "methods", "what_you_need", "tips"], tips: ["tips", "list_item", "mistakes", "methods"],
  checklist: ["list_group", "list_item", "steps"], fix: ["methods", "steps", "prevention", "tips"],
  explain: ["why_it_happens", "myths", "tips", "methods"], compare: ["comparison_table", "what_you_need", "tips"],
  recipe: ["recipe_card", "steps", "what_you_need"], plan: ["plan_table", "steps", "list_item"],
};

/** Тип и число пунктов статьи Pin Blog Article по её сценарию и исследованию. */
export function kindFromBlogPost(p: BlogLike): ArticleInfo {
  const scen = ((p.recipe as { scenario?: { key?: string; n?: number | null } } | null)?.scenario) ?? {};
  const intent = String((p.brief as { intent?: string } | null)?.intent ?? "");
  const outline = (p.outline as { listCount?: number | null; sections?: Array<{ kind?: string; items?: unknown[] }> } | null) ?? {};
  const byScenario: Record<string, ArticleKind> = {
    checklist: "checklist", big_list: "tips", numbered: "tips", workout: "plan", plan: "plan", recipe: "recipe",
    how_to_video: "how_to", comparison: "compare", explainer: "explain",
  };
  const byIntent: Record<string, ArticleKind> = {
    how_to: "how_to", why: "explain", what_is: "explain", which: "compare", comparison: "compare", list: "tips", problem_fix: "fix", other: "how_to",
  };
  const kind = byScenario[scen.key ?? ""] ?? byIntent[intent] ?? "how_to";
  const sections = (outline.sections ?? []) as Array<{ kind?: string; items?: unknown[]; keyPoints?: unknown[]; heading?: string }>;
  const steps = sections.find((s) => s.kind === "steps");
  const stepList = (Array.isArray(steps?.keyPoints) ? steps!.keyPoints : Array.isArray(steps?.items) ? steps!.items : []) as unknown[];
  const raw = scen.n ?? outline.listCount ?? (kind === "how_to" && stepList.length >= 3 ? stepList.length : null);
  const count = typeof raw === "number" && raw >= 3 ? Math.floor(raw) : null;
  // Пункты для пина: из первого подходящего раздела; для списков — заголовки пунктов.
  let points: string[] = [];
  for (const k of POINT_SECTIONS[kind]) {
    const secs = sections.filter((s) => s.kind === k);
    const list = k === "list_item" || k === "list_group" ? secs.map((s) => s.heading) : (secs[0]?.keyPoints ?? []) as unknown[];
    points = list.map(shortPoint).filter((p) => p.length >= 3);
    if (points.length >= 3) break;
  }
  const pointsBy: Record<string, string[]> = {};
  const sizes: Record<string, number> = {};
  for (const s of sections) {
    if (!s.kind) continue;
    if (s.kind === "list_item" || s.kind === "list_group") {
      const h = shortPoint(s.heading);
      if (h.length >= 3) { (pointsBy[s.kind] ??= []).push(h); sizes[s.kind] = (sizes[s.kind] ?? 0) + 1; }
      continue;
    }
    if (pointsBy[s.kind]) continue;
    const kp = (Array.isArray(s.keyPoints) ? s.keyPoints : []) as unknown[];
    const list = kp.map(shortPoint).filter((x) => x.length >= 3);
    if (list.length) { pointsBy[s.kind] = list.slice(0, 6); sizes[s.kind] = kp.length; }
  }
  return { kind, count, source: "blog", title: (p.h1 ?? "").trim() || undefined, points: points.slice(0, 5), pointsBy, sizes };
}

/** Нормализованный адрес для сравнения: без протокола, www, хвостового «/», параметров и якоря. */
export function normUrl(u: string | null | undefined): string {
  return String(u ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

type PageLike = { id: string; url: string; finalUrl?: string | null; pageTitle?: string | null; h1?: string | null; keyword?: string | null; articleKind?: string | null; kindSource?: string | null; kindInfo?: unknown };

/** Режим прогона: auto — по статье; all — все статьи блоговые; none — все подборки идей. */
export type BlogMode = "auto" | "all" | "none";
export type StoredKind = { articleKind: string; kindSource: string; kindInfo: ArticleInfo | null };

const isKind = (k: unknown): k is ArticleKind => ARTICLE_KINDS.includes(k as ArticleKind);

/** Сохранённый тип страницы (или null, если ещё не определён). */
export function storedKind(p: PageLike): ArticleInfo | null {
  if (!p.articleKind) return null;
  if (p.articleKind === "ideas") return { kind: null, count: null, source: (p.kindSource as ArticleInfo["source"]) || "none" };
  const info = (p.kindInfo ?? null) as ArticleInfo | null;
  return { ...(info ?? { count: null }), kind: isKind(p.articleKind) ? p.articleKind : "how_to", source: (p.kindSource as ArticleInfo["source"]) || info?.source || "title" } as ArticleInfo;
}

async function blogPostsByUrl(wpConnectionId: string | null | undefined): Promise<Map<string, ArticleInfo>> {
  const out = new Map<string, ArticleInfo>();
  if (!wpConnectionId) return out;
  const posts = await prisma.blogPost.findMany({
    where: { site: { accessId: wpConnectionId }, wpUrl: { not: null } },
    select: { wpUrl: true, recipe: true, brief: true, outline: true, h1: true },
  }).catch(() => []);
  for (const p of posts) out.set(normUrl(p.wpUrl), kindFromBlogPost(p));
  return out;
}

/**
 * Решение типа для страниц прогона (этап meta): ручная отметка не трогается; режим прогона all/none;
 * иначе наш блог → устройство страницы → заголовок. Возвращает то, что нужно записать в PinRunPage.
 */
export async function detectArticleKinds(wpConnectionId: string | null | undefined, pages: PageLike[], structures: ReadonlyMap<string, PageStructure | undefined>, mode: BlogMode = "auto"): Promise<Map<string, StoredKind>> {
  const blog = pages.length ? await blogPostsByUrl(wpConnectionId) : new Map<string, ArticleInfo>();
  const out = new Map<string, StoredKind>();
  for (const p of pages) {
    if (p.kindSource === "manual") continue;
    const title = (p.h1 || p.pageTitle || "").trim() || undefined;
    const byTitle = kindFromTitle(p.pageTitle, p.h1, p.keyword);
    const hit = blog.get(normUrl(p.finalUrl || p.url)) ?? blog.get(normUrl(p.url));
    const st = structures.get(p.id);
    const byPage = !hit && st ? kindFromStructure(st, byTitle.kind) : null;
    let info: ArticleInfo | null = hit ?? (byPage && byPage !== "ideas" ? { ...byPage, count: byPage.count ?? byTitle.count } : byPage === "ideas" ? null : byTitle.kind ? byTitle : null);
    if (mode === "none") { out.set(p.id, { articleKind: "ideas", kindSource: "run", kindInfo: null }); continue; }
    if (mode === "all" && !info) info = { ...byTitle, kind: byTitle.kind ?? "how_to", source: "run" };
    if (!info?.kind) { out.set(p.id, { articleKind: "ideas", kindSource: byPage === "ideas" ? "analyzer" : "title", kindInfo: null }); continue; }
    const full = { ...info, title: info.title || title };
    out.set(p.id, { articleKind: info.kind, kindSource: info.source, kindInfo: full });
  }
  return out;
}

/**
 * Тип каждой страницы прогона: сначала ищем статью нашего блога по адресу (статьи сайтов, привязанных к тому же
 * доступу WordPress), потом — по заголовку. Один запрос в базу на прогон.
 */
export async function articleKindsFor(wpConnectionId: string | null | undefined, pages: PageLike[]): Promise<Map<string, ArticleInfo>> {
  const out = new Map<string, ArticleInfo>();
  // Сначала сохранённое на этапе meta; старые прогоны (до 2026-10-29) — расчёт на лету, как раньше.
  const rest: PageLike[] = [];
  for (const p of pages) { const st = storedKind(p); if (st) out.set(p.id, { ...st, title: st.title || (p.h1 || p.pageTitle || "").trim() || undefined }); else rest.push(p); }
  const blogByUrl = rest.length ? await blogPostsByUrl(wpConnectionId) : new Map<string, ArticleInfo>();
  for (const p of rest) {
    const hit = blogByUrl.get(normUrl(p.finalUrl || p.url)) ?? blogByUrl.get(normUrl(p.url));
    const info = hit ?? kindFromTitle(p.pageTitle, p.h1, p.keyword);
    out.set(p.id, { ...info, title: info.title || (p.h1 || p.pageTitle || "").trim() || undefined });
  }
  return out;
}
