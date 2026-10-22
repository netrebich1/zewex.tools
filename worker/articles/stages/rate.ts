/**
 * Этап rate — «ИИ-оценка фото» (оригинал: stage-photo-rate/index.ts, шаг 13).
 *
 * Пачки по `recipe.photoSearch.ratingBatchSize` (8) уходят в vision-модель уменьшенными копиями (≤1024 px) в порядке
 * `techScore DESC, createdAt` (с 2026-10-16 оценка идёт ДО сравнения кадров — волна 3 п.2, beautyRank здесь ещё пуст;
 * `rankScore` после сравнения пересчитает этап rank). Модель — `stageModels["rp_photo_rate"]` сценария (08-plan §3 п.4),
 * промт — `rp_photo_rate` набора (система + JSON-контракт + правила темы), иначе встроенный `ratingSystemFor`.
 * Промт собирает `buildRateSystem` (волна 3 п.3, замер 2026-10-16 — см. шапку src/lib/articles/ai.ts): системное
 * сообщение — только неизменная часть (персона набора, JSON-контракт, HARD REJECT), одинаковая для всех статей ниши,
 * и уходит с `cacheSystem` (явный кэш Gemini: ~1.7k токенов по 0.25 цены с второго вызова); всё зависящее от статьи
 * (тренд-бриф, тема, контракт, чек-лист, второй проход, поправки) — первым текстом в user (`lead`). Смысл правил не менялся.
 * Вердикт: чек-лист темы, аудитория, порог балла (`minScore`, при нехватке/втором проходе −1, не ниже 6),
 * виральность ≥45, тренд ≥40, каталог, признаки ИИ, дети при взрослой теме, наличие фактов/описания.
 *
 * Результат на кандидате: status keep | rejected (rejectStage "rate", rejectReason по-русски), aiScore 0–10,
 * relevance, aiBreakdown (качество, ai_quality, причина, класс отказа), aiFacts, aiDescription, audience, rankScore.
 *
 * Финиш (все pending оценены): непроверенные кандидаты → назад к `filter` (≤6 кругов); промо отклонённых с баллом ≥6
 * (не для жёстких классов — 08-plan §3 п.5); второй мягкий проход по «мягким» отказам (один раз); добор через `search`
 * (`cursor.topup`, ≤7 кругов при `cursor.topups` < 6); иначе дальше к `select` или WAITING_FOR_PHOTOS.
 * Идемпотентно: уже оценённые (aiScore != null) не оцениваются повторно; транзитные ошибки модели пробрасываются
 * раннеру (backoff), постоянные — пачка помечается после второй попытки.
 */
import { prisma } from "@/lib/db";
import { AiError } from "@/lib/pins/ai/errors";
import { Prisma, type ArtPhotoCandidate } from "@prisma/client";
import type { ContentPart } from "@/lib/articles/ai";
import { fillPrompt, resolvePromptOptional, stageModel } from "@/lib/articles/prompts";
import { MIN_PHOTOS, PHOTO_LOOPS } from "@/lib/articles/types";
import { getNicheProfile, photoFactRules, photoFactSkeleton, specializeProfile, subjectLabel, topicKindLabel, type NicheProfile } from "@/lib/articles/photo/profile";
import {
  buildFashionContract,
  buildInteriorContract,
  buildTopicContract,
  fashionContractPrompt,
  interiorContractPrompt,
  isInteriorNiche,
  NO_PEOPLE_RULE,
  noPeopleInFrame,
  type FashionContract,
  type InteriorContract,
  type TopicContract,
} from "@/lib/articles/photo/contracts";
import { audienceRule, isChildIntent } from "@/lib/articles/photo/audience";
import { buildTopicRelevance } from "@/lib/articles/photo/relevance";
import { VisionImageCache, imageContent, listFromJson, mustRethrow, resolveTrendBrief, trendBriefText, visionJson } from "@/lib/articles/photo/vision";
import {
  PROMO_MIN_SCORE,
  RESCUE_MIN_THRESHOLD,
  finalPhotoRank,
  isFlatRating,
  isHardReject,
  judgeRatingItem,
  readBreakdown,
  topicOf,
  type AiBreakdown,
} from "@/lib/articles/photo/ranking";
import { slimFactKeys, slimJsonContract, slimJudgement } from "@/lib/articles/photo/rateSlim";
import type { ArtStageHandler } from "./index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** пачек параллельно (оригинал: :867 PARALLEL_WAVE = 5) */
const PARALLEL_WAVE = 5;
/** предел размера пачки (оригинал: normalizePhotoConfig — rating_batch_size ≤ 12, default 8) */
const MAX_BATCH = 12;
const DEFAULT_BATCH = 8;
const DEFAULT_MIN_SCORE = 7;
/** попыток оценить пачку до отбраковки (оригинал: :553-569 — retry, затем reject) */
const MAX_BATCH_ATTEMPTS = 2;
/** статусы кандидатов, которые считаем одобренными (после отбора keep делится на selected/reserve) */
const KEEP_STATUSES = ["keep", "selected", "reserve"];

// оригинал: stage-photo-rate/index.ts:53-65 (дословно)
export const HARD_REJECT_RULES =
  `HARD REJECT (verdict "reject", score 0) — no exceptions:
1. A real collage: two or more SEPARATE photographs placed in one file, divided by borders,
   gutters or a hard straight edge (grid, split screen, before/after, side-by-side).
   NOT a collage — do not reject these: one single photograph that happens to contain
   a doorway, window, pillar, wall edge, mirror, staircase or background line; one photo
   with several people in it; one flat-lay of several garments on one surface.
2. Any overlaid text, caption band, title banner, number badge, watermark, logo or arrow/play button.
3. Pinterest-style graphics ("20 Pretty … you should try"), screenshots, drawings, 3D renders,
    AI-generated or clearly synthetic images. Do not reject a real photo merely because
    it has a white or plain studio background.
4. Blurry, noisy, dark, distorted (extra fingers/toes, melted edges) or amateurish shots.
5. Anything that does not show the exact subject of the topic (see TOPIC RULES below).`;

/** Встроенный системный промт оценки (оригинал: :68-91, дословно). slim — тонкий контракт (cost-fixes-b, rateSlim.ts). */
function ratingSystemFor(profile: NicheProfile, slim = false): string {
  const subject = subjectLabel(profile);
  if (slim) {
    return `You are a strict photo editor for a visual article.
For EACH numbered photo decide if it is usable as an editorial photo for the given topic.
${HARD_REJECT_RULES}
${slimJsonContract(profile)}`;
  }
  return `You are a strict photo editor for a visual article.
For EACH numbered photo decide if it is usable as an editorial photo for the given topic.
${HARD_REJECT_RULES}

For every KEPT photo extract ON-TOPIC FACTS ONLY — everything about ${subject}
and NOTHING else.
NEVER mention: other people, skin tone, background props, text or logos, or anything
outside ${subject}.
If a field is not visible, use "" — never guess, never add marketing adjectives.
${photoFactRules(profile)}

Also write "description": the same facts as one dense factual sentence-set,
30-60 words, English, on-topic only, no opinions.

Return ONLY JSON:
{"photos":[{"n":1,"score":8,"verdict":"keep","topic_ok":true,"topic_miss":"","reason":"clean close-up, on topic",
"facts":{${photoFactSkeleton(profile)}},
"description":"..."}]}
score: 1-10 overall editorial quality. verdict: "keep" or "reject".
reason: max 12 words, English. facts/description: empty for rejected photos.`;
}

// оригинал: :693-695 и :708-710
const CORRECTION_FLAT =
  `\n\nCORRECTION: your previous answer gave the same number to every quality field and barely varied virality between photos.` +
  ` Re-score honestly: virality, composition, lighting and framing measure different things and must differ per photo.` +
  ` Use the full 20-95 range and make the best and weakest frame differ by at least 25 virality points.`;
const CORRECTION_AUDIENCE =
  `\n\nCORRECTION: you did not return the required "audience" field.` +
  ` For EVERY photo return "audience" with one of: black, white, latina, east_asian, south_asian, middle_eastern, no_person, unclear.` +
  ` Look at the person in the image (skin tone, facial features, hair texture) — never infer it from clothing colour or the page title.`;

type RatedItem = Record<string, unknown>;

/** Детали для сборки промта оценки (чистая функция — её же зовёт стенд кэша промта). */
export type RateSystemInput = {
  profile: NicheProfile;
  /** Системный текст промта набора с подставленными переменными; null — встроенный `ratingSystemFor` */
  customSystem: string | null;
  /** В системном тексте набора были переменные ({{topic}} и т.п.) — он зависит от статьи и идёт в `lead`, не в кэшируемую систему */
  customSystemDynamic?: boolean;
  topic: string;
  rel: { aiConstraints: string; requirements: string[] };
  trendBrief: ReturnType<typeof resolveTrendBrief>;
  contractRules: string;
  audienceRules: string;
  fashionRules: string;
  interiorRules: string;
  /** Режим оценки (recipe.photoSearch.rateMode): slim — контракт без описания и с полями разнообразия (cost-fixes-b) */
  rateMode?: "full" | "slim";
};

/**
 * Промт оценки в два куска: `system` одинаков для всех статей ниши (персона, JSON-контракт, HARD REJECT) — кэшируется;
 * `lead` — тренд, тема, контракты, чек-лист, второй проход — первый текст user. Раньше всё это было одним системным
 * сообщением (порядок: персона, контракт, тренд, правила темы с HARD REJECT внутри); смысл инструкций тот же.
 */
export function buildRateSystem(inp: RateSystemInput, rescueActive: boolean): { system: string; lead: string } {
  const { profile, topic, rel, trendBrief } = inp;
  const SUBJECT = subjectLabel(profile);
  // оригинал: :267-368. Порядок частей: неизменное → зависящее от статьи (смысл тот же).
  const slim = inp.rateMode === "slim";
  // Факты и образец JSON: полный (факты всех полей + описание) или тонкий (поля разнообразия, без описания — cost-fixes-b).
  const FACTS_AND_JSON = slim
    ? slimJsonContract(profile)
    : `\nON-TOPIC FACTS ONLY: describe ${SUBJECT}.\nNever mention other people, background props, text or logos, or anything outside ${SUBJECT}.\nUse "" for anything not visible — never guess.\n${photoFactRules(profile)}\nReturn ONLY JSON:\n{"photos":[{"n":1,"score":8,"verdict":"keep","topic_ok":true,"topic_miss":"","catalogue":false,"catalogue_reason":"","ai_likelihood":8,"ai_artifacts":[],"subject_age":"adult","virality":78,"trend":72,"trend_reason":"","composition":64,"lighting":71,"framing":58,"reason":"clean close-up, on topic","facts":{${photoFactSkeleton(profile)}},"description":"30-60 words, same facts, factual, no opinions"}]}\nscore: 1-10 (topic fit). verdict: "keep" or "reject". reason: max 12 words. facts/description: empty for rejected photos.`;
  const JSON_CONTRACT =
    FACTS_AND_JSON +
    `\nCATALOGUE CHECK:\n- catalogue=true only with visible listing evidence: standard retail pose and crop, isolated product presentation, SKU/price/size variants, product-card graphics, or unmistakable marketplace styling.\n- A white, grey or plain studio background BY ITSELF is acceptable and must never make catalogue=true. A strong real editorial portrait or styled full look on white can be kept.\n- catalogue_reason: max 8 words, naming the visible evidence.\nSUBJECT AGE: subject_age = "adult", "child" (baby/kid/teen or children's garment) or "none" (no person).\nAUTHENTICITY CHECK:\n- ai_likelihood: 0-100 probability the IMAGE itself is generated, not merely retouched.\n- ai_artifacts: only visible evidence, such as fused/extra fingers, impossible garment geometry, repeated details, plastic skin or fabric, inconsistent jewellery, warped background, impossible shadows. Empty array when none.\n- 80-100 only for clear multiple artifacts; uncertainty or polished retouching alone must stay below 80.\nQUALITY SCORES 0-100 — rate every photo, kept or rejected, and use the FULL range (weak frames 20-40, average 50-65, excellent 80-95):\n- virality (MOST IMPORTANT): would a Pinterest user stop scrolling and SAVE this pin? Judge scroll-stopping power, aspirational "I want this" pull, aesthetic styling, emotional appeal, colour impact, and whether ${SUBJECT} stays instantly readable at thumbnail size. A technically fine but boring, generic, flat or cluttered frame scores 20-45 even if perfectly on topic. Specific defects that drag virality down: dated or unfashionable look, stock-photo feel, awkward crop, messy or distracting background, visible watermark/text clutter, dull washed-out colours, blurry details, subject too small to read at thumbnail size. A true e-commerce listing scores 15-40, but a plain or white background alone is neutral.\n- composition: framing balance, clean background, subject placement\n- lighting: exposure, soft even light, colour quality\n- framing: subject size and crop — is ${SUBJECT} large and clearly readable\nThese four measure DIFFERENT things: never copy one number into all four. Within a batch, spread the scores — the best frame and the weakest frame must differ by at least 25 points on virality.\n- trend (0-100): see TREND below.`;
  // Тренд зависит от статьи (бриф из facts.trendBrief), поэтому — после неизменной части; критерий тот же.
  const TREND_BLOCK = trendBrief
    ? `\n\nTREND:\n${trendBriefText(trendBrief)}\n- trend (0-100): does what you SEE in the photo (shape, cut, colour, technique, styling, photo style) match the IN list for ${trendBrief.window}, or does it look like the DATED list / an older era? Fully current = 80-95, neutral timeless = 55-70, clearly dated = 10-35. Put the dated detail in "trend_reason" (max 8 words, empty if current).`
    : `\n\nTREND:\n- trend (0-100): how current and in-fashion the look is today (dated looks 10-35). "trend_reason": max 8 words.`;
  const CHECKLIST = rel.requirements.length
    ? `\n\nTOPIC CHECKLIST for "${topic}" — every kept photo must satisfy EVERY line:\n` +
      rel.requirements.map((r, i) => `${i + 1}. ${r}`).join("\n") +
      `\nFor each photo return "topic_ok": true only if every line above is satisfied by what you SEE in the image` +
      ` (page titles and file names do not count). Otherwise "topic_ok": false and "topic_miss": the failing line` +
      ` in max 6 words. A photo with "topic_ok": false must get verdict "reject".`
    : "";
  // Встроенный системный промт уже содержит HARD REJECT (раньше правила TOPIC RULES повторяли его второй раз);
  // у промта набора он идёт сразу после JSON-контракта — в неизменной части. Текст набора с переменными статьи —
  // в начало `lead`, чтобы системное сообщение осталось общим для ниши.
  const custom = inp.customSystem;
  const system = custom && !inp.customSystemDynamic ? `${custom}${JSON_CONTRACT}\n\n${HARD_REJECT_RULES}` : custom ? `${JSON_CONTRACT.trimStart()}\n\n${HARD_REJECT_RULES}` : ratingSystemFor(profile, slim);
  const lead =
    (custom && inp.customSystemDynamic ? `${custom}\n` : "") +
    TREND_BLOCK.trimStart() +
    `\n\nTOPIC RULES for "${topic}" — apply strictly (HARD REJECT rules above apply to every photo):\n${rel.aiConstraints || `- the photo MUST visibly show the subject of "${topic}"`}${inp.contractRules}${inp.audienceRules}${inp.fashionRules}${inp.interiorRules}${CHECKLIST}\nWhen in doubt, reject: a wrong or off-topic photo is far worse than a missing one.` +
    (rescueActive
      ? `\n\nSECOND PASS: these photos were rejected on a first, very strict pass and we are short of usable photos.` +
        ` Hard rules above still apply without exception (collage, text overlay, AI-generated, wrong topic, wrong body part, wrong audience/ethnicity, people in an interior/decor frame).` +
        ` But do NOT reject for minor aesthetic reasons alone — slightly imperfect lighting, plain background,` +
        ` visible tools or props, mild softness outside ${SUBJECT}, or an ordinary-looking result are acceptable.` +
        ` Keep every photo that is on topic and shows ${SUBJECT} clearly enough to write about.`
      : "");
  return { system, lead };
}

function hasAudienceField(items: RatedItem[]): boolean {
  return items.some((i) => String(i?.audience ?? i?.ethnicity ?? "").trim());
}

function asContract<T extends object>(raw: unknown, marker: keyof T): T | null {
  return raw && typeof raw === "object" && marker in (raw as object) ? (raw as T) : null;
}

export const rate: ArtStageHandler = async (ctx) => {
  const { article, recipe } = ctx;
  const cfg = recipe.photoSearch;
  const niche = recipe.nicheCode;
  const subniche = recipe.subnicheCode ?? null;
  const topic = topicOf(article);
  const focusTopic = `${article.focusKeyword || ""} ${topic}`.trim();
  // оригинал: :204-207 neededPhotos = max(1, count_outfits || 20); :428 minAcceptable = min(needed, 15)
  const needed = Math.max(1, article.photoCount || 20);
  const minAcceptable = Math.min(needed, MIN_PHOTOS);
  const batchSize = Math.min(MAX_BATCH, Math.max(1, Number(cfg.ratingBatchSize) || DEFAULT_BATCH));
  const baseMinScore = Number(cfg.minScore) > 0 ? Number(cfg.minScore) : DEFAULT_MIN_SCORE;

  const profile = specializeProfile(await getNicheProfile(niche, subniche), topic);
  const SUBJECT = subjectLabel(profile);
  // Тонкая оценка (cost-fixes-b): модель отдаёт только поля разнообразия и без описания; полное описание итоговым фото
  // пишет describeLate в начале plan. По умолчанию (full) промт и разбор прежние.
  const slim = cfg.rateMode === "slim";
  const FACT_KEYS = slim ? slimFactKeys(profile) : Object.keys(profile.fact_block?.photo_facts || {});
  const model = stageModel(recipe, "rp_photo_rate");
  const prompt = await resolvePromptOptional(recipe, "rp_photo_rate");

  // Контракты темы и аудитория: из facts шага поиска, иначе строим здесь (чистые функции, как в оригинале :277-343).
  const attrs = (ctx.facts.keywordAttributes ?? null) as Record<string, unknown> | null;
  const topicContract = asContract<TopicContract>(ctx.facts.topicContract, "reviewRules") ?? buildTopicContract(profile, attrs, focusTopic);
  const fashionContract: FashionContract | null = niche === "outfits"
    ? asContract<FashionContract>(ctx.facts.fashionContract, "hard_requirements") ?? buildFashionContract(topic, attrs)
    : null;
  const interiorContract: InteriorContract | null = isInteriorNiche(niche, subniche)
    ? asContract<InteriorContract>(ctx.facts.interiorContract, "hard_requirements") ?? buildInteriorContract(article.focusKeyword || topic, attrs)
    : null;
  const audience = audienceRule(topic, niche);
  // Интерьер и декор — без людей (2026-10-19): жёсткий отказ по полю person_visible / subject_age.
  const noPeople = noPeopleInFrame(niche, subniche, article.focusKeyword || article.keyword || topic);
  // оригинал: :297-298
  const adultTopic = !/interior|decor|home|garden/i.test(niche) && !isChildIntent(focusTopic, niche);
  const rel = buildTopicRelevance(topic, niche, profile);
  const trendBrief = resolveTrendBrief(ctx.facts, niche, article.keyword || topic);

  // ── Промт (оригинал: :267-368): статичная часть + зависящая от статьи — buildRateSystem ──
  const FASHION_RULES = fashionContract
    ? `\n\n${fashionContractPrompt(fashionContract)}\n` +
      (fashionContract.outfit_mode === "piece"
        ? `HARD REJECT if the hero piece is missing, obscured, too small to evaluate, or is not the central styling subject. Other garments matter only in relation to that hero piece.`
        : `HARD REJECT if the complete outfit is not readable. The garments, layers and shoes must provide enough visual evidence for a whole-look section.`) +
      `\nReject true product-listing catalogue frames and isolated garments without a wearable look. White or plain studio backgrounds are allowed when the person wears a readable, styled look and the frame lacks listing cues. Reject any frame that contradicts audience, occasion, season or style locks. Extract only visible garment facts; never guess brands, prices, fabric composition, comfort or fit on the wearer.`
    : "";
  const INTERIOR_RULES = interiorContract
    ? `\n\n${interiorContractPrompt(interiorContract)}\n` +
      (interiorContract.decor_mode === "element"
        ? `HARD REJECT if the hero element (${interiorContract.hero_element}) is missing, cropped beyond recognition, or is not what the frame is about.`
        : interiorContract.decor_mode === "room"
        ? `HARD REJECT if the photo shows a different room or zone than the topic requires.`
        : `HARD REJECT if the space clearly belongs to another style than the topic requires.`) +
      (interiorContract.setting === "outdoor"
        ? `\nHARD REJECT any indoor frame: this topic is outdoor (patio, porch, balcony, deck, yard, garden).`
        : interiorContract.setting === "indoor"
        ? `\nHARD REJECT outdoor frames (patio, yard, garden, balcony): this topic is indoor.`
        : "") +
      `\nHARD REJECT 3D renders and CGI (perfect symmetry, plastic textures, impossible light, no wear, no clutter, showroom emptiness),` +
      ` AI-generated interiors, floor plans, mood-board collages, real-estate listing frames with agency watermarks or text bars,` +
      ` and furniture-catalogue cut-outs on a plain white background.` +
      ` A single photo that happens to show a doorway, a mirror, several people or objects laid out on one surface is NOT a collage.` +
      `\nExtract only visible facts: room or zone, style, palette, materials, key pieces, lighting, framing. Never guess prices, brands, room dimensions or renovation cost.` +
      (noPeople
        ? `\n${NO_PEOPLE_RULE}\nFor EVERY photo, kept or rejected, add "person_visible": true if any person or human body part is visible anywhere in the frame, otherwise false. person_visible true means verdict "reject".`
        : "")
    : "";
  // Частые ошибки чтения кадра (аудит woman-trend 2026-10-22): кольца на пальцах описаны как «полоса страз», зебра
  // названа леопардом, светлые пряди — «lowlights», причёска в пучке — «боб». Правила идут в оценку, факты — к автору.
  const FACT_GUARDS = factGuards(niche, `${article.keyword || ""} ${article.focusKeyword || ""}`);
  const CONTRACT_RULES = (FACT_GUARDS ? `\n\nREAD THE PHOTO EXACTLY:\n${FACT_GUARDS}` : "") + (topicContract.reviewRules.length
    ? `\n\nTOPIC CONTRACT (hard limits from the article topic):\n${topicContract.reviewRules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
    : "");
  const AUDIENCE_RULES = audience
    ? `\n\nAUDIENCE CHECK (mandatory, decided per photo):\n${audience.rule}\n` +
      `For EVERY photo add a field "audience" with exactly one value you actually SEE:` +
      ` "black" (dark brown skin, Afro-textured/protective hair), "white" (light skin, Caucasian features),` +
      ` "latina", "east_asian", "south_asian", "middle_eastern", "no_person", or "unclear".` +
      ` Judge the person, not the clothing colour. Expected value for this article: "${audience.code}".` +
      ` Any other value (including "unclear" and "no_person") means verdict "reject", topic_ok false and "wrong_audience" in issues.`
    : "";
  // Переменные промта rp_photo_rate (оригинал: :244-256) + {fashion_contract}/{interior_contract} (аудит 06).
  const vars = {
    topic: article.keyword || topic,
    focus_keyword: article.focusKeyword || topic,
    niche,
    subniche: subniche ?? "",
    // Статьи сервиса пишутся по-английски (оригинал: project.language || "en").
    language: "en",
    topic_kind: topicKindLabel(profile, topic),
    subject_label: SUBJECT,
    fashion_contract: fashionContract ? fashionContractPrompt(fashionContract) : "",
    interior_contract: interiorContract ? interiorContractPrompt(interiorContract) : "",
  };
  const filled = prompt ? fillPrompt(prompt, vars) : null;
  const systemInput: RateSystemInput = {
    profile,
    customSystem: filled?.system || null,
    customSystemDynamic: !!prompt && /\{\{?\s*\w+\s*\}?\}/.test(prompt.system),
    topic,
    rel,
    trendBrief,
    contractRules: CONTRACT_RULES,
    audienceRules: AUDIENCE_RULES,
    fashionRules: FASHION_RULES,
    interiorRules: INTERIOR_RULES,
    rateMode: slim ? "slim" : "full",
  };
  const promptFor = (rescueActive: boolean) => buildRateSystem(systemInput, rescueActive);
  const ratingUser = filled?.user ?? "";

  // ── Состояние этапа ──
  const cache = new VisionImageCache();
  let cost = 0;
  let kept = 0;
  let rejected = 0;
  let batches = 0;
  let promoted = 0;
  let rescued = 0;

  const countKeep = () => prisma.artPhotoCandidate.count({ where: { articleId: article.id, status: { in: KEEP_STATUSES } } });
  /** «Одобрено 41 из 66, нужно 13»: одобренные из всех проверенных оценкой и сколько нужно статье (было «41 из 13»). */
  const approvedText = async (keep: number) => {
    const rejectedTotal = await prisma.artPhotoCandidate.count({ where: { articleId: article.id, status: "rejected", rejectStage: "rate" } });
    return `Одобрено ${keep} из ${keep + rejectedTotal}, нужно ${needed}`;
  };
  const saveCursor = async (patch: Record<string, unknown>) => ctx.save({ cursor: { ...ctx.cursor, ...patch } });

  /** Порог балла: при втором проходе или нехватке после всех доборов — на балл ниже, не меньше 6 (оригинал: :217-236). */
  const thresholdFor = async (rescueActive: boolean): Promise<number> => {
    const keptSoFar = await countKeep();
    const topups = Number(ctx.cursor.topups ?? 0);
    const scarcity = topups >= PHOTO_LOOPS.maxTopups && keptSoFar < minAcceptable;
    return rescueActive || scarcity ? Math.max(RESCUE_MIN_THRESHOLD, baseMinScore - 1) : baseMinScore;
  };

  const rejectCandidate = async (c: ArtPhotoCandidate, reason: string, cls: AiBreakdown["reject_class"], extra: Partial<AiBreakdown> = {}) => {
    const ex = readBreakdown(c);
    await prisma.artPhotoCandidate.update({
      where: { id: c.id },
      data: {
        status: "rejected",
        rejectStage: "rate",
        rejectReason: reason,
        aiScore: 0,
        aiBreakdown: { ...ex, ...extra, verdict: "reject", reason, reject_class: cls } as object,
      },
    });
    rejected++;
  };

  /** Пачка не оценена: первый раз — оставляем на повтор, второй — отбраковка (оригинал: :553-569). */
  const markBatchFailure = async (rows: ArtPhotoCandidate[], reason: string) => {
    for (const c of rows) {
      const ex = readBreakdown(c);
      const attempts = Number(ex.attempts ?? 0) + 1;
      if (attempts >= MAX_BATCH_ATTEMPTS) {
        await rejectCandidate(c, reason, "model_failed", { attempts });
      } else {
        await prisma.artPhotoCandidate.update({ where: { id: c.id }, data: { aiBreakdown: { ...ex, attempts } as object } });
      }
    }
  };

  /** Оценка одной пачки (оригинал: :572-860). */
  const runBatch = async (rawBatch: ArtPhotoCandidate[], sys: { system: string; lead: string }, threshold: number, rescueActive: boolean) => {
    const images = await Promise.all(rawBatch.map((c) => cache.get(c, "full")));
    const batch: Array<{ c: ArtPhotoCandidate; part: ContentPart }> = [];
    for (let i = 0; i < rawBatch.length; i++) {
      const img = images[i];
      if (img) batch.push({ c: rawBatch[i], part: imageContent(img) });
      else await rejectCandidate(rawBatch[i], "фото недоступно для скачивания", "download"); // оригинал: :586-592
    }
    if (!batch.length) return;

    // оригинал: :596-609
    const userText =
      (ratingUser ? ratingUser + "\n\n" : `Topic: "${topic}".\n`) +
      `Required in every kept photo: ${rel.strong.join(", ") || topic}.` +
      (rel.forbidden.length ? ` Never keep photos showing: ${rel.forbidden.join(", ")}.` : "") +
      `\nReject every collage, multi-panel image and any photo with overlaid text.\n` +
      (rel.requirements.length ? `Check every photo against the TOPIC CHECKLIST and return "topic_ok" / "topic_miss" for each.\n` : "") +
      `Photos:\n` +
      batch.map((b, n) => `${n + 1}. ${b.c.title || "(no title)"} — ${b.c.domain || ""}`).join("\n");
    // Модель отказалась по правилам контента (Gemini PROHIBITED_CONTENT): виноват один кадр пачки, а не провайдер.
    let blocked = false;
    const askModel = async (extraNote: string): Promise<RatedItem[] | null> => {
      // Зависящее от статьи (и поправки повтора) — первым текстом user; система неизменна и кэшируется.
      const parts: ContentPart[] = [{ type: "text", text: sys.lead + extraNote }, { type: "text", text: userText }, ...batch.map((b) => b.part)];
      try {
        // оригинал: temperature 0.2, maxTokens 6144, timeout 180 с (:619-635)
        const r = await visionJson(ctx.ai, { model, system: sys.system, parts, temperature: 0.2, maxTokens: 6144, timeoutMs: 180_000, cacheSystem: true });
        cost += r.costUsd;
        const list = listFromJson(r.json, ["photos", "results"]).filter((x): x is RatedItem => !!x && typeof x === "object");
        return list.length ? list : null;
      } catch (e) {
        if (mustRethrow(e, ctx.signal)) throw e;
        if (e instanceof AiError && e.cls.code === "safety") blocked = true;
        ctx.log(`пачка не оценена: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    };

    let items = await askModel("");
    // «Плоский» ответ — один повтор с поправкой (оригинал: :690-699)
    if (items && isFlatRating(items)) {
      const retried = await askModel(CORRECTION_FLAT);
      if (retried) items = retried;
    }
    // Поле аудитории обязательно — переспрашиваем один раз (оригинал: :700-718)
    if (items && audience && !hasAudienceField(items)) {
      const retried = await askModel(CORRECTION_AUDIENCE);
      if (retried && hasAudienceField(retried)) items = retried;
    }
    if (!items) {
      // Блокировка контента: делим пачку пополам, пока не останется виноватый кадр, — его отклоняем, остальные оцениваем.
      if (blocked) {
        const rows = batch.map((b) => b.c);
        if (rows.length === 1) {
          await rejectCandidate(rows[0], "модель отказалась оценивать кадр по правилам контента", "model_failed");
          return;
        }
        const mid = Math.ceil(rows.length / 2);
        await runBatch(rows.slice(0, mid), sys, threshold, rescueActive);
        await runBatch(rows.slice(mid), sys, threshold, rescueActive);
        return;
      }
      await markBatchFailure(batch.map((b) => b.c), "модель не оценила фото");
      return;
    }

    const answered = new Set<string>();
    for (const item of items) {
      const n = Number(item.n ?? item.index ?? 0);
      const row = batch[n - 1];
      if (!row || answered.has(row.c.id)) continue;
      answered.add(row.c.id);
      const judged = judgeRatingItem(item, {
        scoreThreshold: threshold,
        requirementsCount: rel.requirements.length,
        audienceCode: audience?.code ?? null,
        adultTopic,
        factKeys: FACT_KEYS,
        rescue: rescueActive,
        noPeople,
      });
      // slim: описание не сохраняем (judgeRatingItem подставил бы текст из фактов), aiBreakdown.slim = true.
      const j = slim ? slimJudgement(judged) : judged;
      if (j.verdict === "keep") kept++;
      else rejected++;
      const ex = readBreakdown(row.c);
      const breakdown: AiBreakdown = {
        ...j.breakdown,
        ...(ex.beauty_note ? { beauty_note: ex.beauty_note } : {}),
        ...(ex.prev ? { prev: ex.prev } : {}),
        ...(ex.rescue || rescueActive ? { rescue: true } : {}),
      };
      await prisma.artPhotoCandidate.update({
        where: { id: row.c.id },
        data: {
          status: j.verdict === "keep" ? "keep" : "rejected",
          rejectStage: j.verdict === "keep" ? null : "rate",
          rejectReason: j.verdict === "keep" ? null : j.reason,
          aiScore: j.aiScore,
          relevance: j.relevance,
          aiDescription: j.description,
          aiFacts: j.facts ? (j.facts as Prisma.InputJsonValue) : Prisma.DbNull,
          audience: j.audience as object,
          aiBreakdown: breakdown as object,
          rankScore: finalPhotoRank({ beauty_rank: row.c.beautyRank, ai_quality: j.breakdown.ai_quality ?? null, tech_quality: row.c.techScore, ai_score: j.aiScore }),
        },
      });
    }
    // Номера, которые модель пропустила, — как неоценённая пачка (повтор, затем отбраковка).
    const skipped = batch.filter((b) => !answered.has(b.c.id)).map((b) => b.c);
    if (skipped.length) await markBatchFailure(skipped, "модель не оценила фото");
  };

  /** Оценить все ожидающие кадры (пачки волнами по 5; пропущенные пачки повторяются до MAX_BATCH_ATTEMPTS). */
  const ratePending = async (rescueActive: boolean) => {
    const threshold = await thresholdFor(rescueActive);
    if (ctx.cursor.minScore !== threshold) await saveCursor({ minScore: threshold });
    const sys = promptFor(rescueActive);
    for (let pass = 0; pass < MAX_BATCH_ATTEMPTS + 1; pass++) {
      // Порядок — лучшие по техническому баллу первыми (оригинал :370-381 брал beautyRank, но сравнение кадров теперь
      // идёт после оценки). NULL в MySQL при DESC — в конце.
      const pending = await prisma.artPhotoCandidate.findMany({
        where: { articleId: article.id, status: "downloaded", aiScore: null },
        orderBy: [{ techScore: "desc" }, { createdAt: "asc" }],
      });
      if (!pending.length) return;
      await ctx.tick(`${rescueActive ? "Второй проход" : "Оценка"}: ${pending.length} фото`);
      const all: ArtPhotoCandidate[][] = [];
      for (let i = 0; i < pending.length; i += batchSize) all.push(pending.slice(i, i + batchSize));
      let done = 0;
      for (let wi = 0; wi < all.length; wi += PARALLEL_WAVE) {
        const wave = all.slice(wi, wi + PARALLEL_WAVE);
        const settled = await Promise.allSettled(wave.map((b) => runBatch(b, sys, threshold, rescueActive)));
        const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
        if (failure) throw failure.reason;
        batches += wave.length;
        done += wave.reduce((n, b) => n + b.length, 0);
        await ctx.tick(`${rescueActive ? "Второй проход" : "Оценка фото"}: ${done}/${pending.length}`);
        if (wi + PARALLEL_WAVE < all.length) await sleep(500);
      }
    }
  };

  /** Промо отклонённых с баллом ≥ 6 при нехватке — только мягкие классы отказа (оригинал: :403-422; 08-plan §3 п.5). */
  const promoteSoftRejects = async () => {
    const rows = await prisma.artPhotoCandidate.findMany({ where: { articleId: article.id, status: "rejected", rejectStage: "rate", aiScore: { gte: PROMO_MIN_SCORE } } });
    for (const r of rows) {
      const b = readBreakdown(r);
      if (isHardReject(b)) continue;
      await prisma.artPhotoCandidate.update({
        where: { id: r.id },
        data: {
          status: "keep",
          rejectStage: null,
          rejectReason: null,
          aiBreakdown: { ...b, verdict: "keep", promoted: true, reject_class: null, prev_reason: b.reason, reason: `принято при нехватке фото (балл ${PROMO_MIN_SCORE})` } as object,
        },
      });
      promoted++;
    }
  };

  /** Второй проход: мягко отклонённые возвращаются в очередь оценки (оригинал: :430-483). */
  const queueRescue = async (gap: number): Promise<number> => {
    const rows = await prisma.artPhotoCandidate.findMany({
      where: { articleId: article.id, status: "rejected", rejectStage: "rate" },
      orderBy: { aiScore: "desc" },
      take: 200,
    });
    const revisit = rows.filter((r) => {
      const b = readBreakdown(r);
      return !b.rescue && !isHardReject(b);
    }).slice(0, Math.max(gap * 4, 12));
    for (const r of revisit) {
      const b = readBreakdown(r);
      const rest: AiBreakdown = { ...b };
      delete rest.prev;
      await prisma.artPhotoCandidate.update({
        where: { id: r.id },
        data: {
          status: "downloaded",
          rejectStage: null,
          rejectReason: null,
          aiScore: null,
          aiBreakdown: { prev: rest, rescue: true, attempts: 0, ...(b.beauty_note ? { beauty_note: b.beauty_note } : {}) } as object,
        },
      });
    }
    return revisit.length;
  };

  // ── Основной цикл: оценка → финиш раунда → (второй проход) ──
  for (let round = 0; round < 3; round++) {
    const rescueActive = Boolean(ctx.cursor.rescuePass);
    await ratePending(rescueActive);
    if (rescueActive) await saveCursor({ rescuePass: false });

    let keep = await countKeep();

    // 1. Непроверенные фильтром кандидаты остались — пусть фильтр их доделает (оригинал: :383-402 needs_filtering;
    //    direct-pipeline:512-525 — не больше 6 кругов). Флаг cursor.filterPending читает этап filter.
    const found = await prisma.artPhotoCandidate.count({ where: { articleId: article.id, status: "found" } });
    const filterCycles = Number(ctx.cursor.filterCycles ?? 0);
    if (keep < needed && found > 0 && filterCycles < PHOTO_LOOPS.filterCycles) {
      await saveCursor({ filterCycles: filterCycles + 1, filterPending: true });
      return {
        next: "filter",
        summary: `${await approvedText(keep)}; ${found} кандидатов ещё не проверены — возврат к фильтру (круг ${filterCycles + 1})`,
        details: { kept, rejected, keep, needed, found, batches, costUsd: round6(cost) },
      };
    }

    // 2. Промо при нехватке (оригинал: :403-422)
    if (keep < needed) {
      await promoteSoftRejects();
      keep = await countKeep();
    }

    // 3. Второй проход по мягким отказам — один раз на статью (оригинал: :430-483)
    if (keep < needed && !ctx.cursor.rescueUsed) {
      const n = await queueRescue(needed - keep);
      await saveCursor({ rescueUsed: true, rescuePass: n > 0 });
      if (n > 0) {
        rescued = n;
        ctx.log(`второй проход по ${n} ранее отклонённым кадрам (нужно ещё ${needed - keep})`);
        continue;
      }
    }
    break;
  }

  // ── Финиш (оригинал: :484-538 + direct-pipeline:530-553) ──
  const keep = await countKeep();
  const topups = Number(ctx.cursor.topups ?? 0);
  const rateTopups = Number(ctx.cursor.rateTopups ?? 0);
  const details = { kept, rejected, promoted, rescued, keep, needed, minAcceptable, batches, topups, rateTopups, scoreThreshold: ctx.cursor.minScore, costUsd: round6(cost) };

  const needsMore = keep < needed && topups < PHOTO_LOOPS.maxTopups; // оригинал: :490
  if (needsMore && rateTopups < PHOTO_LOOPS.rateTopups) {
    const reason = `после оценки одобрено ${keep} из ${needed}`;
    await saveCursor({ rateTopups: rateTopups + 1, topup: { from: "rate", needed: needed - keep, reason } });
    return { next: "search", summary: `${await approvedText(keep)} — добор фото (круг ${rateTopups + 1}/${PHOTO_LOOPS.rateTopups})`, details };
  }

  const shortage = keep === 0
    ? "AI-оценка не оставила ни одного подходящего фото"
    : `После всех разрешённых доборов AI одобрил ${keep} из ${needed} фото; для безопасной статьи нужно минимум ${minAcceptable}`;

  if (keep >= minAcceptable) {
    return { summary: `${await approvedText(keep)} (отклонено за этот проход ${rejected}${promoted ? `, промо ${promoted}` : ""})`, details };
  }
  // Режим модерации фото: есть что показать — отбор сохранит кадры и остановится на PHOTO_REVIEW с пометкой «Мало фото»
  // (оригинал: direct-pipeline.waitForPhotos → photo_review при pipeline_mode=2).
  if (article.photoReview && keep > 0) {
    return { summary: `${shortage} — отбор покажет кадры модератору`, details };
  }
  return { next: { wait: "WAITING_FOR_PHOTOS", note: shortage }, summary: shortage, details };
};

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Правила точного чтения кадра по нише и ключу — для оценки фото (факты из неё уходят автору секций). */
export function factGuards(niche: string, keyword: string): string {
  const k = keyword.toLowerCase();
  const out: string[] = [];
  if (/nail|manicure|pedicure/.test(niche) || /nail/.test(k)) {
    out.push("- Rings, bracelets and watches on the hand are jewelry, NOT nail decoration: never describe them as rhinestones, bands, chains or nail art.");
  }
  if (/outfit|fashion|dress/.test(niche) || /dress|outfit|skirt|top|pants/.test(k)) {
    out.push("- Name an animal print exactly as seen: leopard/cheetah = rosette spots; zebra/tiger = stripes; giraffe/cow = patches; snake = scales. If the keyword names a print and the photo shows a different one, topic_ok false.");
  }
  if (/hair/.test(niche) || /hair|bob|cut|braid|lowlight|highlight|balayage/.test(k)) {
    out.push("- Lowlights are strands DARKER than the base; highlights, balayage and babylights are LIGHTER. Describe what you see; never call lighter pieces lowlights.");
    if (/\b(?:bob|lob|pixie|haircut|cut|bangs|layers|length|shag|mullet)\b/.test(k)) out.push("- For a haircut topic the cut must be readable: hair tied up (bun, ponytail, half-up, braided back) hides the cut — topic_ok false.");
  }
  return out.join("\n");
}
