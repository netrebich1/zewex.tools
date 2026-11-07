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
import { MalformedAiOutput } from "@/lib/articles/errors";
import { SLOTS, type ArticlePlan } from "@/lib/articles/types";
import { resolvePrompt, fillPrompt, stageModel } from "@/lib/articles/prompts";
import { sanitizeTopic, stripInternalLabels, uniqueHeading } from "@/lib/articles/text/textGuards";
import { ensureCountToken } from "@/lib/articles/text/countToken";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { slugify } from "@/lib/articles/text/slug";
import { OUTRO_HEADING } from "@/lib/articles/text/html";
import { buildPromptVars, contractsFor, focusKeywordOf, isOutfitsNiche, loadProfile, topicOf, type JsonRecord } from "@/lib/articles/text/vars";
import { isInteriorNiche } from "@/lib/articles/photo/contracts";
import { sanitizeFacts } from "@/lib/articles/photo/factSanitize";
import { describeLatePhotos } from "@/lib/articles/photo/describeLate";
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
 * Попытки планировщика (не меньше PLANNER_TRIES): не-JSON или пустой список → повтор с меньшей температурой
 * и поправкой, где названо, что не так с прошлым ответом; временная ошибка провайдера → пауза и повтор, на последней
 * попытке — наверх (раннер повторит этап с растущей паузой). Все попытки дали ответ не того формата →
 * MalformedAiOutput: раннер отложит этап и попробует ещё (до 3 раз), а не уронит статью с первого плохого ответа
 * (прод: «В ответе модели нет списка секций (ключ sections)»).
 * Цепочки провайдеров и дедлайн 105 с оригинала не переносим (правило 3).
 */
const PLANNER_TRIES = 3;

export async function callPlanner(ctx: ArtStageCtx, call: PlannerCall): Promise<{ out: JsonRecord; list: JsonRecord[]; model: string | null }> {
  const temps = [...call.temps];
  while (temps.length < PLANNER_TRIES) temps.push(temps[temps.length - 1] ?? 0.3);
  let lastWhy = "";
  let lastFormat = "";
  for (let i = 0; i < temps.length; i++) {
    await ctx.tick(`Запрос к модели (${i + 1}/${temps.length})`);
    try {
      const r = await aiChat(ctx.ai, {
        slot: call.slot,
        model: stageModel(ctx.recipe, call.stageKey),
        system: call.system,
        user:
          call.user +
          (lastFormat
            ? `\n\nIMPORTANT: your previous answer was rejected (${lastFormat}). Return ONLY one valid JSON object with key "sections" holding a non-empty array — one entry per section. No prose, no markdown.`
            : ""),
        json: true,
        temperature: temps[i],
        maxTokens: call.maxTokens,
        timeoutMs: 240_000,
      });
      const out = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as JsonRecord | null;
      if (!out) {
        lastWhy = "Модель вернула не-JSON ответ";
        lastFormat = "it was not valid JSON";
        ctx.log(`попытка ${i + 1}: ${lastWhy}`);
        continue;
      }
      const list = call.pickList(out);
      if (list.length) return { out, list, model: r.model };
      lastWhy = "В ответе модели нет списка секций (ключ sections)";
      lastFormat = `the "sections" array was missing or empty; keys present: ${Object.keys(out).slice(0, 8).join(", ") || "none"}`;
      ctx.log(`попытка ${i + 1}: ${lastWhy}`);
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "transient" && i + 1 < temps.length) {
        lastWhy = `Временная ошибка провайдера: ${e.message}`;
        ctx.log(lastWhy);
        await new Promise((r) => setTimeout(r, backoffMs(i)));
        continue;
      }
      throw e;
    }
  }
  throw new MalformedAiOutput(`${lastWhy || "План не получен"} (после ${temps.length} попыток)`);
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
  let photos = await loadActivePhotos(article.id);
  if (!photos.length) return { fatal: "Нет отобранных фото — сначала нужен этап «Отбор»" };

  // Идемпотентность (оригинал: 117-126): если секции уже написаны — план не переписываем и тексты не трогаем.
  const existing = await prisma.artSection.findMany({ where: { articleId: article.id } });
  const written = existing.filter((s) => s.position >= 1 && s.position < MAX_PHOTO_POS && isWritten(s));
  if (written.length > 0) {
    if (!ctx.plan?.sections?.length) return { fatal: `Есть ${written.length} написанных секций, но план статьи пуст — сбросьте секции статьи и запустите этап заново` };
    return { summary: `План уже есть, написано секций: ${written.length} — пропуск`, details: { skipped: true } };
  }

  const profile = await loadProfile(ctx);

  // Позднее описание фото (cost-fixes-b): тонко оценённым (rateMode=slim) и фото без фактов — факты и описание
  // пачками до планирования; при полной оценке с фактами ничего не делает. Расход — в окне этапа plan.
  // Мешап-статьи (Article Copy) приходят без описаний: каждый кадр описывается заново и по одному — так описание точно про этот файл.
  const isCopy = !!(ctx.cursor as Record<string, unknown>).copy;
  const late = await describeLatePhotos({ ai: ctx.ai, recipe, signal: ctx.signal, tick: ctx.tick, log: ctx.log, single: isCopy }, photos, profile, focusKeywordOf(ctx) || article.keyword);
  if (late.described) {
    photos = await loadActivePhotos(article.id);
    ctx.log(`позднее описание: ${late.described} из ${late.needed} фото, ${late.calls} вызовов, $${late.costUsd.toFixed(4)}`);
  }
  // Мешап: коллажи и кадры, которые так и не описались, в статью не идут (их заголовки получались общими и неверными),
  // если после этого остаётся не меньше 15 фото.
  if (isCopy) {
    const COLLAGE = /^collage:|\b(collage|grid of|montage|split[- ]image|split[- ]screen|before[- ]and[- ]after|multiple (women|people|models|hands|looks|photos|images|angles)|(two|three|four|several|both) (women|girls|ladies|models|people|hands|sets|looks|outfits|hairstyles|photos|images|views|angles|versions)|side[- ]by[- ]side|different (hairstyles|looks|outfits|women) (are |is )?(shown|pictured)|(left|right) (photo|image|side) shows|on the left\b.*\bon the right)\b/i;
    const drop = photos.filter((p) => COLLAGE.test(p.description ?? "") || !String(p.description ?? "").trim());
    if (drop.length && photos.length - drop.length >= 15) {
      await prisma.artPhoto.updateMany({ where: { id: { in: drop.map((p) => p.id) } }, data: { excluded: true } });
      ctx.log(`мешап: исключены ${drop.length} фото (коллаж или без описания): ${drop.map((p) => p.position).join(", ")}`);
      photos = await loadActivePhotos(article.id);
    }
  }
  const describedNote = late.needed ? `; описаны ${late.described} фото${late.failed ? ` (без описания ${late.failed})` : ""}` : "";

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

  // Страховка от перепутанных photo_n (аудит мешап-статей 07.11.2026: модель вернула номера со сдвигом, и заголовки
  // «сели» на чужие фото). План секции сверяется с описанием её фото по словам; если две секции явно лучше подходят
  // к фото друг друга — меняем их фото местами. Порядок статьи (order) не трогаем.
  const swapped = repairPhotoMapping(mapped);
  if (swapped) ctx.log(`план: ${swapped} секц. перепривязаны к своим фото по описанию (модель перепутала photo_n)`);

  // Мешап: план отвечает за разнообразие заголовков. Код проверяет квоты (первое слово, «with», слово темы) и одним
  // дешёвым вызовом переписывает только нарушившие заголовки (владелец 07.11: «план мы делаем, чтобы таких моментов не было»).
  if (isCopy) {
    const fixed = await enforceHeadingVariety(ctx, mapped.map((m) => ({ plan: m.plan, description: m.photo.description })), focusKeywordOf(ctx) || article.keyword);
    if (fixed) ctx.log(`план: ${fixed} заголовков переписаны ради разнообразия (повтор первого слова, «with», слово темы)`);
  }

  // Уникальные заголовки: ни одного повтора и почти-дубля (оригинал: 261-274).
  const usedHeadings = new Set<string>();
  // Слова ключа не считаются отличительными при сравнении заголовков (аудит 2026-10-14).
  const headingKw = [article.keyword, article.focusKeyword, article.seoKeyword].filter(Boolean).join(" ");
  const fallbackHeading = isOutfitsNiche(recipe.nicheCode) ? "Outfit Idea" : isInteriorNiche(recipe.nicheCode, recipe.subnicheCode) ? "Room Idea" : "Visual Idea";
  for (const m of mapped) {
    const raw = sanitizeTopic(String(m.plan.h2 || m.plan.name || "").trim());
    const unique = uniqueHeading(raw || fallbackHeading, usedHeadings, { facts: m.photo.facts, description: m.photo.description, keyword: headingKw });
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
    // Факты фото без заглушек и копий описаний полей (аудит text-v3): в детали образа не попадёт «shoes: none».
    const pf = (sanitizeFacts(m.photo.facts) ?? {}) as JsonRecord;
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
    summary: `План: ${sections.length} секций, H1 «${h1}»${describedNote}`,
    details: { sections: sections.length, photos: photos.length, h1, slug, model, describedPhotos: late.described, describeCalls: late.calls, describeCostUsd: late.costUsd },
  };
};

function asArrayOfStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  if (v == null || v === "") return [];
  return [String(v)];
}

/* ───────── Сверка плана секции с описанием фото ───────── */

const STOP = new Set(["the", "and", "with", "for", "that", "this", "are", "has", "have", "from", "into", "over", "onto", "nails", "nail", "hair", "outfit", "outfits", "photo", "shows", "features", "feature", "style", "look", "design", "designs", "each", "all", "its", "their", "one", "two", "some", "very", "finish", "glossy", "length", "medium", "long", "short"]);
const words = (v: unknown): Set<string> => {
  const text = typeof v === "string" ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>).filter((x) => typeof x === "string").join(" ") : "";
  return new Set((text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
};
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
};

/**
 * Меняет фото местами у пар секций, когда обе секции заметно ближе к описанию фото друг друга, чем к своему.
 * Возвращает число затронутых секций. Консервативно: порог 0.2 суммарного выигрыша, не больше N проходов.
 */
const HEADING_PATTERNS = ["detail_first", "situation", "effect", "reader", "quieter_or_bolder", "number", "time", "verb_first"];
const firstWord = (h: string) => (h.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z0-9'-]/g, "");

/** Какие заголовки нарушают квоты разнообразия: повтор первого слова, «with» больше трети, слово темы в начале больше трёх раз, одинаковые два последних слова. */
export function headingViolations(h2s: string[], lockWords: string[]): Set<number> {
  const bad = new Set<number>();
  const n = h2s.length;
  const seenFirst = new Map<string, number>();
  const seenTail = new Map<string, number>();
  let withCount = 0, lockStarts = 0;
  const withMax = Math.ceil(n / 3), lockMax = 3;
  h2s.forEach((h, i) => {
    const words = h.toLowerCase().split(/\s+/).filter(Boolean);
    const f = firstWord(h);
    if (!words.length) return;
    if (seenFirst.has(f)) bad.add(i); else seenFirst.set(f, i);
    const tail = words.slice(-2).join(" ");
    if (words.length >= 4 && seenTail.has(tail)) bad.add(i); else seenTail.set(tail, i);
    if (words.includes("with")) { withCount++; if (withCount > withMax) bad.add(i); }
    if (lockWords.some((w) => w && words.slice(0, 2).includes(w))) { lockStarts++; if (lockStarts > lockMax) bad.add(i); }
  });
  return bad;
}

/** Переписать нарушившие заголовки одним вызовом модели плана; вернуть число изменённых. */
export async function enforceHeadingVariety(ctx: ArtStageCtx, items: Array<{ plan: JsonRecord; description: string | null }>, focusKeyword: string): Promise<number> {
  const lockWords = focusKeyword.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !/^20\d\d$/.test(w));
  const h2s = items.map((it) => String(it.plan.h2 || "").trim());
  const bad = headingViolations(h2s, lockWords);
  if (!bad.size) return 0;
  const usedFirst = new Set(h2s.filter((_, i) => !bad.has(i)).map(firstWord));
  const list = items.map((it, i) => ({ n: i + 1, h2: h2s[i], rewrite: bad.has(i), pattern: bad.has(i) ? HEADING_PATTERNS[i % HEADING_PATTERNS.length] : String(it.plan.h2_pattern || ""), facts: String(it.description || "").slice(0, 320) }));
  const system = `You fix the headings of a photo-led article so that no two sections look alike. Rewrite ONLY the entries marked rewrite:true, keep the others untouched. Each rewritten heading: 5-9 words, sentence case (first word and proper nouns capitalized), no colon, dash or year, written in the given pattern (detail_first: the detail a reader notices first, then the base; situation: the idea for a reader situation; effect: what the idea does; reader: "When you want X without Y"; quieter_or_bolder: a take relative to the topic; number: a count leads; time: how it lives through the week; verb_first: a gerund opens). Every content word must come from that section's facts or from the topic "${focusKeyword}". The first word of a rewritten heading must differ from every other heading's first word and must not be one of: ${[...usedFirst].join(", ")}. Avoid the word "with" and do not start with the topic noun. No praise words. Return JSON only: {"headings":[{"n":1,"h2":"..."}]} for the rewritten entries.`;
  try {
    const r = await aiChat(ctx.ai, { slot: SLOTS.textFast, model: stageModel(ctx.recipe, STAGE_KEY), system, user: JSON.stringify({ topic: focusKeyword, sections: list }), json: true, temperature: 0.7, maxTokens: 3000, timeoutMs: 120_000 });
    const out = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as JsonRecord | null;
    const rows = asArray(out?.headings) as JsonRecord[];
    let changed = 0;
    const taken = new Set(usedFirst);
    for (const row of rows) {
      const i = Number(row.n) - 1;
      const h2 = String(row.h2 || "").trim().replace(/[—–:]/g, ",").replace(/\s+/g, " ");
      if (!bad.has(i) || !h2 || h2.split(" ").length < 4 || h2.split(" ").length > 12) continue;
      const f = firstWord(h2);
      if (taken.has(f)) continue;
      taken.add(f);
      items[i].plan.h2 = h2;
      items[i].plan.name = h2;
      items[i].plan.h2_pattern = list[i].pattern;
      changed++;
    }
    return changed;
  } catch (e) {
    ctx.log(`разнообразие заголовков: вызов не удался (${e instanceof Error ? e.message : String(e)}), оставляем заголовки плана`);
    return 0;
  }
}

export function repairPhotoMapping(mapped: Array<{ plan: Record<string, unknown>; photo: { id: string; description: string | null; facts: unknown } }>): number {
  const sec = mapped.map((m) => words([m.plan.h2, m.plan.description, m.plan.visual_anchor, m.plan.ask_for, m.plan.art_technique, m.plan.outfit_summary, m.plan.room_summary].filter(Boolean).join(" ")));
  const pho = mapped.map((m) => words(`${m.photo.description ?? ""} ${Object.values((m.photo.facts as Record<string, unknown> | null) ?? {}).filter((x) => typeof x === "string").join(" ")}`));
  const sim = (i: number, j: number) => jaccard(sec[i], pho[j]);
  const touched = new Set<number>();
  for (let pass = 0; pass < mapped.length; pass++) {
    let best: { i: number; j: number; gain: number } | null = null;
    for (let i = 0; i < mapped.length; i++) {
      for (let j = i + 1; j < mapped.length; j++) {
        const gain = sim(i, j) + sim(j, i) - sim(i, i) - sim(j, j);
        if (gain > 0.2 && (!best || gain > best.gain)) best = { i, j, gain };
      }
    }
    if (!best) break;
    [mapped[best.i].photo, mapped[best.j].photo] = [mapped[best.j].photo, mapped[best.i].photo];
    [pho[best.i], pho[best.j]] = [pho[best.j], pho[best.i]];
    touched.add(best.i); touched.add(best.j);
  }
  return touched.size;
}
