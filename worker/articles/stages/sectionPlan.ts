/**
 * Этап `section_plan` (шаг 16 оригинала, stage-photo-section-plan/index.ts): дешёвая модель по фактам каждого
 * фото решает, ЧТО писать в секции — угол, заход, объём, список, уход, повод, DIY/салон, честный минус.
 * Результат — «рецепт» в ArtSection.brief.recipe и сводка распределения в плане статьи.
 */
import { prisma } from "@/lib/db";
import { SLOTS, type ArticlePlan } from "@/lib/articles/types";
import { resolvePrompt, fillPrompt } from "@/lib/articles/prompts";
import { sanitizeTopic, uniqueHeading } from "@/lib/articles/text/textGuards";
import { ANGLES, OPENERS, FASHION_ANGLES, INTERIOR_ANGLES, anglesFor, buildPromptVars, contractsFor, isOutfitsNiche, loadProfile, type JsonRecord } from "@/lib/articles/text/vars";
import { fashionContractPrompt, interiorContractPrompt, isInteriorNiche } from "@/lib/articles/photo/contracts";
import type { ArtStageHandler } from "./index";
import { briefOf, callPlanner, loadActivePhotos, loadPhotoSections } from "./plan";

const STAGE_KEY = "rp_section_plan";
const LENGTHS = ["short", "medium", "long"] as const;

export type SectionRecipe = {
  section_number: number;
  h2: string | null;
  angle: string;
  opener: string;
  length: string;
  paragraphs: number;
  include_list: boolean;
  list_focus: string | null;
  include_care: boolean;
  include_occasion: boolean;
  include_diy_vs_salon: boolean;
  include_honest_minus: boolean;
  focus_fact: string | null;
  avoid: string[];
  note: string | null;
  narrative_role: string;
  reader_question: string | null;
  primary_takeaway: string | null;
};

function pick<T>(list: readonly T[], i: number): T {
  return list[i % list.length];
}

/** Нормализация рецепта модели (оригинал: 198-225); `avoid` фильтруется по реально выданным углам. */
export function normalizeRecipe(raw: unknown, sectionNumber: number, i: number, angles: readonly string[]): SectionRecipe {
  const r = (raw && typeof raw === "object" ? raw : {}) as JsonRecord;
  const str = (v: unknown, max: number) => (v ? String(v).slice(0, max) : null);
  return {
    section_number: sectionNumber,
    h2: (r.h2 || r.h2_heading || r.heading) ? String(r.h2 || r.h2_heading || r.heading) : null,
    angle: String(r.angle || pick(angles, i)),
    opener: String(r.opener || pick(OPENERS, i)),
    length: String(r.length || pick(LENGTHS, i)),
    paragraphs: Number(r.paragraphs) === 2 ? 2 : 1,
    include_list: r.include_list === true,
    list_focus: str(r.list_focus, 200),
    include_care: r.include_care === true,
    include_occasion: r.include_occasion === true,
    include_diy_vs_salon: r.include_diy_vs_salon === true,
    include_honest_minus: r.include_honest_minus === true,
    focus_fact: str(r.focus_fact, 300),
    avoid: Array.isArray(r.avoid)
      ? (r.avoid as unknown[]).map(String).filter((a) => angles.includes(a) || (OPENERS as readonly string[]).includes(a)).slice(0, 6)
      : [],
    note: str(r.note, 400),
    narrative_role: String(r.narrative_role || (i === 0 ? "hook" : "practical")),
    reader_question: str(r.reader_question, 240),
    primary_takeaway: str(r.primary_takeaway, 240),
  };
}

/**
 * Проверяем и правим распределение: без шаблона и без перекосов (оригинал: 133-196).
 * Лимиты: список ≤15 %, уход ≤40 %, повод ≤35 %, один угол ≤ max(2, ceil(n/5)); соседи — разный угол и заход;
 * не больше двух одинаковых объёмов подряд. Угол валидируется по списку, который реально ушёл в промт
 * (fashionAngles / interiorAngles / ANGLES) — аудит 03, §7.3: раньше fashion/interior-углы заменялись на ногтевые.
 */
export function enforceDistribution(recipes: SectionRecipe[], angles: readonly string[]): { recipes: SectionRecipe[]; summary: JsonRecord } {
  const total = recipes.length;
  const maxList = Math.max(2, Math.round(total * 0.15));
  const maxCare = Math.max(2, Math.round(total * 0.4));
  const maxOccasion = Math.max(1, Math.round(total * 0.35));
  const maxSameAngle = Math.max(2, Math.ceil(total / 5));

  const angleCount: Record<string, number> = {};
  let lists = 0, cares = 0, occasions = 0;

  recipes.forEach((r, i) => {
    const prev = i > 0 ? recipes[i - 1] : null;

    if (!angles.includes(r.angle)) r.angle = pick(angles, i);
    let guard = 0;
    while (guard++ < angles.length && ((prev && r.angle === prev.angle) || (angleCount[r.angle] || 0) >= maxSameAngle)) {
      r.angle = pick(angles, i + guard);
    }
    angleCount[r.angle] = (angleCount[r.angle] || 0) + 1;

    if (!(OPENERS as readonly string[]).includes(r.opener)) r.opener = pick(OPENERS, i);
    if (prev && r.opener === prev.opener) r.opener = pick(OPENERS, i + 1);

    if (!(LENGTHS as readonly string[]).includes(r.length)) r.length = pick(LENGTHS, i);
    if (i >= 2 && recipes[i - 1].length === r.length && recipes[i - 2].length === r.length) {
      r.length = pick(LENGTHS, i + 1);
    }
    r.paragraphs = r.length === "short" ? 1 : Number(r.paragraphs) === 2 ? 2 : r.length === "long" ? 2 : 1;

    if (r.include_list && (lists >= maxList || (prev && prev.include_list))) r.include_list = false;
    if (r.include_list) lists++; else r.list_focus = null;

    if (r.include_care && (cares >= maxCare || (prev && prev.include_care && i % 2 === 0))) r.include_care = false;
    if (r.include_care) cares++;

    if (r.include_occasion && (occasions >= maxOccasion || (prev && prev.include_occasion))) r.include_occasion = false;
    if (r.include_occasion) occasions++;

    if (prev && prev.include_honest_minus && r.include_honest_minus) r.include_honest_minus = false;
    if (prev && prev.include_diy_vs_salon && r.include_diy_vs_salon) r.include_diy_vs_salon = false;

    const avoid = new Set((r.avoid || []).filter(Boolean).map(String));
    for (const p of recipes.slice(Math.max(0, i - 2), i)) avoid.add(p.angle);
    r.avoid = [...avoid].slice(0, 6);
  });

  return { recipes, summary: { total, angles: angleCount, lists, cares, occasions, limits: { maxList, maxCare, maxOccasion, maxSameAngle } } };
}

export const sectionPlan: ArtStageHandler = async (ctx) => {
  const { article, recipe } = ctx;
  const sections = await loadPhotoSections(article.id);
  if (!sections.length) return { next: "plan", summary: "Нет секций — возврат к плану по фото" };

  // Идемпотентность: рецепты уже есть у всех секций — не тратим вызов.
  if (sections.every((s) => briefOf(s).recipe && typeof briefOf(s).recipe === "object")) {
    return { summary: `Рецепты секций уже есть (${sections.length}) — пропуск`, details: { skipped: true } };
  }

  const photos = await loadActivePhotos(article.id);
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const profile = await loadProfile(ctx);
  const { fashion, interior } = contractsFor(ctx);
  const angles = anglesFor(ctx);

  const prompt = await resolvePrompt(recipe, STAGE_KEY);
  const vars = await buildPromptVars(ctx, { photos, sections, profile });
  const filled = fillPrompt(prompt, vars);
  // К system дописывается контракт и список углов для одежды/интерьера (оригинал: 333-337).
  let system = filled.system;
  if (fashion) {
    system += `\n\n${fashionContractPrompt(fashion)}\nFor fashion, use only these angles: ${FASHION_ANGLES.join(", ")}. Never invent brands, prices, fabrics, personal testing, or fit claims. Every section must keep the piece/look intent central and add a distinct practical takeaway.`;
  }
  if (interior) {
    system += `\n\n${interiorContractPrompt(interior)}\nFor home decor, use only these angles: ${INTERIOR_ANGLES.join(", ")}. Never invent prices, brands, room dimensions, renovation cost or personal testing. Every section must keep the room/element intent central and add a distinct practical takeaway (layout, materials, lighting, storage, budget swap or renter-friendly note).`;
  }

  const { list: rawList, model } = await callPlanner(ctx, {
    stageKey: STAGE_KEY,
    slot: SLOTS.textFast,
    system,
    user: filled.user,
    maxTokens: 12000,
    temps: [0.8, 0.3], // оригинал: stage-photo-section-plan:343-346
    pickList: (o) => (Array.isArray(o.sections) ? (o.sections as JsonRecord[]) : []),
  });

  // Номер секции — из ответа модели, иначе по порядку (оригинал: 380-385).
  const byNumber = new Map<number, JsonRecord>();
  rawList.forEach((r, i) => {
    const n = Number(r?.section_number ?? r?.n ?? 0);
    if (n) byNumber.set(n, r);
    else if (sections[i]) byNumber.set(sections[i].position, r);
  });

  let recipes = sections.map((s, i) => normalizeRecipe(byNumber.get(s.position), s.position, i, angles));
  const enforced = enforceDistribution(recipes, angles);
  recipes = enforced.recipes;

  // Заголовки: планер задаёт их один раз и следит за уникальностью (оригинал: 386-401).
  const usedHeadings = new Set<string>();
  const fallbackHeading = isOutfitsNiche(recipe.nicheCode) ? "Outfit Idea" : isInteriorNiche(recipe.nicheCode, recipe.subnicheCode) ? "Room Idea" : "Visual Idea";
  const headings = sections.map((s, i) => {
    const photo = s.photoId ? photoById.get(s.photoId) : undefined;
    const b = briefOf(s);
    const base = String(recipes[i]?.h2 || s.heading || b.h2_draft || b.h2 || "").trim();
    const clean = sanitizeTopic(base) || base || fallbackHeading;
    const unique = uniqueHeading(clean, usedHeadings, { facts: photo?.facts, description: photo?.description });
    if (unique !== clean) ctx.log(`секция ${s.position}: дубль заголовка «${clean}» → «${unique}»`);
    return unique;
  });

  await ctx.tick("Сохранение рецептов");
  await prisma.$transaction(
    sections.map((s, i) => {
      const r = { ...recipes[i], h2: headings[i] };
      recipes[i] = r;
      const b = briefOf(s);
      return prisma.artSection.update({
        where: { id: s.id },
        data: { heading: headings[i], brief: { ...b, recipe: r, h2: headings[i], h2_draft: headings[i] } as object },
      });
    }),
  );

  const planNow: ArticlePlan = ctx.plan ?? { h1: article.h1, title: article.metaTitle, metaDescription: article.metaDescription, slug: article.slug };
  const nextPlan: ArticlePlan = {
    ...planNow,
    sections: sections.map((s, i) => ({
      position: s.position,
      photoId: s.photoId,
      heading: headings[i],
      brief: { ...briefOf(s), recipe: recipes[i], h2: headings[i], h2_draft: headings[i] },
    })),
    sectionRecipesSummary: enforced.summary,
    anglesUsed: [...angles],
  };
  await ctx.save({ plan: nextPlan });

  return {
    summary: `Рецепты для ${recipes.length} секций (углы: ${angles === ANGLES ? "универсальные" : angles === FASHION_ANGLES ? "одежда" : "интерьер"})`,
    details: { sections: recipes.length, distribution: enforced.summary, model },
  };
};
