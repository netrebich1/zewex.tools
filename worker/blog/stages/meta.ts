/**
 * Этап `meta`: title ≤60 (≥35), description 120–160, H1 с ключом, slug из ключа (год по политике запуска, как у статей).
 * Сначала мета из плана; если не проходит проверку — одна починка ИИ (text_fast) с перечнем проблем; затем детерминированные
 * правки и запасной вариант: пост никогда не остаётся без меты. Без {{COUNT}} и прочих листикл-правил.
 */
import { prisma } from "@/lib/db";
import { AiError } from "@/lib/pins/ai/errors";
import { aiChat } from "@/lib/blog/ai";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { applySlugYear, contextSlug, keywordYear, normalizeMetaYear, slugify, stripYear, yearInSlugFor, yearPercentOf } from "@/lib/articles/text/slug";
import { fixDashesText, polishHeading, toUsSpellingText, usesUsSpelling } from "@/lib/articles/text/polish";
import { stageModel } from "@/lib/blog/prompts";
import { countListItems, fixLeadingNumber, LIST_STRUCTURES } from "@/lib/blog/structure";
import { SLOTS } from "@/lib/blog/types";
import type { StageHandler } from "./index";

type Meta = { h1: string; title: string; description: string; slug: string };

const SMALL = new Set(["a", "an", "and", "the", "for", "of", "to", "in", "on", "with", "or", "at", "by", "from", "vs", "that", "off", "up"]);
/** Title Case: маленькие слова строчными, кроме первого слова и слова после двоеточия; части через дефис — с заглавной, кроме маленьких слов в середине («Step-by-Step»). */
export function titleCase(s: string): string {
  let i = -1;
  let afterColon = false;
  const cap = (part: string) => part.replace(/([a-z])/, (c) => c.toUpperCase());
  return s.trim().split(/(\s+)/).map((w) => {
    if (/^\s+$/.test(w)) return w;
    i++;
    const first = i === 0 || afterColon;
    afterColon = /:$/.test(w);
    if (/^\d/.test(w) || /[A-Z]{2,}/.test(w)) return w;
    const core = w.toLowerCase();
    if (!first && SMALL.has(core.replace(/[^a-z']/g, ""))) return core;
    if (!core.includes("-")) return cap(core);
    return core.split("-").map((part, j) => (j > 0 && SMALL.has(part.replace(/[^a-z']/g, "")) ? part : cap(part))).join("-");
  }).join("");
}

function hasKeyword(text: string, kw: string): boolean {
  const words = kw.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const t = text.toLowerCase();
  const stem = (w: string) => w.replace(/(ies|es|s)$/, "");
  return words.every((w) => t.includes(stem(w)));
}

function trimTitle(t: string, max = 60): string {
  if (t.length <= max) return t;
  let s = t.slice(0, max);
  s = s.replace(/[\s\-–—:,]+\S*$/, "");
  return s.replace(/\s+(?:a|an|the|for|of|to|with|and|or|in|on|at|by|from|that|your)$/i, "").trim();
}

function fitDescription(d: string): string {
  let out = d.trim().replace(/\s+/g, " ").replace(/^([a-z])/, (c) => c.toUpperCase());
  if (out.length > 160) {
    let best = "";
    for (const m of out.matchAll(/[.!?](?=\s|$)/g)) {
      const head = out.slice(0, (m.index ?? 0) + 1);
      if (head.length <= 160) best = head; else break;
    }
    if (best.length >= 100) out = best;
    else {
      let acc = "";
      for (const w of out.split(" ")) { const next = acc ? `${acc} ${w}` : w; if (next.length + 1 > 158) break; acc = next; }
      for (let k = 0; k < 4; k++) acc = acc.replace(/[\s,;:—–-]+$/, "").replace(/\s+(?:a|an|the|and|or|for|of|to|in|on|with|at|by|from|that|your|this|plus)$/i, "");
      out = `${acc.replace(/[.!?]+$/, "")}.`;
    }
  }
  if (!/[.!?]$/.test(out)) out = `${out.replace(/[\s,;:—–-]+$/, "")}.`;
  return out;
}

export const meta: StageHandler = async (ctx) => {
  const { post, recipe, outline, brief } = ctx;
  const keywordRaw = post.keyword.trim();
  const year = keywordYear(keywordRaw);
  const keyword = normalizeMetaYear(keywordRaw, year);
  const kwNoYear = stripYear(keyword);
  const us = usesUsSpelling(recipe.params.language, recipe.params.country);
  const yearPercent = yearPercentOf(recipe.run?.yearInUrlPercent, recipe.publish?.seoYearUrlPercent);
  const yearInSlug = yearInSlugFor(post.id, year, yearPercent);
  const kwSlug = slugify(kwNoYear, 90);

  const validate = (m: Meta): string[] => {
    const p: string[] = [];
    if (m.title.length > 60) p.push(`title is ${m.title.length} characters — rewrite it to 60 or fewer`);
    if (m.title.length < 35) p.push(`title is only ${m.title.length} characters — make it 40-58 characters with one concrete benefit`);
    if (m.description.length < 120) p.push(`description is ${m.description.length} characters — expand to 140-160`);
    if (m.description.length > 160) p.push(`description is ${m.description.length} characters — shorten to 160 or fewer`);
    if (!hasKeyword(m.title, kwNoYear)) p.push(`title must contain the keyword "${kwNoYear}" in recognisable form`);
    if (!hasKeyword(m.h1, kwNoYear)) p.push(`h1 must contain the keyword "${kwNoYear}"`);
    if (!hasKeyword(m.description, kwNoYear)) p.push(`description must contain the keyword "${kwNoYear}"`);
    if (/\|/.test(m.title)) p.push("title must not contain a | separator or site name");
    if (/[Ѐ-ӿ]/.test(`${m.h1}${m.title}${m.description}${m.slug}`)) p.push("meta must be in English (Latin letters only)");
    if (/\b(stunning|elevate|effortless(?:ly)?|ultimate guide|must-know)\b/i.test(`${m.title} ${m.h1}`)) p.push("avoid marketing filler (stunning, elevate, effortless, ultimate guide)");
    return p;
  };

  const fromPlan: Meta = {
    h1: (outline?.h1 || post.h1 || keyword).trim(),
    title: (outline?.title || post.metaTitle || outline?.h1 || keyword).trim(),
    description: (outline?.metaDescription || post.metaDescription || "").trim(),
    slug: (outline?.slug || post.slug || kwSlug).trim(),
  };
  let m: Meta = { ...fromPlan };
  let problems = validate(m);
  let usedAi = false;
  let usedModel: string | null = null;
  if (problems.length) {
    await ctx.tick("SEO-мета: починка");
    const system = `You write SEO metadata for an informational article on a US lifestyle blog. Return ONLY JSON: {"h1":"...","title":"...","description":"...","slug":"..."}.
Rules: title 40-58 characters, Title Case, contains the keyword naturally, no colon-dump templates, no site name, no "|", no filler (ultimate, stunning, effortless, elevate, must-know); h1 40-75 characters, contains the exact keyword, may differ from the title; description 140-160 characters, contains the keyword, states what the reader will learn and one concrete benefit, no em dashes; slug = the keyword as one hyphenated block, lowercase, no extra words. ${year ? `Use the year ${year} in title, h1 and description.` : "No years anywhere."} American English.`;
    const user = `Keyword: "${keyword}"\nIntent: ${brief?.intent ?? "informational"}. Summary: ${brief?.summary?.slice(0, 400) ?? ""}\nSection headings:\n${(outline?.sections ?? []).map((s) => `- ${s.heading}`).join("\n")}\n\nCurrent draft:\n${JSON.stringify(fromPlan)}\nProblems to fix:\n- ${problems.join("\n- ")}`;
    try {
      const r = await aiChat(ctx.ai, { slot: SLOTS.textFast, model: stageModel(recipe, "meta"), system, user, json: true, temperature: 0.8, maxTokens: 600, timeoutMs: 90_000 });
      usedAi = true;
      usedModel = r.model;
      const parsed = parseModelJsonSafe(r.text) as Partial<Meta> | null;
      if (parsed && typeof parsed === "object") {
        const cand: Meta = { h1: String(parsed.h1 ?? m.h1), title: String(parsed.title ?? m.title), description: String(parsed.description ?? m.description), slug: String(parsed.slug ?? m.slug) };
        if (validate(cand).length <= problems.length) m = cand;
      }
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
      ctx.log(`починка меты ИИ не удалась: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Детерминированные правки
  if (/[Ѐ-ӿ]/.test(m.h1)) m.h1 = keyword;
  if (/[Ѐ-ӿ]/.test(m.title)) m.title = keyword;
  if (/[Ѐ-ӿ]/.test(m.description)) m.description = "";
  m.h1 = normalizeMetaYear(m.h1, year);
  m.title = normalizeMetaYear(m.title, year);
  m.description = normalizeMetaYear(m.description, year);
  if (!hasKeyword(m.h1, kwNoYear)) m.h1 = `${titleCase(kwNoYear)}: ${m.h1}`.slice(0, 120);
  if (!hasKeyword(m.title, kwNoYear)) m.title = titleCase(kwNoYear);
  if (m.title.length < 35 && m.h1.length >= 35 && m.h1.length <= 60) m.title = m.h1;
  m.title = trimTitle(titleCase(polishHeading(m.title.replace(/\s*\|\s*.*$/, ""), { usSpelling: us })), 60);
  m.h1 = titleCase(polishHeading(m.h1, { usSpelling: us })).slice(0, 120);
  if (!m.description.trim() || m.description.length < 60) m.description = `${titleCase(kwNoYear)}: what works, what to avoid and how to do it right, step by step, with practical tips you can use today.`;
  if (!hasKeyword(m.description, kwNoYear)) m.description = `${kwNoYear.charAt(0).toUpperCase()}${kwNoYear.slice(1)}: ${m.description}`;
  m.description = fitDescription(us ? toUsSpellingText(fixDashesText(m.description)) : fixDashesText(m.description));
  if (m.description.length < 120) m.description = fitDescription(`${m.description.replace(/[.!?]$/, "")}. Clear steps, common mistakes and practical tips in one guide.`);
  if (year && !m.title.includes(year)) m.title = trimTitle(`${m.title} ${year}`, 60).includes(year) ? trimTitle(`${m.title} ${year}`, 60) : `${trimTitle(m.title, 60 - year.length - 1)} ${year}`;
  // Slug: слова ключа + 2–3 смысловых слова из H1 (запас — тема статьи и заголовки секций), не голый ключ
  const slug = contextSlug({ keyword: kwNoYear, h1: m.h1, extra: [post.topic, ...(outline?.sections ?? []).map((s) => s.heading)], seed: post.id });
  m.slug = applySlugYear(slug, year, yearInSlug) || kwSlug;

  // Число пунктов: по написанным секциям (подборка/список/тренировка — пункты, большой список — строки <li>)
  const st = recipe.scenario?.structure;
  if (st && (LIST_STRUCTURES.includes(st) || st === "big_list")) {
    const secs = await prisma.blogSection.findMany({ where: { postId: post.id, status: "written" }, select: { kind: true, html: true } });
    const count = countListItems(st, secs) ?? 0;
    if (count >= 3) { m.h1 = fixLeadingNumber(m.h1, count); m.title = fixLeadingNumber(m.title, count); m.description = fixLeadingNumber(m.description, count); }
  }
  await prisma.blogPost.update({ where: { id: post.id }, data: { h1: m.h1, metaTitle: m.title, metaDescription: m.description, slug: m.slug } });
  if (outline) await ctx.save({ outline: { ...outline, h1: m.h1, title: m.title, metaDescription: m.description, slug: m.slug } });
  problems = validate(m);
  const pins = await writePinDescriptions(ctx, kwNoYear, m.h1);
  return {
    summary: `${usedAi ? "ИИ" : "Из плана"}: «${m.title}» · /${m.slug}${problems.length ? ` (остались: ${problems.length})` : ""}${pins.written ? ` · описания пинов: ${pins.written}` : ""}`,
    details: { ...m, usedAi, model: usedModel, year: year || null, yearInSlug, remaining: problems, pins },
  };
};

/**
 * Описание пина для каждого фото статьи (data-pin-description): когда читатель сохраняет картинку с сайта, в его пине
 * будет этот текст, а не описание кадра. Один вызов text_fast на все фото; уже написанные не трогаем; сбой не роняет этап.
 */
async function writePinDescriptions(ctx: Parameters<StageHandler>[0], keyword: string, h1: string): Promise<{ written: number; error?: string }> {
  const { post, outline, recipe } = ctx;
  const photos = await prisma.blogPhoto.findMany({ where: { postId: post.id, excluded: false, pinDescription: null }, orderBy: { position: "asc" } });
  if (!photos.length) return { written: 0 };
  const headingOf = (slotKey: string) => {
    if (slotKey === "hero") return h1;
    if (slotKey === "closing") return "the finished result";
    const pos = Number(slotKey.replace(/^(?:s|ai)/, ""));
    return outline?.sections.find((s) => s.position === pos)?.heading ?? h1;
  };
  await ctx.tick("Описания пинов");
  const list = photos.map((p, i) => `${i + 1}. section: "${headingOf(p.slotKey)}"; photo shows: ${p.description || p.altText || "-"}`).join("\n");
  const system = `You write Pinterest pin descriptions for photos inside an informational blog article. For EACH photo write one description a person would be glad to save: 150-280 characters, 1-2 natural sentences, says what the reader learns from this part of the article and why to save it, includes the keyword "${keyword}" once in natural form, may add one closely related search phrase. Start with the concrete benefit or the question the photo answers, not with "Learn", "Discover" or "Save this". Never use the words "pin" or "save this". No hashtags, no emoji, no "click", no "link in bio", no quotes, no em dashes, American English.
Return ONLY JSON: {"pins":[{"n":1,"description":"..."}]}`;
  try {
    const r = await aiChat(ctx.ai, { slot: SLOTS.textFast, model: stageModel(recipe, "meta"), system, user: `Article: "${h1}"\nPhotos:\n${list}`, json: true, temperature: 0.8, maxTokens: 1500, timeoutMs: 90_000 });
    const parsed = parseModelJsonSafe(r.text) as { pins?: Array<{ n?: unknown; description?: unknown }> } | null;
    let written = 0;
    for (const it of parsed?.pins ?? []) {
      const ph = photos[Number(it.n) - 1];
      const d = fixDashesText(String(it.description ?? "").replace(/#\S+/g, "").replace(/\s+/g, " ").trim()).slice(0, 480);
      if (!ph || d.length < 60) continue;
      await prisma.blogPhoto.updateMany({ where: { id: ph.id }, data: { pinDescription: d } });
      written++;
    }
    return { written };
  } catch (e) {
    if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
    const error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    ctx.log(`описания пинов не получены: ${error}`);
    return { written: 0, error };
  }
}
