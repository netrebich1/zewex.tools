/**
 * Этап `outline`: адаптивный план статьи из каталога блоков (src/lib/blog/blocks.ts) по брифу исследования.
 * Модель выбирает структуру по интенту и теме; код держит границы сценария: число секций, объём, картинки ∈ [min,max],
 * уникальные H2, правила «всегда/никогда» для выводов, FAQ, дисклеймера, последней картинки.
 * Результат: BlogPost.outline (BlogOutline), строки BlogSection 1..N (planned) и BlogImageSlot (hero, s<pos>, closing).
 * Идемпотентно: если есть написанные секции — план не трогаем.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import { aiChat } from "@/lib/blog/ai";
import { MalformedAiOutput } from "@/lib/articles/errors";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { headingKey, sanitizeTopic } from "@/lib/articles/text/textGuards";
import { slugify } from "@/lib/articles/text/slug";
import { BLOCK_BY_KIND, blockOf, blocksCatalogText } from "@/lib/blog/blocks";
import { fillPrompt, resolvePrompt, stageModel } from "@/lib/blog/prompts";
import { briefShort, cleanHeading } from "@/lib/blog/text";
import { SLOTS, VOICES, type BlogOutline, type OutlineImage, type OutlineSection, type Tri } from "@/lib/blog/types";
import type { StageHandler } from "./index";

const STAGE_KEY = "outline";
const TRIES = 3;
const MIN_SECTIONS = 3;
const MAX_SECTIONS = 12;

type R = Record<string, unknown>;

const ruleText = (t: Tri, what: string): string => (t === "always" ? `${what}: ALWAYS include.` : t === "never" ? `${what}: NEVER include.` : `${what}: include only when it helps this topic.`);

function imageOf(v: unknown): OutlineImage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as R;
  const query = String(o.query ?? o.search ?? "").trim().slice(0, 160);
  if (!query) return null;
  const or = String(o.orientation ?? "").toLowerCase();
  return {
    query,
    altQuery: String(o.alt_query ?? o.altQuery ?? "").trim().slice(0, 160) || undefined,
    mustShow: String(o.must_show ?? o.mustShow ?? "").trim().slice(0, 240) || undefined,
    avoid: String(o.avoid ?? "").trim().slice(0, 240) || undefined,
    orientation: or === "square" || or === "any" || or === "tall" ? (or as "square" | "any" | "tall") : undefined,
  };
}

export const outline: StageHandler = async (ctx) => {
  const { post, recipe } = ctx;
  const params = recipe.params;
  const brief = ctx.brief;
  if (!brief) return { next: "research", summary: "Нет брифа — возврат к исследованию" };

  const existing = await prisma.blogSection.findMany({ where: { postId: post.id } });
  const written = existing.filter((s) => s.status === "written" && (s.html ?? "").trim());
  if (written.length && ctx.outline?.sections?.length) {
    return { summary: `План уже есть, написано секций: ${written.length} — пропуск`, details: { skipped: true } };
  }

  const keyword = post.keyword;
  const voice = VOICES.find((v) => v.value === params.voice);
  const prompt = resolvePrompt(recipe, STAGE_KEY);
  const vars = {
    keyword,
    focus_keyword: post.focusKeyword || keyword,
    brief: briefShort(brief),
    blocks_catalog: blocksCatalogText(),
    length_min: params.length.min,
    length_max: params.length.max,
    images_min: params.images.min,
    images_max: params.images.max,
    faq_min: params.faqCount.min,
    faq_max: params.faqCount.max,
    takeaways_rule: ruleText(params.blocks.takeaways, "Key takeaways box after the intro"),
    faq_rule: ruleText(params.blocks.faq, "FAQ block"),
    disclaimer_rule: params.blocks.disclaimer === "never" ? "Disclaimer: NEVER." : params.blocks.disclaimer === "always" ? "Disclaimer: ALWAYS include." : `Disclaimer: include when the topic touches health, medicine, pregnancy, money or safety${brief.ymyl ? " (THIS TOPIC DOES)" : ""}.`,
    closing_image_rule: ruleText(params.blocks.closingImage, "Closing photo after the last section"),
    voice: voice ? `${voice.label}: ${voice.help}` : params.voice,
    persona: params.persona,
    language: params.language,
    country: params.country,
  };
  const filled = fillPrompt(prompt, vars, { name: STAGE_KEY });
  const chosenVideo = ((post.video ?? null) as { chosen?: { title: string; channel: string; sec: number; judge?: { covers?: string[] } } | null } | null)?.chosen ?? null;
  const scenarioHint = recipe.scenario?.outlineHint ? `\n\nARTICLE TYPE: ${recipe.scenario.label}. ${recipe.scenario.outlineHint}` : "";
  const videoBlock = scenarioHint + (chosenVideo ? `\n\nVIDEO: a YouTube video "${chosenVideo.title}" by ${chosenVideo.channel} (${Math.max(1, Math.round(chosenVideo.sec / 60))} min) will be embedded in one section. It covers: ${(chosenVideo.judge?.covers ?? []).join("; ") || "the method"}. Add to the JSON "video_section": the position (1-based) of the section this video supports best, usually the steps section.` : "");
  const model = stageModel(recipe, STAGE_KEY);

  let lastWhy = "";
  let correction = "";
  let usedModel: string | null = null;
  let out: R | null = null;
  for (let i = 0; i < TRIES; i++) {
    await ctx.tick(`План: запрос ${i + 1}/${TRIES}`);
    let text = "";
    try {
      const r = await aiChat(ctx.ai, { slot: SLOTS.textMain, model, system: filled.system, user: filled.user + videoBlock + correction, json: true, temperature: i === 0 ? 0.6 : 0.3, maxTokens: 8000, timeoutMs: 240_000 });
      text = r.text;
      usedModel = r.model;
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "transient" && i + 1 < TRIES) {
        ctx.log(`временная ошибка: ${e.message}`);
        await new Promise((res) => setTimeout(res, backoffMs(i)));
        continue;
      }
      throw e;
    }
    const parsed = parseModelJsonSafe(text) as R | null;
    if (!parsed || typeof parsed !== "object") { lastWhy = "ответ не JSON"; correction = "\n\nIMPORTANT: your previous answer was not valid JSON. Return ONLY one JSON object."; continue; }
    const secs = Array.isArray(parsed.sections) ? parsed.sections : [];
    if (secs.length < MIN_SECTIONS) { lastWhy = `секций ${secs.length}, нужно не меньше ${MIN_SECTIONS}`; correction = `\n\nIMPORTANT: "sections" must contain at least ${MIN_SECTIONS} entries.`; continue; }
    out = parsed;
    break;
  }
  if (!out) throw new MalformedAiOutput(`План не получен: ${lastWhy} (после ${TRIES} попыток)`);

  // ── Секции: валидные типы, уникальные заголовки, объём в границах ──
  const usedKeys = new Set<string>();
  const sections: OutlineSection[] = [];
  for (const raw of (out.sections as unknown[]).slice(0, MAX_SECTIONS)) {
    const o = (raw && typeof raw === "object" ? raw : {}) as R;
    const kindRaw = String(o.kind ?? o.block ?? "prose").toLowerCase().replace(/[\s-]+/g, "_");
    const kind = BLOCK_BY_KIND[kindRaw] ? kindRaw : "prose";
    let heading = cleanHeading(sanitizeTopic(String(o.heading ?? o.h2 ?? "").trim())).slice(0, 120);
    if (!heading) heading = `${blockOf(kind).label} ${sections.length + 1}`;
    let key = headingKey(heading);
    if (!key || usedKeys.has(key)) {
      heading = `${heading} (${sections.length + 1})`;
      key = headingKey(heading) || `k${sections.length + 1}`;
    }
    usedKeys.add(key);
    const spec = blockOf(kind);
    const tw = Number(o.target_words ?? o.targetWords ?? 0);
    const targetWords = Number.isFinite(tw) && tw > 0 ? Math.max(spec.words[0], Math.min(spec.words[1] * 1.3, Math.round(tw))) : Math.round((spec.words[0] + spec.words[1]) / 2);
    const keyPoints = (Array.isArray(o.key_points) ? o.key_points : Array.isArray(o.keyPoints) ? o.keyPoints : []).map((k) => String(k ?? "").trim().slice(0, 300)).filter(Boolean).slice(0, 10);
    sections.push({
      position: sections.length + 1,
      kind,
      heading,
      keyPoints,
      targetWords,
      notes: String(o.notes ?? "").trim().slice(0, 500) || undefined,
      image: imageOf(o.image),
    });
  }

  // Объём статьи: сумма секций приводится к [min,max] с учётом вступления/итогов/заключения/FAQ (~15 %).
  const bodyMin = Math.round(params.length.min * 0.78);
  const bodyMax = Math.round(params.length.max * 0.85);
  const sum = sections.reduce((n, s) => n + s.targetWords, 0);
  if (sum < bodyMin || sum > bodyMax) {
    const target = sum < bodyMin ? bodyMin : bodyMax;
    const k = target / Math.max(1, sum);
    for (const s of sections) s.targetWords = Math.max(50, Math.round(s.targetWords * k));
  }
  const targetWords = Math.round(sections.reduce((n, s) => n + s.targetWords, 0) / 0.82);

  // ── Картинки: hero обязателен; число (hero + секции + closing) ∈ [min,max] ──
  const hero = imageOf(out.hero) ?? { query: `${keyword} close-up real photo`, mustShow: keyword, orientation: params.images.heroOrientation };
  hero.orientation = params.images.heroOrientation;
  let closing = params.blocks.closingImage === "never" ? null : imageOf(out.closing_image ?? out.closingImage);
  if (params.blocks.closingImage === "always" && !closing) closing = { query: `${keyword} result`, orientation: "any" };
  const countImages = () => 1 + sections.filter((s) => s.image).length + (closing ? 1 : 0);
  // Лишние: сначала у блоков, где фото «rarely», затем с конца; closing — последним.
  const dropOrder = [...sections].sort((a, b) => rank(a.kind) - rank(b.kind) || b.position - a.position);
  while (countImages() > params.images.max) {
    const victim = dropOrder.find((s) => s.image);
    if (victim) victim.image = null;
    else if (closing) closing = null;
    else break;
  }
  // Недостающие: блокам, где фото «often»/«sometimes», по порядку, запрос по заголовку.
  const addOrder = [...sections].sort((a, b) => rank(b.kind) - rank(a.kind) || a.position - b.position);
  while (countImages() < params.images.min) {
    const target = addOrder.find((s) => !s.image && blockOf(s.kind).image !== "rarely") ?? addOrder.find((s) => !s.image);
    if (!target) break;
    target.image = { query: `${keyword} ${target.heading}`.slice(0, 160), orientation: "any" };
  }

  // ── Флаги блоков ──
  const takeaways = params.blocks.takeaways === "always" ? true : params.blocks.takeaways === "never" ? false : out.takeaways === true || (out.takeaways as R | undefined)?.enabled === true;
  const faqRaw = (out.faq && typeof out.faq === "object" ? out.faq : {}) as R;
  const faqQuestions = (Array.isArray(faqRaw.questions) ? faqRaw.questions : []).map((q) => String(q ?? "").trim().slice(0, 200)).filter(Boolean);
  let faqEnabled = params.blocks.faq === "always" ? true : params.blocks.faq === "never" ? false : faqRaw.enabled !== false && (faqQuestions.length > 0 || out.faq === true);
  const pool = [...faqQuestions, ...(brief.serp?.questions ?? []), ...(brief.questions ?? [])].filter((q, i, arr) => arr.findIndex((x) => x.toLowerCase() === q.toLowerCase()) === i);
  const faqCount = Math.max(params.faqCount.min, Math.min(params.faqCount.max, faqQuestions.length || params.faqCount.min));
  if (faqEnabled && pool.length < 2) faqEnabled = false;
  const disclaimer = params.blocks.disclaimer === "always" ? true : params.blocks.disclaimer === "never" ? false : out.disclaimer === true || brief.ymyl;

  const h1 = sanitizeTopic(String(out.h1 ?? "").trim()).slice(0, 160) || keyword;
  const title = sanitizeTopic(String(out.title ?? out.seo_title ?? "").trim()).slice(0, 120) || h1;
  const metaDescription = String(out.meta_description ?? out.metaDescription ?? "").trim().slice(0, 400);
  const slug = slugify(String(out.slug ?? out.url_slug ?? ""), 90) || slugify(keyword, 90);

  const plan: BlogOutline = {
    h1, title, metaDescription, slug, targetWords,
    hero, closingImage: closing,
    takeaways,
    faq: { enabled: faqEnabled, count: faqCount, questions: pool.slice(0, Math.max(faqCount, params.faqCount.max)) },
    disclaimer,
    sections,
    videoSection: chosenVideo ? pickVideoSection(out.video_section, sections) : null,
    model: usedModel,
    plannedAt: new Date().toISOString(),
  };

  // ── Записи: секции и слоты (ненаписанные пересоздаются) ──
  await ctx.tick("Сохранение плана");
  await prisma.$transaction(async (tx) => {
    await tx.blogSection.deleteMany({ where: { postId: post.id } });
    await tx.blogSection.createMany({
      data: sections.map((s) => ({ postId: post.id, position: s.position, kind: s.kind, heading: s.heading, brief: { keyPoints: s.keyPoints, targetWords: s.targetWords, notes: s.notes ?? null } as object, status: "planned", slotKey: s.image ? `s${s.position}` : null })),
    });
    await tx.blogImageSlot.deleteMany({ where: { postId: post.id } });
    const slots: Array<{ key: string; sectionPosition: number | null; img: OutlineImage; required: boolean }> = [{ key: "hero", sectionPosition: null, img: hero, required: true }];
    for (const s of sections) if (s.image) slots.push({ key: `s${s.position}`, sectionPosition: s.position, img: s.image, required: false });
    if (closing) slots.push({ key: "closing", sectionPosition: null, img: closing, required: false });
    await tx.blogImageSlot.createMany({
      data: slots.map((sl) => ({
        postId: post.id, key: sl.key, sectionPosition: sl.sectionPosition, query: sl.img.query, altQuery: sl.img.altQuery ?? null, mustShow: sl.img.mustShow ?? null, avoid: sl.img.avoid ?? null,
        orientation: sl.img.orientation ?? (sl.key === "hero" ? params.images.heroOrientation : "any"), required: sl.required, status: "pending",
      })),
    });
    await tx.blogPost.update({ where: { id: post.id }, data: { h1, metaTitle: title, metaDescription, slug, introHtml: null, takeawaysHtml: null, conclusionHtml: null, faq: Prisma.DbNull, disclaimerHtml: null, html: null } });
  });
  await ctx.save({ outline: plan });

  return {
    summary: `План: ${sections.length} секций (${sections.map((s) => s.kind).join(", ")}), ~${targetWords} слов, картинок ${countImages()}${faqEnabled ? `, FAQ ${faqCount}` : ""}${takeaways ? ", выводы" : ""}${disclaimer ? ", дисклеймер" : ""}`,
    details: { sections: sections.map((s) => ({ position: s.position, kind: s.kind, heading: s.heading, words: s.targetWords, image: !!s.image })), images: countImages(), targetWords, faq: plan.faq, takeaways, disclaimer, h1, title, slug, model: usedModel },
  };
};

/** Секция для видео: ответ плана, иначе первая с шагами/методами, иначе вторая. */
function pickVideoSection(raw: unknown, sections: OutlineSection[]): number | null {
  const n = Math.round(Number(raw));
  if (sections.some((s) => s.position === n && s.kind !== "comparison_table")) return n;
  return (sections.find((s) => s.kind === "steps") ?? sections.find((s) => s.kind === "methods") ?? sections[1] ?? sections[0])?.position ?? null;
}

function rank(kind: string): number {
  const im = blockOf(kind).image;
  return im === "rarely" ? 0 : im === "sometimes" ? 1 : 2;
}
