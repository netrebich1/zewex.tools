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
 */
import { prisma } from "@/lib/db";

export const ARTICLE_KINDS = ["how_to", "tips", "checklist", "fix", "explain", "compare", "recipe", "plan"] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];
export type ArticleInfo = { kind: ArticleKind | null; count: number | null; source: "blog" | "title" | "none" };

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

type BlogLike = { recipe?: unknown; brief?: unknown; outline?: unknown };

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
  const steps = (outline.sections ?? []).find((s) => s.kind === "steps");
  const stepCount = Array.isArray(steps?.items) ? steps!.items!.length : 0;
  const raw = scen.n ?? outline.listCount ?? (kind === "how_to" && stepCount ? stepCount : null);
  const count = typeof raw === "number" && raw >= 3 ? Math.floor(raw) : null;
  return { kind, count, source: "blog" };
}

/** Нормализованный адрес для сравнения: без протокола, www, хвостового «/», параметров и якоря. */
export function normUrl(u: string | null | undefined): string {
  return String(u ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

type PageLike = { id: string; url: string; finalUrl?: string | null; pageTitle?: string | null; h1?: string | null; keyword?: string | null };

/**
 * Тип каждой страницы прогона: сначала ищем статью нашего блога по адресу (статьи сайтов, привязанных к тому же
 * доступу WordPress), потом — по заголовку. Один запрос в базу на прогон.
 */
export async function articleKindsFor(wpConnectionId: string | null | undefined, pages: PageLike[]): Promise<Map<string, ArticleInfo>> {
  const out = new Map<string, ArticleInfo>();
  const blogByUrl = new Map<string, ArticleInfo>();
  if (wpConnectionId && pages.length) {
    const posts = await prisma.blogPost.findMany({
      where: { site: { accessId: wpConnectionId }, wpUrl: { not: null } },
      select: { wpUrl: true, recipe: true, brief: true, outline: true },
    }).catch(() => []);
    for (const p of posts) blogByUrl.set(normUrl(p.wpUrl), kindFromBlogPost(p));
  }
  for (const p of pages) {
    const hit = blogByUrl.get(normUrl(p.finalUrl || p.url)) ?? blogByUrl.get(normUrl(p.url));
    out.set(p.id, hit ?? kindFromTitle(p.pageTitle, p.h1, p.keyword));
  }
  return out;
}
