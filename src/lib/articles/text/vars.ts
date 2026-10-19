/**
 * ОДНО место сборки переменных промтов текстовой цепочки (план по фото, план секций, вступление/заключение,
 * писатель секций). В оригинале каждая функция собирала свой словарь, и часть переменных реальных промтов
 * оставалась незаполненной ({{outro_plan}}, {{care_plan}}, {item_name}, {{section_brief}} — аудит 03, §7.1, 7.3, 7.4).
 * Здесь собирается полный словарь из facts / plan / рецепта / фото / секций; этап добавляет свои поля через `extra`.
 * После fillPrompt неизвестных переменных остаться не должно — иначе этап падает с понятной ошибкой (08-plan §3 п.3).
 *
 * Источники (таблицы переменных отчёта 03, §1.2, 1.3, 1.5, 1.6):
 *   topic/focus_keyword/primary_keyword — ключи статьи через sanitizeTopic;
 *   language/target_country — recipe.photoSearch (в оригинале projects.language='en', target_country='US'/'USA');
 *   article_personality — recipe.text.personality → план → "wry"; target_word_count — recipe.text.wordCount → "compact3";
 *   niche_label/topic_kind/subject_label/required_facts/topic_facts/concept_fields — профиль ниши;
 *   outfit_mode/fashion_contract/hero_piece, decor_mode/hero_element/setting/room/style/interior_contract — facts.*Contract;
 *   photos_table/photo_captions/photo_facts_table/images_table/image_context — фото статьи;
 *   intro_plan/outro_plan/care_plan/content_angle/subcategories/trend_details — план (rp_photo_plan);
 *   trend_context — facts.trendBrief; article_context — мета + карта секций; total_outfits — метка {{COUNT}}.
 */
import type { Article, ArtPhoto, ArtSection } from "@prisma/client";
import type { ArticlePlan, ArticleFacts, ArticleRecipeSnapshot } from "@/lib/articles/types";
import { getNicheProfile, specializeProfile, topicKindLabel, subjectLabel, describeAttributes, type NicheProfile } from "@/lib/articles/photo/profile";
import { buildFashionContract, buildInteriorContract, fashionContractPrompt, interiorContractPrompt, isInteriorNiche, type FashionContract, type InteriorContract } from "@/lib/articles/photo/contracts";
import { sanitizeFacts } from "@/lib/articles/photo/factSanitize";
import { sanitizeTopic } from "./textGuards";
import { COUNT_TOKEN } from "./countToken";

export type JsonRecord = Record<string, unknown>;

/** Часть контекста этапа, нужная для переменных (структурно совместима с ArtStageCtx воркера). */
export type VarsCtx = { article: Article; recipe: ArticleRecipeSnapshot; facts: ArticleFacts; plan: ArticlePlan | null };

// ───────────────────────── углы и заходы плана секций (оригинал: stage-photo-section-plan:31-46, 311-312) ─────────────────────────

/**
 * Возможные углы подачи секции (универсальные/ногтевые). Аудит text-v2: «personal_story» и «skeptic» заказывали
 * выдуманный опыт («I wore these…», «I was skeptical») — заменены на «how_to_ask» (что сказать мастеру) и
 * «honest_take» (кому не подойдёт). Старые значения в уже сохранённых рецептах секций понимает sections.ts.
 */
export const ANGLES = [
  "photo_read", "how_to_ask", "mistake", "comparison", "who_suits", "wear_reality",
  "cost_time", "seasonal", "technique", "diy_howto", "honest_take",
] as const;
/** Заходы первой фразы (без «confession»/«reaction» — они тянули первое лицо и выдумки). */
export const OPENERS = ["observation", "verdict", "question", "fact", "rule", "contrast"] as const;
export const FASHION_ANGLES = ["proportion", "layering", "wearability", "seasonality", "formality", "comfort_tradeoff", "closet_vs_buy", "styling_variation"];
export const INTERIOR_ANGLES = ["layout", "palette", "materials", "lighting", "storage", "budget_swap", "renter_friendly", "styling_variation", "durability", "scale_and_proportion"];

export function isOutfitsNiche(nicheCode: string): boolean {
  return nicheCode === "outfits";
}

function asContract<T extends object>(raw: unknown): T | null {
  return raw && typeof raw === "object" && "hard_requirements" in (raw as object) ? (raw as T) : null;
}

/**
 * Контракты темы: из facts (их пишет фото-цепочка), иначе строятся из ключа и атрибутов — как в оригинале
 * (stage-photo-plan:149-154: buildFashionContract для ниши outfits, buildInteriorContract для interior/decor/outdoor).
 * Модуль контрактов — общий с фото-цепочкой (`@/lib/articles/photo/contracts`).
 */
export function contractsFor(ctx: VarsCtx): { fashion: FashionContract | null; interior: InteriorContract | null } {
  const { recipe, facts, article } = ctx;
  const attrs = (facts.keywordAttributes ?? null) as Record<string, unknown> | null;
  const kw = article.focusKeyword || article.keyword || "";
  const fashion = isOutfitsNiche(recipe.nicheCode) ? asContract<FashionContract>(facts.fashionContract) ?? buildFashionContract(kw, attrs) : asContract<FashionContract>(facts.fashionContract);
  const interior = isInteriorNiche(recipe.nicheCode, recipe.subnicheCode) ? asContract<InteriorContract>(facts.interiorContract) ?? buildInteriorContract(kw, attrs) : asContract<InteriorContract>(facts.interiorContract);
  return { fashion, interior };
}

/** Список углов, который реально уходит в промт плана секций: по нему же валидируется ответ (аудит 03, §7.3). */
export function anglesFor(ctx: VarsCtx): readonly string[] {
  const { fashion, interior } = contractsFor(ctx);
  if (fashion) return FASHION_ANGLES;
  if (interior) return INTERIOR_ANGLES;
  return ANGLES;
}

function s(v: unknown, fallback = "none"): string {
  const t = String(v ?? "").trim();
  return t || fallback;
}

// ───────────────────────── профиль ниши ─────────────────────────

/** Профиль ниши рецепта, уточнённый под тему (волосы: стрижка/цвет/причёска). */
export async function loadProfile(ctx: VarsCtx): Promise<NicheProfile> {
  const base = await getNicheProfile(ctx.recipe.nicheCode, ctx.recipe.subnicheCode ?? null);
  return specializeProfile(base, topicText(ctx));
}

export function topicText(ctx: VarsCtx): string {
  return `${ctx.article.focusKeyword || ""} ${ctx.article.keyword || ""}`.trim();
}

/** Фокусный ключ статьи: focusKeyword → seoKeyword → keyword (оригинал: project.focus_keyword || seo_keyword). */
export function focusKeywordOf(ctx: VarsCtx): string {
  return sanitizeTopic(ctx.article.focusKeyword || ctx.article.seoKeyword || ctx.article.keyword);
}

/** Тема статьи (оригинал: project.topic || project.name = строка очереди). */
export function topicOf(ctx: VarsCtx): string {
  return sanitizeTopic(ctx.article.keyword);
}

// ───────────────────────── таблицы фото ─────────────────────────

/**
 * Факты одной строкой «key: value; …». Заглушки и копии описаний полей схемы («visible execution quality…»,
 * «none», «any») выбрасываются — так чистятся и факты, записанные в базу до правки (аудит text-v3, §3).
 */
export function factsLine(facts: unknown): string {
  const clean = sanitizeFacts(facts);
  if (!clean) return "";
  return Object.entries(clean)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

/** `n. photo_id | domain | score | description | facts(JSON)` (оригинал: stage-photo-plan:141-146). */
export function photosTable(photos: ArtPhoto[]): string {
  return photos
    .map((p, i) => `${i + 1}. photo_id: ${p.id} | domain: ${p.sourceDomain || "-"} | score: ${p.aiScore ?? "-"} | description: ${p.description || p.altText || "(no description)"} | facts: ${JSON.stringify(sanitizeFacts(p.facts) ?? {})}`)
    .join("\n");
}

/** `N. H2: … \n FACTS: key: value; …` (оригинал: stage-photo-section-plan:276-286). */
export function photoFactsTable(sections: Array<Pick<ArtSection, "position" | "heading" | "brief">>, photoById: Map<string, ArtPhoto>, photoIdOf: (sec: Pick<ArtSection, "position" | "heading" | "brief"> & { photoId?: string | null }) => string | null): string {
  return sections
    .map((sec) => {
      const pid = photoIdOf(sec);
      const photo = pid ? photoById.get(pid) : undefined;
      const b = (sec.brief ?? {}) as JsonRecord;
      const line = factsLine(photo?.facts) || photo?.description || "(no photo facts)";
      return `${sec.position}. H2: ${sec.heading || String(b.h2_draft || "-")}\n   FACTS: ${line}`;
    })
    .join("\n");
}

// ───────────────────────── план → переменные ─────────────────────────

function asText(v: unknown, fallback = "none"): string {
  if (v == null) return fallback;
  if (typeof v === "string") return v.trim() || fallback;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const str = JSON.stringify(v, null, 2);
  return str && str !== "{}" && str !== "[]" ? str : fallback;
}

function planObject(v: unknown): JsonRecord | null {
  if (!v) return null;
  if (typeof v === "object") return v as JsonRecord;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" ? (p as JsonRecord) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Черновик абзаца плана: строка или {text|draft}. (оригинал: stage7-write-intro:207-216) */
function extractDraft(field: unknown, fallbackField?: unknown): string {
  if (typeof field === "string" && field.length > 5) return field;
  const f = field as JsonRecord | null;
  if (f && typeof f.text === "string") return f.text;
  if (f && typeof f.draft === "string") return f.draft;
  if (typeof fallbackField === "string" && fallbackField.length > 5) return fallbackField;
  return "none";
}

/** Карта секций для article_context: позиция, H2, ключ секции, роль, вопрос читателя, вынос. */
export function articleMap(plan: ArticlePlan | null, sections?: Array<Pick<ArtSection, "position" | "heading" | "brief" | "status">>): JsonRecord[] {
  const fromDb = (sections ?? []).filter((x) => x.position >= 1 && x.position < 9000);
  const src: Array<{ position: number; heading: string; brief: JsonRecord; status?: string }> = fromDb.length
    ? fromDb.map((x) => ({ position: x.position, heading: x.heading, brief: (x.brief ?? {}) as JsonRecord, status: x.status }))
    : (plan?.sections ?? []).map((x) => ({ position: x.position, heading: x.heading, brief: (x.brief ?? {}) as JsonRecord }));
  return src.map((x) => {
    const r = (x.brief.recipe ?? {}) as JsonRecord;
    return {
      section_number: x.position,
      h2: x.heading,
      seo_keyword: x.brief.seo_keyword ?? null,
      narrative_role: r.narrative_role ?? x.brief.role ?? null,
      reader_question: r.reader_question ?? null,
      primary_takeaway: r.primary_takeaway ?? null,
      ...(x.status ? { status: x.status } : {}),
    };
  });
}

export type PromptVarsInput = {
  /** Активные фото статьи по позиции (для photos_table / scene_context) */
  photos?: ArtPhoto[];
  /** Все секции с фото статьи (position 1..N) — карта статьи, таблица фактов */
  sections?: ArtSection[];
  /** Секции текущей пачки писателя (scene_context, hair_brief, batch_size); пусто — берутся все */
  batch?: ArtSection[];
  /** Уже написанные секции (для previous_ending / previous_batch_summary / article_context) */
  written?: ArtSection[];
  profile?: NicheProfile;
  /** Поля конкретного этапа — перекрывают общие */
  extra?: JsonRecord;
};

/** Сводка написанных секций (оригинал: stage7-write-sections:2056-2073). */
export function previousBatchSummary(written: ArtSection[]): JsonRecord {
  if (!written.length) return { note: "First batch — no previous context", h2_headings_used: [], last_section_ending: null };
  const formatCounts: Record<string, number> = {};
  const headings: string[] = [];
  for (const sec of written) {
    const b = (sec.brief ?? {}) as JsonRecord;
    const f = String(b.format_used || b.format || "");
    if (f) formatCounts[f] = (formatCounts[f] || 0) + 1;
    if (sec.heading) headings.push(sec.heading);
  }
  const last = written[written.length - 1];
  const lb = (last?.brief ?? {}) as JsonRecord;
  return {
    sections_written: written.length,
    format_counts: formatCounts,
    h2_headings_used: headings,
    last_section_format: lb.format_used ?? lb.format ?? null,
    last_section_register: lb.register_used ?? lb.register ?? null,
    last_section_ending: lastParagraph(last?.html),
  };
}

/** Последний абзац написанной секции (≤600 символов) — оригинал 74:154-172 брал последние предложения. */
export function lastParagraph(html: string | null | undefined): string | null {
  const plain = String(html || "").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim();
  if (!plain) return null;
  const paras = plain.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const last = paras[paras.length - 1] || plain;
  return last.length > 600 ? last.slice(-600) : last;
}

export async function buildPromptVars(ctx: VarsCtx, input: PromptVarsInput = {}): Promise<JsonRecord> {
  const { article, recipe, facts, plan } = ctx;
  const profile = input.profile ?? (await loadProfile(ctx));
  const photos = input.photos ?? [];
  const sections = input.sections ?? [];
  const batch = input.batch?.length ? input.batch : sections;
  const written = input.written ?? [];
  const photoById = new Map(photos.map((p) => [p.id, p]));

  const focus = focusKeywordOf(ctx);
  const topic = topicOf(ctx) || focus;
  const planMeta = (plan?.meta ?? {}) as JsonRecord;
  const personality = String(recipe.text?.personality || plan?.personality || planMeta.article_personality || "wry");
  const count = photos.length || sections.filter((x) => x.position >= 1 && x.position < 9000).length || plan?.sections?.length || article.photoCount;

  const { fashion, interior } = contractsFor(ctx);

  const introPlan = planObject(plan?.introPlan) ?? {};
  const outroPlan = planObject(plan?.outroPlan) ?? {};
  const carePlan = planObject(plan?.carePlan) ?? (typeof plan?.carePlan === "string" ? plan.carePlan : null);
  const trendBrief = (facts.trendBrief ?? null) as JsonRecord | null;

  // content_angle / subcategories / trend_details — без fashion-заглушек оригинала (аудит 03, §7.1):
  // угол — тема/крючок плана, группы идей — ключи секций, тренды — план либо тренд-бриф.
  const p2Text = typeof introPlan.p2_answer === "string" ? introPlan.p2_answer : String((introPlan.p2_answer as JsonRecord | undefined)?.text || "");
  const contentAngle = String(planMeta.theme || planMeta.narrative_arc || plan?.orderingStrategy || p2Text.split(".")[0] || "").trim() || "none";
  const sectionKeywords = [...new Set(articleMap(plan, sections.length ? sections : undefined).map((m) => String(m.seo_keyword || "").trim()).filter(Boolean))];
  const subcategories = sectionKeywords.slice(0, 6).join(", ") || "none";
  const trendDetails = Array.isArray(introPlan.trend_details_to_weave) && (introPlan.trend_details_to_weave as unknown[]).length
    ? (introPlan.trend_details_to_weave as unknown[]).map((t) => `- ${String(t)}`).join("\n")
    : Array.isArray(trendBrief?.in) && (trendBrief!.in as unknown[]).length
      ? (trendBrief!.in as unknown[]).map((t) => `- ${String(t)}`).join("\n")
      : "none";
  const forbidden = Array.isArray(introPlan.forbidden_phrases) ? (introPlan.forbidden_phrases as unknown[]).join(", ") : "none";

  const prevSummary = previousBatchSummary(written);
  const map = articleMap(plan, sections.length ? sections : undefined);
  const articleContext: JsonRecord = {
    article_personality: personality,
    focus_keyword: focus,
    meta: { h1: plan?.h1 ?? "", title: plan?.title ?? "", theme: planMeta.theme ?? null, hook: planMeta.hook ?? null, narrative_arc: planMeta.narrative_arc ?? plan?.orderingStrategy ?? null },
    previous_batch_summary: prevSummary,
    article_map: map,
    written_sections: written.map((w) => ({ section_number: w.position, h2: w.heading, summary: String(w.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 280) })),
  };

  const sceneContext = batch.length
    ? batch
        .filter((x) => x.position >= 1 && x.position < 9000)
        .map((x) => {
          const p = x.photoId ? photoById.get(x.photoId) : undefined;
          const d = p?.description || factsLine(p?.facts);
          return d ? `Section ${x.position}: ${d}` : null;
        })
        .filter(Boolean)
        .join("\n") || "none"
    : "none";

  const hairBrief = batch.length
    ? batch
        .filter((x) => x.position >= 1 && x.position < 9000)
        .map((x) => {
          const b = (x.brief ?? {}) as JsonRecord;
          const det = (b.fashion_details ?? b.interior_details ?? b.hair_details) as JsonRecord | undefined;
          const line = det ? factsLine(det) : "";
          return line ? `Section ${x.position}: ${line}` : null;
        })
        .filter(Boolean)
        .join("\n") || "none"
    : "none";

  const vars: JsonRecord = {
    // ключи и тема
    topic,
    focus_keyword: focus || "none",
    primary_keyword: focus || "none",
    item_name: focus || topic,
    niche: recipe.nicheCode || "",
    subniche: recipe.subnicheCode || "",
    language: recipe.photoSearch?.language || "en",
    target_country: recipe.photoSearch?.country || "US",
    article_personality: personality,
    target_word_count: recipe.text?.wordCount || "compact3",
    // профиль ниши
    niche_label: profile.label,
    topic_kind: topicKindLabel(profile, topicText(ctx)),
    subject_label: subjectLabel(profile),
    required_facts: (profile.fact_block?.fields || []).join(", "),
    topic_facts: describeAttributes(profile, (facts.keywordAttributes ?? null) as Record<string, unknown> | null),
    concept_fields: (profile.concept_fields || []).join(", "),
    // контракты
    outfit_mode: s(fashion?.outfit_mode),
    fashion_contract: fashion ? fashionContractPrompt(fashion) : "",
    hero_piece: s(fashion?.hero_piece),
    decor_mode: s(interior?.decor_mode),
    hero_element: s(interior?.hero_element),
    setting: s(interior?.setting),
    room: s(interior?.room),
    style: s(interior?.style ?? fashion?.style),
    interior_contract: interior ? interiorContractPrompt(interior) : "",
    fashion_details: hairBrief,
    interior_details: hairBrief,
    // счётчики
    sections_count: count,
    total_sections: count,
    count_items: count,
    // количество идей — только меткой, число ставится при сборке
    total_outfits: COUNT_TOKEN,
    // фото
    photos_table: photosTable(photos),
    photo_captions: photos.map((p, i) => `${i + 1}. ${p.caption || ""}`).join("\n"),
    photo_facts_table: photoFactsTable(sections.filter((x) => x.position >= 1 && x.position < 9000), photoById, (sec) => (sec as ArtSection).photoId ?? null),
    images_table: photosTable(photos),
    image_context: sceneContext,
    // план статьи
    intro_plan: asText(introPlan),
    outro_plan: asText(outroPlan),
    care_plan: asText(carePlan),
    content_angle: contentAngle,
    subcategories,
    trend_details: trendDetails,
    trend_context: asText(trendBrief, "{}"),
    trend_data: asText(trendBrief, "{}"),
    market_urgency: s(introPlan.market_urgency ?? planMeta.market_urgency, "none"),
    forbidden_phrases: forbidden,
    p1_draft: extractDraft(introPlan.p1_hook, introPlan.hook),
    p2_draft: extractDraft(introPlan.p2_answer, introPlan.answer),
    p3_draft: extractDraft(introPlan.p3_reader ?? introPlan.p3_personal, introPlan.personal),
    p1_pattern: s((introPlan.p1_hook as JsonRecord | undefined)?.pattern, "Concrete trend fact → who it suits → what the reader gets."),
    p1_must_include: "none",
    p3_must_include: "none",
    price_range: "none",
    // контекст статьи и предыдущих пачек
    article_context: articleContext,
    previous_ending: s(prevSummary.last_section_ending),
    previous_batch_summary: prevSummary,
    keywords_bolded_previous: ((prevSummary.h2_headings_used as string[]) || []).join(", ") || "none",
    // планировщик секций
    angles: anglesFor(ctx).join(", "),
    openers: OPENERS.join(", "),
    // писатель (значения по умолчанию; этап задаёт свои через extra)
    batch_number: 1,
    total_batches: 1,
    batch_size: input.batch?.length || count,
    section_briefs: "",
    batch_sections: "",
    section_brief: "",
    hair_brief: hairBrief,
    cut_specs: "none",
    scene_context: sceneContext,
    search_queries_brief: "none",
    section_plans: "",
    section_data: "",
    keywords_to_bold: sectionKeywords.join(", ") || "none",
  };

  return { ...vars, ...(input.extra ?? {}) };
}
