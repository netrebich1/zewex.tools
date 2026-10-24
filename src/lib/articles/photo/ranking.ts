/**
 * Формулы и правила вердикта конца фото-цепочки:
 *  - технический балл и итоговый ранг кадра (порт _shared/photoQuality.ts);
 *  - ai_quality (взвешенное качество 0–100) и логика вердикта шага оценки (порт stage-photo-rate/index.ts:724-858);
 *  - структурированный класс отказа `reject_class` вместо регэкспа по русскому тексту (аудит 02 §8, 08-plan §3 п.5);
 *  - баллы шага сравнения кадров (порт stage-photo-rank/index.ts:245, :267-274).
 *
 * У нас нет отдельных колонок ai_quality / ai_reason / beauty_note: всё это лежит в `ArtPhotoCandidate.aiBreakdown`
 * (тип `AiBreakdown` ниже), `aiScore` = балл 0–10 (0, если тема/аудитория не подтверждена), `relevance` = сырой
 * балл модели ×10 (0–100) до обнуления чек-листом, `rankScore` = `finalPhotoRank`.
 */
import type { Article, ArtPhotoCandidate } from "@prisma/client";
import { sanitizeFacts } from "./factSanitize";

/**
 * Тема оценки/отбора — то же поле, по которому искали фото (оригинал: photoSearch.resolveSearchKeyword —
 * focus_keyword → keyword → seo_keyword). Пустая строка не бывает: у статьи всегда есть keyword.
 */
export function topicOf(a: Pick<Article, "keyword" | "focusKeyword" | "seoKeyword">): string {
  return String(a.focusKeyword || a.keyword || a.seoKeyword || "").trim();
}

// ─────────────────────────────────────────────────────────────
// Технический балл (оригинал: photoQuality.ts:7-88)
// ─────────────────────────────────────────────────────────────

export interface TechQualityInput {
  width?: number | null;
  height?: number | null;
  /** дисперсия лапласиана из vision.inspectPhotoBytes */
  sharpness?: number | null;
  /** контраст 0–100 */
  contrast?: number | null;
  /** насыщенность 0–100 */
  colorfulness?: number | null;
  /** средняя яркость 0–255 */
  brightness?: number | null;
  /** домен источника */
  domain?: string | null;
}

/** Домены, которые почти всегда дают редакционные кадры (оригинал: :23-27). */
const GOOD_SOURCES = [
  "pinterest", "instagram", "vogue", "elle", "byrdie", "allure", "cosmopolitan",
  "harpersbazaar", "refinery29", "whowhatwear", "glamour", "popsugar", "stylecraze",
  "thecut", "hypebae", "latest-hairstyles", "hairstyleonpoint", "prettydesigns",
];
/** Домены-агрегаторы и магазины: кадр обычно каталожный (оригинал: :29). */
const WEAK_SOURCES = ["amazon", "aliexpress", "ebay", "etsy", "alamy", "shutterstock", "dreamstime", "istockphoto", "walmart", "temu", "shein"];

const clamp = (v: number, min = 0, max = 100) => Math.max(min, Math.min(max, v));

/** Насколько пропорции близки к пинтерест-формату 2:3 (0–1) (оригинал: :34-44). */
function aspectFit(width: number, height: number): number {
  if (!width || !height) return 0.5;
  const ratio = width / height;
  const ideal = 2 / 3;
  if (ratio <= ideal) return clamp(1 - (ideal - ratio) * 1.2, 0.55, 1);
  return clamp(1 - (ratio - ideal) * 0.9, 0.15, 1);
}

/**
 * Итоговый технический балл 0–100: резкость 30, разрешение 20, пропорции 20, контраст 15, цвет 10, экспозиция 5,
 * плюс поправка на репутацию источника (оригинал: photoQuality.ts:51-88).
 */
export function techQualityScore(input: TechQualityInput): number {
  const width = Number(input.width) || 0;
  const height = Number(input.height) || 0;
  const longSide = Math.max(width, height);

  const sharp = Number(input.sharpness) || 0;
  const sharpPart = clamp(Math.sqrt(Math.max(0, sharp) / 400) * 30, 0, 30);
  const resPart = clamp((Math.min(longSide, 1600) / 1600) * 20, 0, 20);
  const aspectPart = aspectFit(width, height) * 20;

  const contrast = Number(input.contrast);
  const contrastPart = Number.isFinite(contrast) ? clamp((Math.min(contrast, 55) / 55) * 15, 0, 15) : 9;
  const colorful = Number(input.colorfulness);
  const colorPart = Number.isFinite(colorful) ? clamp((Math.min(colorful, 45) / 45) * 10, 0, 10) : 6;
  const brightness = Number(input.brightness);
  const exposurePart = Number.isFinite(brightness) ? clamp(5 - Math.abs(140 - brightness) / 28, 0, 5) : 3;

  let score = sharpPart + resPart + aspectPart + contrastPart + colorPart + exposurePart;
  const domain = String(input.domain || "").toLowerCase();
  if (domain) {
    if (GOOD_SOURCES.some((d) => domain.includes(d))) score += 4;
    if (WEAK_SOURCES.some((d) => domain.includes(d))) score -= 8;
  }
  return Math.round(clamp(score) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// Итоговый ранг кадра (оригинал: photoQuality.ts:97-125)
// ─────────────────────────────────────────────────────────────

/**
 * 0–100. Есть сравнение кадров и оценка: 0.55·beauty + 0.2·ai_quality + 0.15·tech + 0.1·(ai_score·10);
 * только beauty: 0.7·beauty + 0.2·tech + 0.1·rel; только ai_quality: 0.7·ai_quality + 0.2·tech + 0.1·rel;
 * ничего: 0.25·tech + 0.1·rel (штрафной ранг). tech по умолчанию 50.
 */
export function finalPhotoRank(row: { beauty_rank?: number | null; ai_quality?: number | null; tech_quality?: number | null; ai_score?: number | null }): number {
  const beauty = Number(row.beauty_rank);
  const aiQuality = Number(row.ai_quality);
  const tech = Number(row.tech_quality);
  const relevance = (Number(row.ai_score) || 0) * 10;
  const techPart = Number.isFinite(tech) ? tech : 50;
  const hasBeauty = row.beauty_rank != null && Number.isFinite(beauty);
  const hasQuality = row.ai_quality != null && Number.isFinite(aiQuality);

  if (hasBeauty && hasQuality) return Math.round((0.55 * beauty + 0.2 * aiQuality + 0.15 * techPart + 0.1 * relevance) * 10) / 10;
  if (hasBeauty) return Math.round((0.7 * beauty + 0.2 * techPart + 0.1 * relevance) * 10) / 10;
  if (hasQuality) return Math.round((0.7 * aiQuality + 0.2 * techPart + 0.1 * relevance) * 10) / 10;
  return Math.round((0.25 * techPart + 0.1 * relevance) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// Разбор vision-оценки в aiBreakdown
// ─────────────────────────────────────────────────────────────

/** Класс отказа — структурная замена регэкспа HARD по русскому тексту (оригинал: stage-photo-rate:435-436). */
export type RejectClass =
  | "audience"        // не та аудитория (жёсткий)
  | "checklist"       // не выполнен пункт чек-листа темы (жёсткий)
  | "no_evidence"     // нет фактов/описания — секцию не написать (жёсткий)
  | "catalogue"       // каталожная подача (жёсткий)
  | "synthetic"       // признаки ИИ-генерации (жёсткий)
  | "child"           // ребёнок при взрослой теме (жёсткий)
  | "people"          // человек в кадре там, где людей быть не должно — интерьер и декор (жёсткий)
  | "dated"           // устаревший стиль (мягкий)
  | "low_virality"    // слабая Pinterest-привлекательность (мягкий)
  | "below_threshold" // модель за keep, но балл ниже порога (мягкий)
  | "model_reject"    // модель сама отклонила (мягкий, если причина не из HARD-списка)
  | "download"        // файла нет на диске
  | "model_failed";   // модель не оценила пачку дважды

/** Содержимое `ArtPhotoCandidate.aiBreakdown` (оригинал: ai_quality_breakdown + ai_quality + ai_reason + beauty_note). */
export type AiBreakdown = {
  virality?: number | null;
  trend?: number | null;
  ai_likelihood?: number | null;
  composition?: number | null;
  lighting?: number | null;
  framing?: number | null;
  trend_reason?: string;
  catalogue?: boolean;
  catalogue_reason?: string;
  ai_artifacts?: string[];
  /** взвешенное качество 0–100 со штрафом за ИИ-вероятность (оригинал: колонка ai_quality) */
  ai_quality?: number | null;
  /** ai_reason оригинала — русская причина (и для keep: короткая причина модели) */
  reason?: string;
  reject_class?: RejectClass | null;
  verdict?: "keep" | "reject";
  topic_ok?: boolean;
  topic_miss?: string;
  subject_age?: string;
  score_threshold?: number;
  /** балл модели как есть (до обнуления по чек-листу) */
  raw_score?: number;
  /** принят промо при нехватке (оригинал: «принято при нехватке фото (балл 6)») */
  promoted?: boolean;
  /** оценён во втором (мягком) проходе */
  rescue?: boolean;
  /** неудачных попыток оценить пачку (оригинал: ai_status retry) */
  attempts?: number;
  /** заметка шага сравнения кадров (оригинал: beauty_note) */
  beauty_note?: string;
  /** предыдущая оценка до второго прохода */
  prev?: Omit<AiBreakdown, "prev"> | null;
  [k: string]: unknown;
};

export function readBreakdown(c: Pick<ArtPhotoCandidate, "aiBreakdown">): AiBreakdown {
  const b = c.aiBreakdown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as AiBreakdown) : {};
}

/** finalPhotoRank по строке кандидата (ai_quality — из aiBreakdown, tech — techScore). */
export function candidateRank(c: Pick<ArtPhotoCandidate, "beautyRank" | "aiScore" | "techScore" | "aiBreakdown">): number {
  const b = readBreakdown(c);
  return finalPhotoRank({ beauty_rank: c.beautyRank, ai_quality: b.ai_quality ?? null, tech_quality: c.techScore, ai_score: c.aiScore });
}

/** Веса ai_quality: виральность — главный критерий формата (оригинал: stage-photo-rate:807-813). */
export const AI_QUALITY_WEIGHTS: Record<string, number> = { virality: 4, trend: 3, composition: 2, framing: 2, lighting: 1 };

/** Пороги вердикта (оригинал: stage-photo-rate:759, :766, :780). */
export const VIRALITY_MIN = 45;
export const TREND_MIN = 40;
export const SYNTHETIC_LIKELIHOOD_MIN = 80;
/** Промо отклонённых при нехватке: балл ≥ 6 (оригинал: :408-416). */
export const PROMO_MIN_SCORE = 6;
/** Нижняя граница порога при нехватке/втором проходе (оригинал: :232-236). */
export const RESCUE_MIN_THRESHOLD = 6;

/** Жёсткие классы: не промотировать и не пересматривать (08-plan §3 п.5; аудит 02 п.7.2, 7.6). */
export const HARD_REJECT_CLASSES: ReadonlySet<RejectClass> = new Set<RejectClass>(["audience", "checklist", "no_evidence", "catalogue", "synthetic", "child", "people", "download", "model_failed"]);

/** Регэксп оригинала по тексту причины (stage-photo-rate:436) — для отказов класса model_reject. */
export const HARD_REASON_RE = /коллаж|надпис|текст|водян|watermark|ии-|ai-|сгенерирован|не соответствует теме|не та тема|педикюр|pedicure|toe|hero piece|central garment|complete outfit|wrong gender|неверн.*пол|product-only|collage|overlay|screenshot|render|mannequin|wrong subject|off-topic|off topic/i;

/** Отказ «жёсткий» — такие кадры не промотируем и не отправляем на второй проход. */
export function isHardReject(b: AiBreakdown): boolean {
  if (b.reject_class && HARD_REJECT_CLASSES.has(b.reject_class)) return true;
  if (b.reject_class === "model_reject" && HARD_REASON_RE.test(String(b.reason || ""))) return true;
  return false;
}

/** Числовой балл 0–100 из ответа модели; null, если не число или ≤0 (оригинал: :791-796). */
export function q100(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

/** Взвешенное качество со штрафом за ИИ-вероятность ≥50 (оригинал: :814-829). */
export function aiQualityOf(b: Pick<AiBreakdown, "virality" | "trend" | "composition" | "framing" | "lighting" | "ai_likelihood">): number | null {
  let qSum = 0, qWeight = 0;
  for (const [key, w] of Object.entries(AI_QUALITY_WEIGHTS)) {
    const value = (b as Record<string, unknown>)[key];
    if (typeof value !== "number") continue;
    qSum += value * w;
    qWeight += w;
  }
  if (!qWeight) return null;
  const aiQuality = Math.round((qSum / qWeight) * 10) / 10;
  const lik = b.ai_likelihood;
  if (typeof lik === "number" && lik >= 50) return Math.max(0, Math.round((aiQuality - (lik - 45) * 0.35) * 10) / 10);
  return aiQuality;
}

/** оригинал: stage-photo-rate:116-126 */
export const FACT_LABELS: Record<string, string> = {
  colors: "Colours",
  shape_length: "Shape & length",
  finish: "Finish",
  decor: "Art & placement",
  craft: "Execution",
  difficulty: "DIY vs salon",
  framing: "Framing",
  occasion: "Reads as",
  standout: "Stands out",
};

/** Оставляем только поля фактов, заданные профилем ниши (оригинал: :94-114). */
export function cleanFacts(raw: unknown, factKeys: string[]): Record<string, string> | null {
  // Заглушки («none», «n/a», «visible») и копии описаний полей схемы не сохраняем (аудит text-v3, §3).
  return sanitizeFacts(raw, null, factKeys);
}

/** Читаемый текст фактов — для писателя и для описания-фолбэка (оригинал: :129-138). */
export function factsToText(facts: Record<string, string>): string {
  return Object.entries(facts)
    .map(([k, v]) => `${FACT_LABELS[k] || k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}: ${v}`)
    .join(". ");
}

export type RatingJudgement = {
  verdict: "keep" | "reject";
  /** 0–10; 0, если тема/аудитория не подтверждена (оригинал: ai_score = topicOk ? score : 0) */
  aiScore: number;
  /** сырой балл модели ×10 (0–100) — соответствие теме по мнению модели */
  relevance: number;
  breakdown: AiBreakdown;
  /** русская причина (оригинал: ai_reason, ≤200) */
  reason: string;
  facts: Record<string, string> | null;
  description: string | null;
  audience: { expected: string | null; seen: string; ok: boolean; subject_age: string };
};

/**
 * Вердикт по одному элементу ответа модели (оригинал: stage-photo-rate/index.ts:724-858, 1:1 по правилам):
 *  checklistOk = requirements ? topic_ok !== false : true; audienceOk; topicOk = оба;
 *  requestedKeep = topicOk && verdict keep && score ≥ порог;
 *  keep = requestedKeep && есть факты/описание && !lowVirality && !dated && !catalogue && !clearlySynthetic && !childInAdultTopic.
 */
export function judgeRatingItem(
  item: Record<string, unknown>,
  opts: { scoreThreshold: number; requirementsCount: number; audienceCode: string | null; adultTopic: boolean; factKeys: string[]; rescue?: boolean; noPeople?: boolean },
): RatingJudgement {
  const score = Math.max(0, Math.min(10, Number(item.score) || 0));
  const checklistOk = opts.requirementsCount
    ? item.topic_ok !== false && String(item.topic_ok ?? "true").toLowerCase() !== "false"
    : true;
  const audienceAnswer = String(item.audience ?? item.ethnicity ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const audienceOk = !opts.audienceCode || audienceAnswer === opts.audienceCode || (opts.audienceCode === "asian" && audienceAnswer === "east_asian");
  const topicOk = checklistOk && audienceOk;
  const modelKeep = String(item.verdict || "").toLowerCase() === "keep";
  const requestedKeep = topicOk && modelKeep && score >= opts.scoreThreshold;
  // Оригинал извлекал факты только при requestedKeep и хранил только для keep (:743-745, :787). Мы извлекаем
  // для всех кадров с подтверждённой темой, за которые модель проголосовала keep: иначе промо «балл ≥ 6»
  // и второй проход отдавали писателю кадры без фактов (аудит 02 п.7.2).
  const extractedFacts = topicOk && modelKeep ? cleanFacts(item.facts ?? item.nail_facts, opts.factKeys) : null;
  let description = String(item.description || item.photo_description || "").trim();
  if (!description && extractedFacts) description = factsToText(extractedFacts);
  // Без проверенных визуальных фактов секцию не написать (оригинал: :752-755).
  const hasVisualEvidence = Boolean(description || extractedFacts);

  const viralityScore = q100(item.virality ?? item.pin_appeal);
  const lowVirality = viralityScore !== null && viralityScore < VIRALITY_MIN;
  const trendScore = q100(item.trend);
  const dated = trendScore !== null && trendScore < TREND_MIN;
  const trendReason = String(item.trend_reason || "").trim().slice(0, 80);
  const catalogue = item.catalogue === true || String(item.catalogue).toLowerCase() === "true";
  const catalogueReason = String(item.catalogue_reason || "").trim().slice(0, 80);
  const aiLikelihoodRaw = Number(item.ai_likelihood);
  const aiLikelihood = Number.isFinite(aiLikelihoodRaw) ? Math.max(0, Math.min(100, Math.round(aiLikelihoodRaw))) : null;
  const aiArtifacts = Array.isArray(item.ai_artifacts) ? (item.ai_artifacts as unknown[]).map((v) => String(v).trim()).filter(Boolean).slice(0, 5) : [];
  const clearlySynthetic = aiLikelihood !== null && aiLikelihood >= SYNTHETIC_LIKELIHOOD_MIN && aiArtifacts.length >= 1;
  const subjectAge = String(item.subject_age || "").toLowerCase();
  const childInAdultTopic = opts.adultTopic && subjectAge === "child";
  // Интерьер и декор: человек в кадре — по полю person_visible или по subject_age (adult/child = человек есть).
  const personVisible = item.person_visible === true || String(item.person_visible).toLowerCase() === "true" || subjectAge === "adult" || subjectAge === "child";
  const peopleInFrame = !!opts.noPeople && personVisible;

  const verdict: "keep" | "reject" = requestedKeep && hasVisualEvidence && !lowVirality && !dated && !catalogue && !clearlySynthetic && !childInAdultTopic && !peopleInFrame ? "keep" : "reject";
  const miss = String(item.topic_miss || "").trim();
  const modelReason = String(item.reason || "").trim();

  // Приоритет причины — как в оригинале (:837-855); класс отказа — его структурный двойник.
  let rejectClass: RejectClass | null = null;
  let reason: string;
  if (!audienceOk) {
    rejectClass = "audience";
    reason = `не та аудитория: в кадре «${audienceAnswer || "не определено"}», нужна «${opts.audienceCode}»`;
  } else if (peopleInFrame) {
    rejectClass = "people";
    reason = `человек в кадре (интерьер и декор — без людей)${modelReason ? `: ${modelReason}` : ""}`;
  } else if (!checklistOk) {
    rejectClass = "checklist";
    reason = `не соответствует теме: ${miss || "не выполнен пункт чек-листа"}`;
  } else if (requestedKeep && !hasVisualEvidence) {
    rejectClass = "no_evidence";
    reason = "нет проверенных визуальных фактов или описания";
  } else if (catalogue) {
    rejectClass = "catalogue";
    reason = `каталожная подача${catalogueReason ? `: ${catalogueReason}` : ""}`;
  } else if (clearlySynthetic) {
    rejectClass = "synthetic";
    reason = `признаки ИИ (${aiLikelihood}/100): ${aiArtifacts.join(", ")}`;
  } else if (dated) {
    rejectClass = "dated";
    reason = `устаревший стиль (${trendScore}/100)${trendReason ? `: ${trendReason}` : ""}`;
  } else if (lowVirality) {
    rejectClass = "low_virality";
    reason = `слабая Pinterest-привлекательность (${viralityScore}/100): ${modelReason || "скучный или невыразительный кадр"}`;
  } else if (childInAdultTopic) {
    // В оригинале отдельной причины нет (попадало item.reason) — добавлена, чтобы класс был виден модератору.
    rejectClass = "child";
    reason = `ребёнок в кадре при взрослой теме${modelReason ? `: ${modelReason}` : ""}`;
  } else if (verdict === "reject") {
    rejectClass = modelKeep && score < opts.scoreThreshold ? "below_threshold" : "model_reject";
    reason = modelReason || (rejectClass === "below_threshold" ? `балл ${score} ниже порога ${opts.scoreThreshold}` : "отклонено моделью");
  } else {
    reason = modelReason;
  }

  const partial = {
    virality: viralityScore,
    trend: trendScore,
    ai_likelihood: aiLikelihood,
    composition: q100(item.composition),
    lighting: q100(item.lighting),
    framing: q100(item.framing),
  };
  const aiQuality = aiQualityOf(partial);
  const breakdown: AiBreakdown = {
    ...partial,
    ...(trendReason ? { trend_reason: trendReason } : {}),
    catalogue,
    ...(catalogueReason ? { catalogue_reason: catalogueReason } : {}),
    ai_artifacts: aiArtifacts,
    ai_quality: aiQuality,
    reason: reason.slice(0, 200),
    reject_class: verdict === "reject" ? rejectClass : null,
    verdict,
    topic_ok: topicOk,
    ...(miss ? { topic_miss: miss } : {}),
    ...(subjectAge ? { subject_age: subjectAge } : {}),
    ...(opts.noPeople ? { person_visible: personVisible } : {}),
    score_threshold: opts.scoreThreshold,
    raw_score: score,
    ...(opts.rescue ? { rescue: true } : {}),
  };

  return {
    verdict,
    aiScore: topicOk ? score : 0,
    relevance: Math.round(score * 10),
    breakdown,
    reason: reason.slice(0, 200),
    facts: extractedFacts,
    description: description ? description.slice(0, 1200) : null,
    audience: { expected: opts.audienceCode, seen: audienceAnswer, ok: audienceOk, subject_age: subjectAge },
  };
}

/** «Плоский» ответ: одно и то же число во всех пунктах качества или разброс виральности < 10 (оригинал: :664-688). */
export function isFlatRating(list: Array<Record<string, unknown>>): boolean {
  const qKeys = ["virality", "composition", "lighting", "framing", "pin_appeal"];
  let checked = 0, flat = 0;
  const viralities: number[] = [];
  for (const it of list) {
    const vals = qKeys.map((k) => Number(it[k])).filter((v) => Number.isFinite(v) && v > 0);
    if (vals.length < 3) continue;
    checked++;
    if (vals.every((v) => v === vals[0])) flat++;
    const vir = Number(it.virality ?? it.pin_appeal);
    if (Number.isFinite(vir)) viralities.push(vir);
  }
  if (!checked) return false;
  const spread = viralities.length > 2 ? Math.max(...viralities) - Math.min(...viralities) : 99;
  return flat / checked > 0.5 || spread < 10;
}

// ─────────────────────────────────────────────────────────────
// Сравнение кадров (оригинал: stage-photo-rank/index.ts)
// ─────────────────────────────────────────────────────────────

/** сколько кадров в одном сравнении (оригинал: :25) */
export const RANK_GROUP_SIZE = 10;
/** сколько лучших из каждой пачки уходит в турнир чемпионов (оригинал: :29) */
export const RANK_CHAMPIONS_PER_GROUP = 3;
/** групп параллельно (оригинал: :232) */
export const RANK_WAVE = 4;
/** пул турнира чемпионов (оригинал: :261 — GROUP_SIZE + 2) */
export const RANK_CHAMPION_POOL = RANK_GROUP_SIZE + 2;
/** не-чемпионы не могут обогнать чемпионов (оригинал: :273) */
export const RANK_NON_CHAMPION_CAP = 70;
/** кадры, которые так и не сравнили, получают средний балл (оригинал: :299) */
export const RANK_FALLBACK = 50;

/** Локальный балл в группе: 95..25 (оригинал: :245). */
export function beautyLocalScore(pos: number, n: number): number {
  const score = n > 1 ? 95 - (pos / (n - 1)) * 70 : 80;
  return Math.round(score * 10) / 10;
}

/** Балл чемпиона: 100..72 (оригинал: :267). */
export function beautyChampionScore(pos: number, n: number): number {
  const score = n > 1 ? 100 - (pos / (n - 1)) * 28 : 95;
  return Math.round(score * 10) / 10;
}

/** Детерминированное перемешивание: пачки не зависят от порядка поиска (оригинал: :60-70). */
export function seededShuffle<T>(arr: T[], seed: string): T[] {
  const out = [...arr];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 2147483647;
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 48271) % 2147483647;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
