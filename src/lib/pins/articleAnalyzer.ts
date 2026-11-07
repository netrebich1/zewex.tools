/**
 * Анализатор страницы для типа статьи (2026-10-29): когда статьи нет в нашем Pin Blog Article (её удалили или
 * сделали не у нас), тип и пункты берутся из устройства самой страницы. Чистые функции над HTML, без сети.
 *
 * Признаки:
 *  - подборка идей: много пронумерованных H2 и почти у каждого своё фото («1. Burgundy Chrome Nails» + фото);
 *  - разметка schema.org Recipe / HowTo — рецепт / пошаговая инструкция;
 *  - названия разделов: «Step 1…», «What You'll Need», «Common Mistakes», «Why It Happens», «X vs Y», «Checklist»…
 * Пункты для пина — из разделов статьи теми же ключами, что у нашего блога (steps, tips, mistakes, what_you_need,
 * methods, why_it_happens, prevention, list_item), чтобы шаблоны брали их одинаково.
 */

import type { ArticleInfo, ArticleKind } from "./articleKind";

export type PageSection = { heading: string; numbered: boolean; hasImage: boolean; sub: string[]; items: string[] };
export type PageStructure = { sections: PageSection[]; schema: string[] };

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;|&#8217;/g, "'").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

/** Тело статьи: <article> / .entry-content, иначе <body>; без скриптов, меню, шапки, подвала и сайдбара. */
function bodyOf(raw: string): string {
  let h = raw.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ");
  const art = h.match(/<article\b[\s\S]*<\/article>/i)?.[0] ?? h.match(/<div[^>]+class=["'][^"']*(entry-content|post-content|article-content)[^"']*["'][\s\S]*/i)?.[0];
  if (art) h = art;
  return h.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
}

/** Устройство страницы: разделы по H2 (подзаголовки H3, пункты списков, есть ли фото) и типы schema.org. */
export function analyzeHtml(raw: string): PageStructure {
  const schema = [...raw.matchAll(/"@type"\s*:\s*(\[[^\]]*\]|"[^"]+")/g)]
    .flatMap((m) => m[1].replace(/[[\]"]/g, "").split(","))
    .map((t) => t.trim()).filter(Boolean);
  const body = bodyOf(raw);
  const parts = body.split(/<h2\b[^>]*>/i).slice(1);
  const sections: PageSection[] = [];
  for (const part of parts.slice(0, 80)) {
    const end = part.search(/<\/h2>/i);
    if (end < 0) continue;
    const heading = strip(part.slice(0, end)).slice(0, 160);
    if (!heading) continue;
    const rest = part.slice(end);
    const sub = [...rest.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)].map((m) => strip(m[1])).filter(Boolean).slice(0, 20);
    const items = [...rest.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => strip(m[1])).filter((t) => t.length >= 3 && t.length <= 300).slice(0, 20);
    sections.push({ heading, numbered: /^\s*(#?\d{1,3}[.):]|\d{1,3}\s+[-–—])/.test(heading), hasImage: /<img\b/i.test(rest), sub, items });
  }
  return { sections, schema: [...new Set(schema)] };
}

/* ------------------------------ решение ------------------------------ */

/** Раздел статьи → ключ пунктов (как у нашего блога). */
const SECTION_KEYS: Array<[RegExp, string]> = [
  [/what you('|’)?ll need|you will need|supplies|materials|tools( needed)?|ingredients|equipment/i, "what_you_need"],
  [/mistakes?|what not to do|avoid/i, "mistakes"],
  [/^why\b|causes?|reasons?|what causes/i, "why_it_happens"],
  [/prevent/i, "prevention"],
  [/\bstep(s|-by-step)?\b|instructions|how to\b|method|process/i, "steps"],
  [/ways|solutions?|fixes|remedies|options/i, "methods"],
  [/tips|tricks|hacks|rules|dos and don/i, "tips"],
];

/** Названия разделов, по которым видно тип статьи. */
const KIND_SIGNS: Array<[RegExp, ArticleKind]> = [
  [/^step\s*\d|\bstep\s*\d+\b|step-by-step|what you('|’)?ll need|supplies|instructions/i, "how_to"],
  [/how to (fix|get rid|stop|remove|prevent|treat)|solutions?|fixes|remed(y|ies)|treatment/i, "fix"],
  [/^why\b|what (is|are|causes)|how does .* work|the science|explained/i, "explain"],
  [/\bvs\.?\b|comparison|which (one|is better|to choose)|pros and cons|best for\b/i, "compare"],
  [/check\s?-?list/i, "checklist"],
  [/^(day|week)\s*\d|meal plan|workout plan|weekly plan|schedule/i, "plan"],
  [/ingredients|nutrition|prep time|cook time/i, "recipe"],
  [/mistakes|\btips\b|hacks|rules|dos and don/i, "tips"],
];

const ROUNDUP_HEADINGS = 5;

/** Пункт для пина: без номера, до двоеточия, не длиннее 6 слов. */
function shortItem(t: string): string {
  let s = t.replace(/^\s*(#?\d{1,3}[.):]|\d{1,3}\s+[-–—]|step\s*\d+[.:)\s-]*)\s*/i, "").trim();
  const colon = s.indexOf(":");
  if (colon > 2 && colon < 60) s = s.slice(0, colon);
  else s = s.split(/[.;(]/)[0];
  const words = s.split(/\s+/).filter(Boolean).slice(0, 6);
  // Обрезка по словам не должна кончаться служебным словом («…damp hair for»).
  while (words.length > 2 && TAIL.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ""))) words.pop();
  return words.join(" ").replace(/[.,;:]+$/, "");
}
const TAIL = new Set(["a", "an", "the", "for", "of", "to", "and", "or", "with", "in", "on", "is", "are", "your", "you", "that", "by", "from", "but", "into", "at"]);

/**
 * Тип статьи по устройству страницы. "ideas" — точно подборка; null — не понятно (решает заголовок);
 * иначе ArticleInfo с пунктами. `titleKind` — тип по заголовку: при совпадении с признаками раздела он побеждает.
 */
export function kindFromStructure(s: PageStructure, titleKind: ArticleKind | null): ArticleInfo | "ideas" | null {
  const secs = s.sections;
  const numbered = secs.filter((x) => x.numbered);
  const numberedWithImg = numbered.filter((x) => x.hasImage).length;
  // Подборка: «1. …» + фото у большинства пронумерованных разделов, и в названиях нет шагов/советов.
  const roundup = numbered.length >= ROUNDUP_HEADINGS && numberedWithImg >= numbered.length * 0.6 && !secs.some((x) => /^step\s*\d/i.test(x.heading.replace(/^\s*\d+[.):]\s*/, "")));

  const score = new Map<ArticleKind, number>();
  const bump = (k: ArticleKind, n = 1) => score.set(k, (score.get(k) ?? 0) + n);
  if (s.schema.includes("Recipe")) bump("recipe", 3);
  if (s.schema.includes("HowTo")) bump("how_to", 3);
  for (const sec of secs) for (const [re, k] of KIND_SIGNS) if (re.test(sec.heading) || sec.sub.some((h) => re.test(h))) bump(k);
  // Подборка без номеров: почти каждый раздел — фото с подписью («Very Short Pink Pixie Cut» + фото).
  const gallery = secs.length >= 8 && secs.filter((x) => x.hasImage).length >= secs.length * 0.7;
  if ((roundup || gallery) && !score.get("recipe") && !score.get("how_to")) return "ideas";

  let kind: ArticleKind | null = null;
  if (titleKind && (score.get(titleKind) ?? 0) >= 1) kind = titleKind;
  else {
    const best = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) kind = best[0];
  }
  // Пронумерованный список без фото у пунктов («1. Exfoliate Dead Skin Cells…») — статья-список советов / пользы.
  if (!kind && numbered.length >= 5 && !roundup) kind = "tips";
  if (!kind) return roundup || gallery ? "ideas" : null;

  // Пункты по разделам: подзаголовки H3, если их ≥ 2, иначе пункты списков.
  const pointsBy: Record<string, string[]> = {};
  const sizes: Record<string, number> = {};
  for (const sec of secs) {
    const key = SECTION_KEYS.find(([re]) => re.test(sec.heading))?.[1];
    if (!key || pointsBy[key]) continue;
    const src = sec.sub.length >= 2 ? sec.sub : sec.items;
    const list = src.map(shortItem).filter((x) => x.length >= 3);
    if (list.length >= 2) { pointsBy[key] = list.slice(0, 6); sizes[key] = src.length; }
  }
  // «Step 1 / Step 2» прямо в H2 — шаги статьи.
  const stepHeads = secs.filter((x) => /^(\d+[.):]\s*)?step\s*\d/i.test(x.heading));
  if (stepHeads.length >= 2) { pointsBy.steps = stepHeads.map((x) => shortItem(x.heading)).filter((x) => x.length >= 3).slice(0, 6); sizes.steps = stepHeads.length; }
  // Пронумерованные разделы советов — пункты списка.
  if (numbered.length >= 3 && !pointsBy.list_item) { pointsBy.list_item = numbered.map((x) => shortItem(x.heading)).filter((x) => x.length >= 3).slice(0, 6); sizes.list_item = numbered.length; }

  const primary: Record<ArticleKind, string[]> = {
    how_to: ["steps"], tips: ["tips", "list_item"], checklist: ["list_item", "what_you_need"], fix: ["methods", "steps"],
    explain: ["why_it_happens"], compare: ["list_item"], recipe: ["steps"], plan: ["list_item", "steps"],
  };
  const main = primary[kind].find((k) => sizes[k]);
  const count = main && sizes[main] >= 3 ? sizes[main] : null;
  const points = main ? pointsBy[main] : Object.values(pointsBy)[0] ?? [];
  return { kind, count, source: "analyzer", points: points.slice(0, 5), pointsBy, sizes };
}
