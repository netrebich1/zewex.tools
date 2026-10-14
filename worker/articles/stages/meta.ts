/**
 * Этап `meta` (шаг 77 оригинала, stage77-generate-seo-meta/index.ts): H1, title, description, slug, перевод ключа
 * для модератора. Промт шага — из набора (`stage_8_meta`), иначе встроенный SEO_SYSTEM_PROMPT оригинала (в seed-данных
 * этого шага нет — аудит 03, §7.10). До 3 попыток с перечнем проблем валидатора, затем детерминированные правки
 * и запасная мета: статья НИКОГДА не остаётся без мета. Год — только из ключа; доля статей с годом в URL —
 * настройка запуска → рецепт (`run.yearInUrlPercent` → `publish.seoYearUrlPercent`).
 * Если план уже дал валидные значения (или мета уже есть) — ИИ не вызывается, только проверка и правки.
 */
import { prisma } from "@/lib/db";
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import { aiChat } from "@/lib/articles/ai";
import { SLOTS, type ArticlePlan } from "@/lib/articles/types";
import { resolvePromptOptional, fillPrompt, stageModel } from "@/lib/articles/prompts";
import { COUNT_TOKEN, hasCountToken, keepToken, renderCount } from "@/lib/articles/text/countToken";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { applySlugYear, hashPercent, keywordYear, normalizeMetaYear, slugExampleFor, slugify, slugOk, SLUG_SAFE_WORDS, stripYear, yearInSlugFor, yearPercentOf, YEAR_PATTERN } from "@/lib/articles/text/slug";
import { buildPromptVars, focusKeywordOf, loadProfile, topicOf, type JsonRecord } from "@/lib/articles/text/vars";
import type { ArtStageHandler } from "./index";
import { loadActivePhotos } from "./plan";

const STAGE_KEY = "stage_8_meta";

/** Встроенный промт оригинала (stage77:14-105). */
const SEO_SYSTEM_PROMPT = `You are a Pinterest-first editor writing the title and metadata for a visual
"ideas / designs / looks" article. Your job is to write a title a real person would save on Pinterest,
built from the meaning of the whole keyword set — NOT a slot-filled template.

WHAT A GOOD TITLE IS
- It reads like a human headline: a promise, a mood, a specific situation, an audience or a season.
- It is built from the primary keyword PLUS the semantic ideas in the related keywords, merged into
  natural language. The reader should feel "this is exactly the collection I want to save".
- It is unique in shape. Two articles on this site must never share the same skeleton.

1. KEYWORD
   - The primary keyword must be present in seo_title and h1 in recognisable form (a light grammatical
     variation is allowed) and VERBATIM in meta_description, which starts with it.
   - In seo_title the keyword must appear in the FIRST HALF of the title. Natural words may come before it
     ("Cozy Winter Work Outfits…", "Soft Glam Makeup Looks…", "25 Winter Outfits…") — you are not limited
     to a bare number.

2. YEAR
   - Use a year ONLY when the primary Keyword field contains a year, and use EXACTLY that year
     (Keyword "... 2026" -> 2026 everywhere). Never output any other year.
   - If the primary Keyword field has no year, omit years entirely from seo_title, h1, meta_description and URL.
   - If a year is provided it MUST appear in seo_title, h1 and meta_description. Its position is free.
   - Year in the URL slug: follow the "Year in slug" instruction in the user message exactly.

3. COUNT — OPTIONAL IN THE TITLE, REQUIRED IN H1
   - h1 must state how many ideas the article has, written as the literal placeholder given in the user
     message — never a digit you invent, because the number can change during moderation.
   - seo_title may include the count when it genuinely strengthens the hook, and should otherwise skip it.
     Do not open every title with a number.

4. RELATED (LSI) KEYWORDS — MEANING, NOT A LIST
   - Merge overlapping related keywords into natural phrases and semantic groups:
     "matte and glossy french tips", "layered cuts for fine hair", "wool coats over knit dresses".
   - meta_description carries 2+ such grouped ideas, h1 may carry one, the title may carry one if it reads
     naturally. Never a comma dump, never the same idea twice.

5. BANNED TITLE SHAPES (automatic rejection)
   - "<keyword> <year>: <list of keywords>" — the colon-plus-keyword-dump pattern.
   - Any title whose only content after the keyword is filler: Ideas, Looks, Inspo, Inspiration, Trends,
     Amazing, Best, Ultimate, Stunning, Gorgeous, Perfect, Must-Try, You'll Love, Top.
   - No site name, no "|", no ALL CAPS, no quotes, no emoji, no clickbait.
   - Vary separators: often none at all, sometimes an em dash, sometimes "that", "for", "to try".
     A colon is allowed at most as one option among many, never the default.

6. SEO TITLE LENGTH
   - HARD LIMIT 60 characters, aim 45-60, Title Case.
   - After/around the keyword give ONE concrete angle: audience, occasion, season, texture/material,
     body or space context, or a practical benefit. Concrete always beats vague.

7. H1
   - 40-75 characters, livelier than the title, contains keyword + year when provided + the count placeholder.
   - Must not be identical to seo_title and must not reuse its angle word for word.

8. META DESCRIPTION
   - STRICTLY 140-160 characters. Starts with the primary keyword verbatim after year normalization. Contains the count placeholder, the year when provided,
     2+ grouped related ideas, one concrete value prop and a soft CTA ("see the looks", "save your favourite").

9. URL SLUG — KEYWORD PLUS 1-3 SAFE EXTRA WORDS
   - lowercase, hyphenated, no digits except the keyword year when allowed.
   - The primary keyword (year removed) must appear in the slug AS ONE UNBROKEN BLOCK, words in the original
     order. Never insert anything between its words and never drop one of them.
   - Add 1 to 3 extra words before and/or after that block, following the "Slug shape" line in the user message.
   - The extra words may only broaden the page, never re-define the subject. ALLOWED: trendy, cute, chic, classy,
     elegant, pretty, simple, easy, modern, aesthetic, stylish, cool, fresh, bold, soft, best, top, popular,
     ideas, inspiration, inspo, designs, looks, gallery, guide, examples, picks, to-try, for-women, for-girls,
     for-her.
   - FORBIDDEN in the slug: any word that changes the subject itself — length, shape, colour, material,
     technique, body part, season, occasion or audience words that are not already in the keyword
     (e.g. keyword "white nails" must never become "short-white-nails", "white-almond-nails",
     "matte-white-nails", "white-nails-for-brides").
   - GOOD for "white nails": white-nails-ideas / trendy-white-nails / cute-white-nails-ideas /
     white-nails-for-women / best-white-nails-ideas / white-nails-inspiration.

10. STAY IN THE NICHE
   - Use the item noun you are given; never borrow nouns from another niche.

EXAMPLES (keyword "winter work outfits", year 2027, related "wool coat outfits", "knit dress work looks")
GOOD: "Winter Work Outfits 2027 for Freezing Office Mornings"
GOOD: "Wool Coat Winter Work Outfits That Survive 2027 Commutes"
GOOD: "Cozy Winter Work Outfits 2027 — Knit Dresses to Blazers"
BAD:  "Winter Work Outfits 2027: 25 Stunning Ideas"      (banned colon-dump + filler)
BAD:  "25 Winter Work Outfits 2027: Wool Coat, Knit Dress"  (keyword dump after colon)

OUTPUT FORMAT
Return ONLY valid JSON, no markdown, no commentary:
{
  "keyword_ru": "...",
  "h1": "...",
  "seo_title": "...",
  "meta_description": "...",
  "url_slug": "..."
}`;

// Формы заголовка (оригинал: stage77:207-222)
const YEAR_SHAPES = [
  "No separator at all: one flowing headline where the keyword sits early and an audience or situation closes it. No count, no colon.",
  "Open with one natural mood/season/texture word, then the keyword, then the year, then a short benefit. No colon.",
  "Open with the keyword, then an em dash and one grouped related idea; year at the end. No count.",
  "Open with the count placeholder, then the keyword and the year, then a concrete situation. No colon.",
  "Keyword first, then \"that\" or \"for\" plus a very concrete reader situation; year anywhere. No colon.",
  "Keyword plus \"to Try in <year>\", closing with one texture/occasion word. No count, no colon.",
];
const NO_YEAR_SHAPES = [
  "No separator at all: one flowing headline where the keyword sits early and an audience or situation closes it. No count, no colon, no year.",
  "Open with one natural mood/season/texture word, then the keyword, then a short benefit. No colon, no year.",
  "Open with the keyword, then an em dash and one grouped related idea. No count, no year.",
  "Open with the count placeholder, then the keyword and a concrete situation. No colon, no year.",
  "Keyword first, then \"that\" or \"for\" plus a very concrete reader situation. No colon, no year.",
  "Keyword plus \"to Try\", closing with one texture/occasion word. No count, no colon, no year.",
];

const FILLER_RE = /\b(ideas?|looks?|inspo|inspiration|trends?|amazing|best|ultimate|stunning|gorgeous|perfect|must[- ]try|top)\b/gi;
const CYRILLIC = /[Ѐ-ӿ]/;
const SMALL_WORDS = new Set(["a", "an", "and", "the", "for", "of", "to", "in", "on", "with", "or", "at", "by", "from", "vs", "that"]);

// оригинал: stage77:722-764
function detectHairNoun(keyword: string): string {
  const k = keyword.toLowerCase();
  if (/\b(color|colour|balayage|highlights|ombre|babylights|money piece|toner|brunette|blonde|copper|caramel|chocolate|honey|ash|platinum|red|burgundy|brown)\b/.test(k)) return "hair color ideas";
  if (/\b(haircut|cut|bob|lob|pixie|shag|wolf|butterfly|jellyfish|mullet|layers|layered)\b/.test(k)) return "haircuts";
  if (/\b(bangs|fringe)\b/.test(k)) return "haircuts with bangs";
  if (/\b(updo|braid|ponytail|bun|half-up|hairdo)\b/.test(k)) return "hairstyles";
  return "hairstyles";
}
function detectNailNoun(keyword: string): string {
  const k = keyword.toLowerCase();
  if (/\b(pedicure|toenails?|toes|feet)\b/.test(k)) return "pedicure ideas";
  if (/\b(nail art|design|art)\b/.test(k)) return "nail art ideas";
  if (/\b(french|chrome|ombre|gradient|glazed|milky|jelly|cat eye|aura)\b/.test(k)) return "nail looks";
  if (/\b(manicure|mani)\b/.test(k)) return "manicure ideas";
  return "nail looks";
}
function nicheNoun(nicheCode: string): string {
  if (nicheCode.includes("outfit") || nicheCode.includes("cloth") || nicheCode.includes("fashion")) return "outfit ideas";
  if (nicheCode.includes("interior") || nicheCode.includes("decor") || nicheCode.includes("home")) return "decor ideas";
  if (nicheCode.includes("tattoo")) return "tattoo designs";
  if (nicheCode.includes("makeup") || nicheCode.includes("beauty")) return "makeup looks";
  return "ideas";
}
function nicheLabelOf(nicheCode: string): string {
  if (nicheCode.includes("nail") || nicheCode.includes("manicure") || nicheCode.includes("pedicure")) return "Nails (manicures / pedicures / nail art)";
  if (nicheCode.includes("hair")) return "Hair (hairstyles / haircuts / hair color)";
  if (nicheCode.includes("outfit") || nicheCode.includes("cloth") || nicheCode.includes("fashion")) return "Outfits & fashion";
  if (nicheCode.includes("interior") || nicheCode.includes("decor") || nicheCode.includes("home")) return "Interiors & home decor";
  if (nicheCode.includes("tattoo")) return "Tattoos";
  if (nicheCode.includes("makeup") || nicheCode.includes("beauty")) return "Makeup & beauty";
  return "Visual ideas listicle";
}

/** Title Case с маленькими словами (оригинал: stage77:766-779). */
export function titleCase(s: string): string {
  const words = s.trim().split(/(\s+)/);
  let wordIdx = -1;
  return words.map((w) => {
    if (/^\s+$/.test(w)) return w;
    wordIdx++;
    if (/^\d/.test(w) || /[A-Z]{2,}/.test(w) || /\{\{/.test(w)) return w;
    const core = w.toLowerCase();
    const bare = core.replace(/[^a-z']/g, "");
    if (wordIdx > 0 && SMALL_WORDS.has(bare)) return core;
    return core.replace(/([a-z])/, (c) => c.toUpperCase());
  }).join("");
}

/** Описание: заглавная буква, откат к законченному предложению, добор мягким CTA до 140, обрезка до 160 (оригинал: 781-800). */
export function padDescription(d: string): string {
  let out = d.trim().replace(/^([a-z])/, (c) => c.toUpperCase());
  if (!/[.!?]$/.test(out)) {
    const dot = out.lastIndexOf(".");
    if (dot >= 100) out = out.slice(0, dot + 1);
    else out = `${out.replace(/[\s,;:-]+$/, "")}.`;
  }
  const tails = [" See the looks and save your favourite.", " Find the one that fits your style.", " Get the details for each look."];
  for (const t of tails) {
    if (out.length >= 140) break;
    if (out.length + t.length <= 160) out = `${out.replace(/\s+$/, "").replace(/([^.!?])$/, "$1.")}${t}`;
  }
  if (out.length > 160) {
    const cut = out.slice(0, 160);
    const dot = cut.lastIndexOf(".");
    out = (dot > 130 ? cut.slice(0, dot + 1) : cut.replace(/\s+\S*$/, "")).trim();
  }
  return out;
}

function sanitizeRussianKeyword(value: string, fallbackKeyword: string): string {
  const cleaned = value.replace(/[{}\[\]<>]/g, "").replace(/\s{2,}/g, " ").trim();
  if (!cleaned) return fallbackKeyword;
  return cleaned.length > 120 ? cleaned.slice(0, 117).trim() + "..." : cleaned;
}

type SeoMeta = { h1: string; seo_title: string; meta_description: string; url_slug: string; keyword_ru?: string };

export const meta: ArtStageHandler = async (ctx) => {
  const { article, recipe, plan } = ctx;
  const photos = await loadActivePhotos(article.id);
  const outfitCount = photos.length || article.photoCount;

  // Источник ключа — строка очереди (article.keyword), иначе seo/focus (оригинал: 174-179).
  const sourceKeywordRaw = String(article.keyword || article.seoKeyword || article.focusKeyword || "").trim();
  const TARGET_SEO_YEAR = keywordYear(sourceKeywordRaw);
  const year = TARGET_SEO_YEAR;
  const mainKeyword = normalizeMetaYear(sourceKeywordRaw || focusKeywordOf(ctx), TARGET_SEO_YEAR);
  const topic = normalizeMetaYear(topicOf(ctx) || mainKeyword, TARGET_SEO_YEAR);
  const keywordNoYear = stripYear(mainKeyword);

  const nicheCode = String(recipe.nicheCode || "").toLowerCase();
  const isNails = /nail|manicure|pedicure/.test(nicheCode);
  const isHair = nicheCode.includes("hair");
  const itemNoun = isNails ? detectNailNoun(keywordNoYear) : isHair ? detectHairNoun(keywordNoYear) : nicheNoun(nicheCode);
  const nicheLabel = nicheLabelOf(nicheCode);

  // LSI: ключи секций из плана в порядке статьи (оригинал брал outfits.seo_keyword без order — аудит 03, §7.12).
  const fromPlan = Array.isArray(plan?.secondaryKeywords) ? (plan!.secondaryKeywords as unknown[]).map(String) : (plan?.sections ?? []).map((s) => String((s.brief as JsonRecord | undefined)?.seo_keyword || ""));
  const secondaryKeywords = [...new Set(fromPlan.map((k) => k.trim()).filter(Boolean))].slice(0, 5);

  const yearPercent = yearPercentOf(recipe.run?.yearInUrlPercent, recipe.publish?.seoYearUrlPercent);
  const yearInSlug = yearInSlugFor(article.id, year, yearPercent);
  const kwSlug = slugify(keywordNoYear, 200);
  const slugExample = slugExampleFor(article.id, kwSlug);
  const shapes = year ? YEAR_SHAPES : NO_YEAR_SHAPES;
  const titleShape = shapes[hashPercent(article.id + "|shape") % shapes.length]; // оригинал: stage77:224

  /** Проверка мета по лучшим практикам. Пустой массив = всё в порядке. (оригинал: 379-489) */
  const validate = (m: SeoMeta): string[] => {
    const problems: string[] = [];
    const shown = (v: unknown) => renderCount(String(v ?? ""), outfitCount || 10);
    const title = shown(m.seo_title);
    const desc = shown(m.meta_description);
    const h1 = shown(m.h1);
    const rawH1 = String(m.h1 || "");
    if (title.length > 60) problems.push(`seo_title is ${title.length} characters — rewrite it to 60 or fewer.`);
    if (title.length < 25) problems.push(`seo_title is only ${title.length} characters — make it 45-58 characters.`);
    if (desc.length < 140) problems.push(`meta_description is ${desc.length} characters — expand it to 140-160.`);
    if (desc.length > 160) problems.push(`meta_description is ${desc.length} characters — shorten it to 160 or fewer.`);
    if (h1 && title && h1.trim().toLowerCase() === title.trim().toLowerCase()) problems.push("h1 and seo_title are identical — make the H1 longer and more descriptive.");
    if (/\|/.test(title)) problems.push("seo_title must not contain a site name or a | separator.");
    const slug = String(m.url_slug || "");
    const emittedYears = [...new Set(`${title} ${h1} ${desc} ${slug}`.match(YEAR_PATTERN) || [])];
    if (year) {
      const wrongYears = emittedYears.filter((y) => y !== TARGET_SEO_YEAR);
      if (wrongYears.length) problems.push(`Only ${TARGET_SEO_YEAR} may be used in meta tags; replace ${wrongYears.join(", ")} with ${TARGET_SEO_YEAR}.`);
    } else if (emittedYears.length) {
      problems.push("The Keyword field has no year, so omit all years from seo_title, h1, meta_description and url_slug.");
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) problems.push("url_slug must be lowercase words separated by single hyphens.");
    if (slug.split("-").filter(Boolean).length > kwSlug.split("-").length + 3) problems.push("url_slug has too many extra words — keyword block plus 1-3 extra words maximum.");
    if (kwSlug && !`-${slug}-`.includes(`-${kwSlug}-`)) {
      problems.push(`url_slug must contain "${kwSlug}" as one unbroken block — do not insert or drop words inside it.`);
    } else if (kwSlug) {
      const extras = `-${slug}-`.replace(`-${kwSlug}-`, "-").split("-").filter(Boolean).filter((w) => !(year && w === year));
      const bad = extras.filter((w) => !SLUG_SAFE_WORDS.has(w));
      if (bad.length) problems.push(`url_slug contains subject-changing words (${bad.join(", ")}) — only broadening words like trendy, cute, ideas, inspiration, for-women are allowed.`);
    }

    const kw = keywordNoYear.toLowerCase();
    const kwWords = kw.split(/\s+/).filter((w) => w.length > 2);
    const stem = (w: string) => w.replace(/(ies|es|s)$/, "");
    const wordPos = (str: string, w: string) => str.toLowerCase().indexOf(stem(w));
    const recognisable = (str: string) => kwWords.every((w) => wordPos(str, w) >= 0);
    if (kw) {
      if (!recognisable(title)) {
        problems.push(`seo_title must contain the primary keyword "${keywordNoYear}" in recognisable form.`);
      } else {
        const last = Math.max(...kwWords.map((w) => wordPos(title, w) + stem(w).length));
        if (last > Math.max(30, Math.ceil(title.length / 2) + 6)) problems.push(`In seo_title the keyword "${keywordNoYear}" must sit in the first half of the title.`);
      }
      if (!recognisable(h1)) problems.push(`h1 must contain the primary keyword "${keywordNoYear}".`);
      if (!desc.toLowerCase().startsWith(kw)) problems.push(`meta_description must start with the keyword "${keywordNoYear}" verbatim.`);
    }
    if (/:/.test(title)) {
      const head = title.split(":")[0].toLowerCase();
      if (kw && (head.includes(kw) || recognisable(head))) problems.push('seo_title uses the banned template "<keyword> <year>: <keywords>" — write one flowing human headline instead, without the colon.');
    }
    const bannedInTitle = (title.match(FILLER_RE) || []).filter((w) => !kw.includes(String(w).toLowerCase()));
    if (bannedInTitle.length) problems.push(`seo_title uses template filler (${[...new Set(bannedInTitle)].join(", ")}) — replace it with a concrete angle.`);
    if (year) {
      if (!title.includes(year)) problems.push(`seo_title must include the year ${year}.`);
      if (!h1.includes(year)) problems.push(`h1 must include the year ${year}.`);
      if (!desc.includes(year)) problems.push(`meta_description must include the year ${year}.`);
      if (yearInSlug && !slug.includes(year)) problems.push(`url_slug must end with the year ${year}.`);
      if (!yearInSlug && /\d/.test(slug)) problems.push("url_slug must contain no year and no digits at all.");
    }
    if (!hasCountToken(rawH1)) problems.push(`h1 must state the number of ideas using the literal placeholder ${COUNT_TOKEN} — never a digit.`);
    for (const [field, value] of [["h1", rawH1], ["seo_title", title], ["meta_description", desc], ["url_slug", slug]] as [string, string][]) {
      if (CYRILLIC.test(String(value || ""))) problems.push(`${field} must be written in the keyword language (English, Latin letters only) — it currently contains Russian text. Russian belongs only in keyword_ru.`);
    }
    if (secondaryKeywords.length >= 2) {
      const dl = desc.toLowerCase();
      const hits = secondaryKeywords.filter((k) => {
        const words = String(k).toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !kw.includes(w));
        return words.length > 0 && words.some((w) => dl.includes(w));
      }).length;
      if (hits < 2) problems.push(`meta_description must naturally include at least 2 of these LSI keywords: ${secondaryKeywords.join(", ")}.`);
    }
    return problems;
  };

  // Детерминированный запасной вариант (оригинал: 519-527); нишевая заглушка «for every outfit» → нейтральная.
  const yearSuffix = year ? ` ${year}` : "";
  const fallbackMeta = (): SeoMeta => ({
    h1: `${COUNT_TOKEN} ${keywordNoYear}${yearSuffix}`.replace(/\s{2,}/g, " ").trim(),
    seo_title: `${keywordNoYear}${yearSuffix}`.replace(/\s{2,}/g, " ").trim(),
    meta_description: `${COUNT_TOKEN} ${keywordNoYear}${yearSuffix} to save and copy, with practical notes on every single one.`.replace(/\s{2,}/g, " ").trim().slice(0, 158),
    url_slug: slugExample,
  });

  // 1. Уже есть валидная мета (статья или план) — ИИ не нужен.
  const existing: SeoMeta | null = article.metaTitle && article.h1 && article.slug && article.metaDescription
    ? { h1: article.h1, seo_title: article.metaTitle, meta_description: article.metaDescription, url_slug: article.slug, keyword_ru: article.keywordRu || undefined }
    : plan?.title && plan?.h1 && plan?.slug && plan?.metaDescription
      ? { h1: plan.h1, seo_title: plan.title, meta_description: plan.metaDescription, url_slug: plan.slug }
      : null;
  let seoMeta: SeoMeta | null = null;
  let usedAi = false;
  let lastProblems: string[] = [];
  let modelUsed: string | null = null;
  if (existing && validate(existing).length === 0) {
    seoMeta = { ...existing };
    ctx.log("мета из плана проходит проверку — ИИ не вызывается");
  }

  // 2. Иначе — модель, до 3 попыток с перечнем проблем (оригинал: 491-517).
  if (!seoMeta) {
    const profile = await loadProfile(ctx);
    const setPrompt = await resolvePromptOptional(recipe, STAGE_KEY);
    const metaVars: JsonRecord = {
      niche_label_seo: nicheLabel,
      source_keyword: sourceKeywordRaw,
      primary_keyword: mainKeyword,
      keyword_no_year: keywordNoYear,
      year: year || "none",
      year_policy: year ? `Keyword contains a year, so use ONLY ${TARGET_SEO_YEAR}; replace any source year with ${TARGET_SEO_YEAR}` : "Keyword has no year — omit years entirely",
      year_in_slug: year ? (yearInSlug ? `YES — the slug must end with ${year}` : "NO — the slug must contain no year and no digits at all") : "no year exists",
      kw_slug: kwSlug,
      slug_shape: slugExample,
      count_token: COUNT_TOKEN,
      item_noun: itemNoun,
      related_keywords: secondaryKeywords.join(", ") || "none",
      title_shape: titleShape,
    };
    let system = SEO_SYSTEM_PROMPT;
    let baseUser = `Niche: ${nicheLabel}
Topic: ${topic}
Source Keyword field: ${sourceKeywordRaw}
PRIMARY KEYWORD (taken from the Keyword field; must be recognisable in the title and h1, verbatim at the start of the description after year normalization): ${mainKeyword}
Primary keyword without the year: ${keywordNoYear}
Year policy: ${metaVars.year_policy}
Year (mandatory in title, h1 and description when present; position free): ${year || "none — omit year entirely"}
Year in slug: ${metaVars.year_in_slug}
Keyword block that must stay unbroken inside the slug: ${kwSlug}
Slug shape for THIS article (keep the keyword block intact; you may swap the extra words for other ALLOWED ones that fit this topic better, but never add subject-changing words): ${slugExample}
Count placeholder to write instead of the number of ideas (write it literally, never a digit): ${COUNT_TOKEN}
Item noun to use: ${itemNoun}
Related keywords from real search data (merge overlapping ones into natural phrases / semantic groups; 2+ grouped ideas in the meta description, 0-1 in h1, a short one in the title only if it reads naturally): ${secondaryKeywords.join(", ") || "none"}

Title shape for THIS article (follow it so titles across the site do not repeat one pattern): ${titleShape}

Generate h1, seo_title, meta_description and url_slug.
LANGUAGE (STRICT): h1, seo_title, meta_description and url_slug MUST be written in the same language as the PRIMARY KEYWORD (English) — plain Latin letters only, no Cyrillic characters anywhere in these four fields.
The ONLY field that may contain Russian is keyword_ru: translate the PRIMARY KEYWORD into natural Russian for a Russian-speaking moderator (it is shown in the UI only, never published). Translate meaning, not word-by-word; keep brand names unchanged; do not add extra descriptors that are not in the keyword. Never let this translation leak into the other fields.
Write the title as a Pinterest-worthy human headline built from the MEANING of the keyword set — never "<keyword> <year>: <keywords>".
Count characters before answering: seo_title <= 60 (aim 45-60), meta_description between 140 and 160, h1 between 40 and 75.
No filler words in the title ("Ideas / Looks / Best / Stunning / Must-Try / Top"), no template phrasing.`;
    if (setPrompt) {
      const vars = await buildPromptVars(ctx, { photos, profile, extra: metaVars });
      const f = fillPrompt(setPrompt, vars);
      if (f.system.trim()) system = f.system;
      if (f.user.trim()) baseUser = f.user;
    }
    const model = stageModel(recipe, STAGE_KEY);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await ctx.tick(`SEO-мета: попытка ${attempt}/3`);
      const feedback = attempt === 1 ? "" : `Your previous answer was rejected. Fix exactly these problems and return corrected JSON:\n- ${lastProblems.join("\n- ")}`;
      let raw = "";
      try {
        const r = await aiChat(ctx.ai, {
          slot: SLOTS.textMain,
          model,
          system,
          user: baseUser + (feedback ? `\n\n${feedback}` : ""),
          json: true,
          temperature: 1,
          maxTokens: 800,
          timeoutMs: 120_000,
        });
        raw = r.text;
        modelUsed = r.model;
        usedAi = true;
      } catch (e) {
        if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
        lastProblems = [`AI call failed: ${e instanceof Error ? e.message : String(e)}`];
        ctx.log(`попытка ${attempt}: вызов не удался — ${lastProblems[0]}`);
        if (e instanceof AiError && e.cls.kind === "transient") await new Promise((res) => setTimeout(res, backoffMs(attempt - 1)));
        continue;
      }
      const parsed = parseModelJsonSafe(raw) as Partial<SeoMeta> | null;
      if (!parsed || typeof parsed !== "object") { lastProblems = ["Answer was not valid JSON. Return only the JSON object."]; continue; }
      if (!parsed.h1 || !parsed.seo_title || !parsed.meta_description || !parsed.url_slug) {
        lastProblems = ["Some fields were missing. Return h1, seo_title, meta_description and url_slug."];
        continue;
      }
      const cand: SeoMeta = { h1: String(parsed.h1), seo_title: String(parsed.seo_title), meta_description: String(parsed.meta_description), url_slug: String(parsed.url_slug), keyword_ru: parsed.keyword_ru ? String(parsed.keyword_ru) : undefined };
      lastProblems = validate(cand);
      seoMeta = cand; // на случай, если и третья попытка не идеальна
      if (lastProblems.length === 0) break;
      ctx.log(`попытка ${attempt} отклонена: ${lastProblems.join(" | ")}`);
    }
  }

  if (!seoMeta) {
    ctx.log(`все попытки неудачны (${lastProblems.join(" | ")}) — детерминированная запасная мета`);
    seoMeta = existing ?? fallbackMeta();
    if (existing) ctx.log("берём черновик плана и чиним детерминированно");
  }

  // Русский текст допустим только в keyword_ru (оригинал: 536-544)
  {
    const fb = fallbackMeta();
    for (const f of ["h1", "seo_title", "meta_description", "url_slug"] as const) {
      if (CYRILLIC.test(String(seoMeta[f] || ""))) seoMeta[f] = fb[f];
    }
  }

  // Детерминированная зачистка шаблона (оригинал: 549-578)
  const deTemplate = (raw: string): string => {
    let t = String(raw || "");
    const kwLow = keywordNoYear.toLowerCase();
    t = t.replace(FILLER_RE, (w) => (kwLow.includes(String(w).toLowerCase()) ? w : ""));
    t = t.replace(/\s*:\s*/g, " — ");
    t = t.replace(/\s*&\s*(?=—|$)/g, " ")
      .replace(/\s*,\s*(?=—|$)/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/\s*—\s*$/g, "")
      .replace(/^\s*—\s*/g, "")
      .replace(/\s*—\s*—\s*/g, " — ")
      .trim();
    return t;
  };
  const titleBanned = () => {
    const t = String(seoMeta!.seo_title || "");
    const fillerLeft = (t.match(FILLER_RE) || []).filter((w) => !keywordNoYear.toLowerCase().includes(String(w).toLowerCase()));
    return fillerLeft.length > 0 || /:/.test(t);
  };
  if (titleBanned()) {
    const cleaned = deTemplate(seoMeta.seo_title);
    if (cleaned.length >= 25) seoMeta.seo_title = cleaned;
  }

  // Год — детерминированно, даже если модель подставила чужой (оригинал: 581-583)
  seoMeta.seo_title = normalizeMetaYear(seoMeta.seo_title, year);
  seoMeta.h1 = normalizeMetaYear(seoMeta.h1, year);
  seoMeta.meta_description = normalizeMetaYear(seoMeta.meta_description, year);

  // Мягкая подгонка длины; поля с меткой количества не режем (оригинал: 587-594)
  if (!hasCountToken(seoMeta.seo_title) && seoMeta.seo_title.length > 60) {
    seoMeta.seo_title = seoMeta.seo_title.slice(0, 60).replace(/[\s\-–—:,]+\S*$/, "").trim();
  }
  if (!hasCountToken(seoMeta.meta_description) && seoMeta.meta_description.length > 160) {
    const trimmed = seoMeta.meta_description.slice(0, 160);
    const lastDot = trimmed.lastIndexOf(".");
    seoMeta.meta_description = (lastDot > 120 ? trimmed.slice(0, lastDot + 1) : trimmed.replace(/\s+\S*$/, "")).trim();
  }

  // URL: ключ цельным блоком + ≤3 безопасных слова, иначе — заранее выбранная форма (оригинал: 595-612)
  seoMeta.url_slug = slugify(normalizeMetaYear(slugify(seoMeta.url_slug, 200), year), 200);
  if (kwSlug && !slugOk(seoMeta.url_slug, kwSlug, year)) {
    ctx.log(`slug «${seoMeta.url_slug}» отклонён → «${slugExample}»`);
    seoMeta.url_slug = slugExample;
  }
  seoMeta.url_slug = applySlugYear(seoMeta.url_slug, year, yearInSlug);

  // Год в заголовках обязателен (оригинал: 626-634)
  if (year) {
    if (!seoMeta.seo_title.includes(year)) {
      const withYear = `${seoMeta.seo_title.trim()} ${year}`;
      seoMeta.seo_title = withYear.length <= 60
        ? withYear
        : `${seoMeta.seo_title.slice(0, 60 - year.length - 1).replace(/[\s\-–—:,]+\S*$/, "").trim()} ${year}`;
    }
    if (!seoMeta.h1.includes(year)) seoMeta.h1 = `${seoMeta.h1.trim()} for ${year}`;
  }

  // Title Case + каноническая метка; H1 без метки — метка в начало (оригинал: 638-643)
  seoMeta.seo_title = keepToken(titleCase(seoMeta.seo_title));
  seoMeta.h1 = keepToken(titleCase(seoMeta.h1));
  if (!hasCountToken(seoMeta.h1)) seoMeta.h1 = `${COUNT_TOKEN} ${seoMeta.h1}`.trim();
  seoMeta.meta_description = keepToken(padDescription(seoMeta.meta_description));
  const keywordRu = sanitizeRussianKeyword(String(seoMeta.keyword_ru || article.keywordRu || ctx.facts.keywordRu || ""), mainKeyword);

  // Страховка direct-pipeline:1103-1123 (metaOk): без непустых полей дальше нельзя.
  const okNow = seoMeta.seo_title.trim() && seoMeta.h1.trim() && seoMeta.url_slug.trim() && seoMeta.meta_description.trim().length >= 40;
  if (!okNow) {
    ctx.log("мета после правок неполная — запасной вариант");
    seoMeta = { ...fallbackMeta(), keyword_ru: keywordRu };
    seoMeta.meta_description = keepToken(padDescription(seoMeta.meta_description));
  }

  await prisma.article.update({
    where: { id: article.id },
    data: { h1: seoMeta.h1, metaTitle: seoMeta.seo_title, metaDescription: seoMeta.meta_description, slug: seoMeta.url_slug, keywordRu },
  });
  const planNow: ArticlePlan = ctx.plan ?? { h1: seoMeta.h1, title: seoMeta.seo_title, metaDescription: seoMeta.meta_description, slug: seoMeta.url_slug };
  await ctx.save({
    plan: { ...planNow, h1: seoMeta.h1, title: seoMeta.seo_title, metaDescription: seoMeta.meta_description, slug: seoMeta.url_slug, metaYear: year || null, yearInSlug, secondaryKeywords },
    facts: { ...ctx.facts, keywordRu },
  });

  const remaining = validate(seoMeta);
  return {
    summary: `${usedAi ? "ИИ" : "Из плана"}: «${seoMeta.seo_title}» · /${seoMeta.url_slug}`,
    details: { h1: seoMeta.h1, title: seoMeta.seo_title, description: seoMeta.meta_description, slug: seoMeta.url_slug, keywordRu, year: year || null, yearInSlug, yearPercent, usedAi, model: modelUsed, remainingIssues: remaining },
  };
};
