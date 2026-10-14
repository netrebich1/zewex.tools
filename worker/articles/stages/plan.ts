/**
 * Этап `plan` (шаг 15 оригинала, stage-photo-plan/index.ts): один вызов ИИ по отобранным фото —
 * порядок фото (1 фото = 1 секция), H2 и бриф каждой секции, H1/title/description/slug, план вступления,
 * заключения и ухода. Результат: ArtPhoto.position, Article.plan (ArticlePlan), ArtSection 0 / 1..N / 9990.
 * Мосты оригинала (outfits, generated_images, workflow_stages 64/55) не нужны: план секции и ссылка на фото
 * лежат прямо в ArtSection (аудит 03, §8 «15 + 65»).
 */
import { prisma } from "@/lib/db";
import type { ArtPhoto, ArtSection } from "@prisma/client";
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import { aiChat } from "@/lib/articles/ai";
import { SLOTS, type ArticlePlan } from "@/lib/articles/types";
import { resolvePrompt, fillPrompt, stageModel } from "@/lib/articles/prompts";
import { sanitizeTopic, stripInternalLabels, uniqueHeading } from "@/lib/articles/text/textGuards";
import { ensureCountToken } from "@/lib/articles/text/countToken";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { slugify } from "@/lib/articles/text/slug";
import { OUTRO_HEADING } from "@/lib/articles/text/html";
import { buildPromptVars, contractsFor, focusKeywordOf, isOutfitsNiche, loadProfile, topicOf, type JsonRecord } from "@/lib/articles/text/vars";
import { isInteriorNiche } from "@/lib/articles/photo/contracts";
import type { ArtStageCtx, ArtStageHandler } from "./index";

/** Позиции служебных секций (оригинал: section_number 0 — intro, 9990 — outro). */
export const INTRO_POS = 0;
export const OUTRO_POS = 9990;
/** Секции с фото — position 1..MAX_PHOTO_POS-1 */
export const MAX_PHOTO_POS = 9000;

const STAGE_KEY = "rp_photo_plan";

export async function loadActivePhotos(articleId: string): Promise<ArtPhoto[]> {
  return prisma.artPhoto.findMany({ where: { articleId, excluded: false }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
}

export async function loadPhotoSections(articleId: string): Promise<ArtSection[]> {
  return prisma.artSection.findMany({ where: { articleId, position: { gte: 1, lt: MAX_PHOTO_POS } }, orderBy: { position: "asc" } });
}

export function briefOf(sec: Pick<ArtSection, "brief">): JsonRecord {
  return (sec.brief && typeof sec.brief === "object" ? sec.brief : {}) as JsonRecord;
}

export function isWritten(sec: Pick<ArtSection, "status" | "html" | "wordCount">): boolean {
  return sec.status === "written" && !!sec.html?.trim() && sec.wordCount >= 10;
}

function asArray(v: unknown): JsonRecord[] {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as JsonRecord[];
  if (v && typeof v === "object") return [v as JsonRecord];
  return [];
}

export type PlannerCall = {
  stageKey: string;
  slot: typeof SLOTS.textFast | typeof SLOTS.textMain;
  system: string;
  user: string;
  maxTokens: number;
  /** Температуры попыток (оригинал 15: 0.7 → 0.3; 16: 0.8 → 0.3) */
  temps: number[];
  /** Достать список из ответа; пусто — ответ отвергается */
  pickList: (out: JsonRecord) => JsonRecord[];
};

/**
 * Две попытки планировщика: не-JSON или пустой список → повтор с меньшей температурой и жёсткой инструкцией;
 * временная ошибка провайдера → пауза и повтор, вторая — наверх (раннер вернёт статью в очередь).
 * Цепочки провайдеров и дедлайн 105 с оригинала не переносим (правило 3).
 */
export async function callPlanner(ctx: ArtStageCtx, call: PlannerCall): Promise<{ out: JsonRecord; list: JsonRecord[]; model: string | null }> {
  let lastWhy = "";
  for (let i = 0; i < call.temps.length; i++) {
    await ctx.tick(`Запрос к модели (${i + 1}/${call.temps.length})`);
    try {
      const r = await aiChat(ctx.ai, {
        slot: call.slot,
        model: stageModel(ctx.recipe, call.stageKey),
        system: call.system,
        user: call.user + (lastWhy ? '\n\nReturn ONLY one valid JSON object with key "sections". No prose, no markdown.' : ""),
        json: true,
        temperature: call.temps[i],
        maxTokens: call.maxTokens,
        timeoutMs: 240_000,
      });
      const out = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as JsonRecord | null;
      if (!out) {
        lastWhy = "Модель вернула не-JSON ответ";
        continue;
      }
      const list = call.pickList(out);
      if (list.length) return { out, list, model: r.model };
      lastWhy = "В ответе модели нет списка секций (ключ sections)";
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "transient" && i + 1 < call.temps.length) {
        lastWhy = `Временная ошибка провайдера: ${e.message}`;
        ctx.log(lastWhy);
        await new Promise((r) => setTimeout(r, backoffMs(i)));
        continue;
      }
      throw e;
    }
  }
  throw new Error(lastWhy || "План не получен");
}

/** Детали образа/интерьера для брифа секции из фактов фото и контракта (оригинал: stage-photo-plan:409-444). */
function detailsFor(p: JsonRecord, plan: JsonRecord, facts: JsonRecord, fashion: JsonRecord | null, interior: JsonRecord | null): JsonRecord {
  const out: JsonRecord = {};
  if (interior) {
    out.interior_details = p.interior_details || plan.interior_details || {
      decor_mode: interior.decor_mode,
      hero_element: facts.hero_element || interior.hero_element || null,
      room: facts.room || interior.room || null,
      zone: facts.zone || null,
      setting: facts.setting || interior.setting || null,
      style: facts.style || interior.style || null,
      palette: facts.palette || interior.palette || null,
      materials: facts.materials || interior.materials || null,
      key_pieces: facts.key_pieces || null,
      lighting: facts.lighting || null,
      layout: facts.layout || null,
      visual_anchor: facts.standout || null,
    };
  }
  if (fashion) {
    out.fashion_details = p.fashion_details || plan.fashion_details || {
      outfit_mode: fashion.outfit_mode || null,
      hero_piece: facts.hero_piece || fashion.hero_piece || null,
      outfit_pieces: facts.layers || null,
      shoes: facts.shoes || null,
      accessories: facts.accessories || null,
      palette: facts.palette || null,
      silhouette: facts.silhouette || null,
      occasion: facts.occasion || fashion.occasion || null,
      audience: fashion.audience || null,
      season: fashion.season || null,
      style: fashion.style || null,
      body_context: fashion.body_context || null,
      visual_anchor: facts.standout || null,
    };
  }
  return out;
}

export const plan: ArtStageHandler = async (ctx) => {
  const { article, recipe } = ctx;
  const photos = await loadActivePhotos(article.id);
  if (!photos.length) return { fatal: "Нет отобранных фото — сначала нужен этап «Отбор»" };

  // Идемпотентность (оригинал: 117-126): если секции уже написаны — план не переписываем и тексты не трогаем.
  const existing = await prisma.artSection.findMany({ where: { articleId: article.id } });
  const written = existing.filter((s) => s.position >= 1 && s.position < MAX_PHOTO_POS && isWritten(s));
  if (written.length > 0) {
    if (!ctx.plan?.sections?.length) return { fatal: `Есть ${written.length} написанных секций, но план статьи пуст — сбросьте секции статьи и запустите этап заново` };
    return { summary: `План уже есть, написано секций: ${written.length} — пропуск`, details: { skipped: true } };
  }

  const profile = await loadProfile(ctx);
  const { fashion: fashionC, interior: interiorC } = contractsFor(ctx);
  const fashion = fashionC ? (fashionC as unknown as JsonRecord) : null;
  const interior = interiorC ? (interiorC as unknown as JsonRecord) : null;
  const prompt = await resolvePrompt(recipe, STAGE_KEY);
  const vars = await buildPromptVars(ctx, { photos, profile });
  const filled = fillPrompt(prompt, vars);

  const { out, list: planned, model } = await callPlanner(ctx, {
    stageKey: STAGE_KEY,
    slot: SLOTS.textFast,
    system: filled.system,
    user: filled.user,
    maxTokens: 16000,
    temps: [0.7, 0.3], // оригинал: stage-photo-plan:198-201
    pickList: (o) => asArray(o.sections || o.designs || o.items),
  });

  // Сопоставляем план с фото: photo_n → фото, порядок по position (оригинал: 237-258).
  const used = new Set<number>();
  type Mapped = { plan: JsonRecord; photo: ArtPhoto; order: number };
  const mapped: Mapped[] = [];
  planned.forEach((sec, i) => {
    let n = Number(sec.photo_n ?? sec.photo ?? sec.n ?? 0);
    if (!n || n < 1 || n > photos.length || used.has(n)) {
      n = 0;
      for (let k = 1; k <= photos.length; k++) if (!used.has(k)) { n = k; break; }
    }
    if (!n) return;
    used.add(n);
    mapped.push({ plan: sec, photo: photos[n - 1], order: Number(sec.position ?? i + 1) || i + 1 });
  });
  // Фото без плана — в конец, чтобы ни одно не потерялось.
  for (let k = 1; k <= photos.length; k++) {
    if (used.has(k)) continue;
    mapped.push({ plan: {}, photo: photos[k - 1], order: mapped.length + 1 });
  }
  mapped.sort((a, b) => a.order - b.order);
  mapped.forEach((m, i) => (m.order = i + 1));

  // Уникальные заголовки: ни одного повтора и почти-дубля (оригинал: 261-274).
  const usedHeadings = new Set<string>();
  const fallbackHeading = isOutfitsNiche(recipe.nicheCode) ? "Outfit Idea" : isInteriorNiche(recipe.nicheCode, recipe.subnicheCode) ? "Room Idea" : "Visual Idea";
  for (const m of mapped) {
    const raw = sanitizeTopic(String(m.plan.h2 || m.plan.name || "").trim());
    const unique = uniqueHeading(raw || fallbackHeading, usedHeadings, { facts: m.photo.facts, description: m.photo.description });
    if (unique !== raw) ctx.log(`секция ${m.order}: заголовок уникализирован «${raw}» → «${unique}»`);
    m.plan.h2 = unique;
    m.plan.name = unique;
  }

  await ctx.tick("Сохранение плана");

  // Мета и планы статьи (оригинал: 393-494). H1 обязан содержать метку количества (как stage77).
  const meta = ((out.meta || out.article_metadata) ?? {}) as JsonRecord;
  const topic = topicOf(ctx);
  const focus = focusKeywordOf(ctx);
  const h1 = ensureCountToken(sanitizeTopic(meta.h1_title || meta.title || topic));
  const title = sanitizeTopic(meta.seo_title || meta.h1_title || h1) || h1;
  let metaDescription = stripInternalLabels(String(meta.meta_description || ""), article.keyword).trim();
  if (metaDescription.length > 400) metaDescription = metaDescription.slice(0, 397).trim() + "...";
  const slug = slugify(sanitizeTopic(meta.url_slug || meta.h1_title || focus)) || slugify(h1 || focus || "article");
  const personality = String(meta.article_personality || recipe.text?.personality || "wry");

  const toStr = (v: unknown) => (v == null ? undefined : typeof v === "string" ? v : JSON.stringify(v));

  const sections: NonNullable<ArticlePlan["sections"]> = mapped.map((m) => {
    const p = m.plan;
    const sp = ((p.section_plan || p.plan) ?? {}) as JsonRecord;
    const { section_plan: _sp, plan: _pl, ...rest } = p;
    void _sp; void _pl;
    const pf = (m.photo.facts && typeof m.photo.facts === "object" ? m.photo.facts : {}) as JsonRecord;
    const brief: JsonRecord = {
      ...rest,
      ...sp,
      h2_draft: String(p.h2 || sp.h2_draft || p.name || `Photo ${m.order}`),
      name: String(p.name || p.h2 || `Photo ${m.order}`),
      seo_keyword: p.seo_keyword ?? null,
      keywords_to_bold: asArrayOfStrings(sp.keywords_to_bold ?? p.keywords_to_bold),
      section_angle: sp.section_angle ?? p.section_angle ?? p.angle ?? null,
      role: p.role || "standard",
      outfit_mode: fashion?.outfit_mode ?? p.outfit_mode ?? null,
      decor_mode: interior?.decor_mode ?? p.decor_mode ?? null,
      ...detailsFor(p, sp, pf, fashion, interior),
      format: sp.format ?? p.format ?? null,
      register: sp.register ?? p.register ?? null,
      photo_id: m.photo.id,
    };
    return { position: m.order, photoId: m.photo.id, heading: String(p.h2), brief };
  });

  const articlePlan: ArticlePlan = {
    ...(ctx.plan ?? {}),
    h1,
    title,
    metaDescription,
    slug,
    introPlan: toStr(out.intro_plan),
    outroPlan: toStr(out.outro_plan),
    carePlan: toStr(out.how_to_care ?? out.care_plan),
    order: mapped.map((m) => m.photo.id),
    sections,
    meta: { theme: meta.theme ?? null, hook: meta.hook ?? null, article_personality: personality },
    personality,
    orderingStrategy: String(out.ordering_strategy || ""),
    secondaryKeywords: sections.map((x) => String((x.brief as JsonRecord).seo_keyword || "").trim()).filter(Boolean),
    plannedBy: STAGE_KEY,
    plannerModel: model,
  };

  // Порядок фото и секции — в одной транзакции. Секции без текста пересоздаются; написанных здесь нет (см. выше).
  await prisma.$transaction(async (tx) => {
    for (const m of mapped) {
      await tx.artPhoto.update({ where: { id: m.photo.id }, data: { position: m.order } });
    }
    await tx.artSection.deleteMany({ where: { articleId: article.id } });
    await tx.artSection.createMany({
      data: [
        { articleId: article.id, position: INTRO_POS, heading: "", status: "planned", brief: (out.intro_plan ?? {}) as object },
        ...sections.map((sct) => ({
          articleId: article.id,
          position: sct.position,
          photoId: sct.photoId,
          heading: sct.heading,
          brief: (sct.brief ?? {}) as object,
          status: "planned",
        })),
        { articleId: article.id, position: OUTRO_POS, heading: OUTRO_HEADING, status: "planned", brief: (out.outro_plan ?? {}) as object },
      ],
    });
  });

  await ctx.save({ plan: articlePlan });
  // Черновая мета плана — в статью сразу (этап meta проверит и починит; оригинал: article_drafts h1/seo_title/url_slug на шаге 15).
  await prisma.article.update({ where: { id: article.id }, data: { h1, metaTitle: title, metaDescription, slug } });

  return {
    summary: `План: ${sections.length} секций, H1 «${h1}»`,
    details: { sections: sections.length, photos: photos.length, h1, slug, model },
  };
};

function asArrayOfStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  if (v == null || v === "") return [];
  return [String(v)];
}
