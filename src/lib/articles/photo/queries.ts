/**
 * Поисковые запросы для фото: вариации ключа (один вызов ИИ, промт rp_photo_search), перевод для не-английского гео,
 * инструкция тренд-справки. Порт оригинала _shared/photoQueries.ts (+ trendBriefInstruction из trendBrief.ts; сам бриф — ./vision.ts).
 * Модель — stageModel(recipe, "rp_photo_search"), слот text_fast; промт — из набора сценария (resolvePromptOptional),
 * иначе встроенный. Переменная {target_country} берётся из итогового cfg.country (аудит 02, п.7.16).
 */
import { aiChat, type AiCtx } from "@/lib/articles/ai";
import { fillPrompt, resolvePromptOptional, stageModel } from "@/lib/articles/prompts";
import { SLOTS, type ArticleFacts, type ArticleRecipeSnapshot } from "@/lib/articles/types";
import { defaultProfile, topicKindLabel, type NicheProfile } from "./profile";
import { buildFashionContract, buildInteriorContract, fashionContractPrompt, interiorContractPrompt, isInteriorNiche, type FashionContract, type InteriorContract } from "./contracts";
import { audienceRule, genderRule } from "./audience";
import type { SearchCfg } from "./search";
import { parseTrendBrief, resolveTrendBrief, trendWindow, type TrendBrief } from "./vision";

// ═══════════════════════ trendBrief.ts — сам бриф живёт в ./vision.ts (общий модуль), здесь инструкция для промта ═══════════════════════

export { trendYear, trendWindow, parseTrendBrief, fallbackTrendBrief, trendBriefText, resolveTrendBrief, type TrendBrief } from "./vision";

/** Инструкция для генератора ключей (добавляется в тот же промт) — trendBrief.ts:32-37. */
export function trendBriefInstruction(keyword: string): string {
  return `\n\nADDITIONAL FIELD "trend_brief" (NOT a search query): your expert knowledge of what is fashionable for THIS exact topic in ${trendWindow(keyword)}.\n` +
    `{"window":"${trendWindow(keyword)}","in":["4-8 specific in-trend shapes/cuts, colours, materials, techniques, details"],"out":["4-8 specific DATED looks for this topic that make a photo look old"],"photo_style_out":["2-4 dated photo styles, e.g. harsh flash, heavy filters"]}\n` +
    `Be concrete to the topic, 2-6 words per item, English.\n` +
    `ADDITIONAL FIELD "trend_brief_ru": the same brief in natural Russian for a human moderator: {"in":[...],"out":[...]}.`;
}

/** Имя оригинала (loadTrendBrief): бриф из facts.trendBrief, иначе встроенный по нише. */
export const loadTrendBrief = resolveTrendBrief;

const strList = (v: unknown, n = 8) => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, n);

// ═══════════════════════ photoQueries.ts ═══════════════════════

/** Шаблоны запросов из профиля ниши: {keyword} → ключ статьи. */
function applyTemplates(templates: string[] | undefined, keyword: string): string[] {
  return (templates || [])
    .map((t) => t.replace(/\{keyword\}/g, keyword).replace(/\s+/g, " ").trim())
    .filter((q) => q.length >= 3 && q.toLowerCase() !== keyword.toLowerCase());
}

function legacyFallbackQueries(keyword: string, niche?: string | null): string[] {
  const clean = keyword.replace(/\b20\d{2}\b/g, " ").replace(/\s+/g, " ").trim();
  const ctx = `${keyword} ${niche || ""}`;
  const hint = /nail|manicure/i.test(ctx) ? "manicure close up"
    : /hair|hairstyle|haircut/i.test(ctx) ? "hairstyle close up"
      : /interior|room|kitchen|bedroom|bathroom/i.test(ctx) ? "interior photo"
        : /outfit|dress|fashion|style/i.test(ctx) ? "street style photo"
          : "close up photo";
  return [`${clean} ${hint}`, `${clean} ${hint} inspiration`, `real ${clean} ${hint}`, `${clean} ideas photo`, `${clean} pinterest inspiration`, `beautiful ${clean} real photo`];
}

/** Запасные вариации без ИИ: шаблоны topup профиля + 6 легаси-вариантов (photoQueries.ts:25-31). */
export function fallbackQueries(keyword: string, niche?: string | null, profile?: NicheProfile | null): string[] {
  const clean0 = keyword.replace(/\b20\d{2}\b/g, " ").replace(/\s+/g, " ").trim();
  const fromProfile = applyTemplates(profile?.search_templates?.topup, clean0);
  const legacy = legacyFallbackQueries(keyword, niche);
  const merged = [...new Set([...fromProfile, ...legacy].map((q) => q.trim()).filter(Boolean))];
  return merged.slice(0, 6);
}

const LANG_NAMES: Record<string, string> = {
  es: "Spanish", de: "German", fr: "French", it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", tr: "Turkish",
  sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", cs: "Czech", ro: "Romanian", hu: "Hungarian", el: "Greek",
  uk: "Ukrainian", ru: "Russian", ja: "Japanese", ko: "Korean", id: "Indonesian", vi: "Vietnamese", th: "Thai", ar: "Arabic", hi: "Hindi",
};

export function languageName(code: string): string {
  const key = String(code || "").toLowerCase().slice(0, 2);
  return LANG_NAMES[key] || key.toUpperCase();
}

/**
 * Перевод поисковых запросов на язык гео (только для запросов к поиску картинок; тема и тексты остаются английскими).
 * Оригинал photoQueries.ts:72-113: temperature 0.2, maxTokens 400, timeout 45 с; число запросов должно совпасть.
 */
export async function translateSearchQueries(ctx: AiCtx, recipe: ArticleRecipeSnapshot, queries: string[], language: string): Promise<{ queries: string[]; translated: boolean; error?: string }> {
  const lang = String(language || "en").toLowerCase().slice(0, 2);
  const list = queries.map((q) => String(q || "").trim()).filter(Boolean);
  if (!list.length || lang === "en") return { queries: list, translated: false };
  const target = languageName(lang);
  try {
    const r = await aiChat(ctx, {
      slot: SLOTS.textFast,
      model: stageModel(recipe, "rp_photo_search"),
      system:
        `You translate Google Images search queries into ${target}.\n` +
        `Rules:\n` +
        `- keep the exact meaning and every defining attribute (length, colour, shape, technique, room, garment);\n` +
        `- use the wording a native ${target} speaker would type in Google Images;\n` +
        `- never add or drop words, never add a year, no quotes, no punctuation;\n` +
        `- keep the same order and the same number of queries.\n` +
        `Return ONLY JSON: {"queries":["...","..."]}`,
      user: JSON.stringify({ target_language: target, queries: list }),
      json: true,
      temperature: 0.2,
      maxTokens: 400,
      timeoutMs: 45_000,
    });
    const parsed = (r.json || {}) as { queries?: unknown[] };
    const out = (Array.isArray(parsed.queries) ? parsed.queries : []).map((q) => String(q || "").replace(/["']/g, "").trim()).filter(Boolean);
    if (out.length === list.length) return { queries: out, translated: true };
    return { queries: list, translated: false, error: "перевод вернул другое число запросов" };
  } catch (e) {
    return { queries: list, translated: false, error: (e as Error).message.slice(0, 160) };
  }
}

export type TopupQueries = {
  /** 3 ближайших к исходной формулировке */
  primary: string[];
  /** 3 другого угла (синонимы, inspiration, real photo…) */
  secondary: string[];
  /** все 6 в порядке приоритета */
  queries: string[];
  source: "ai" | "fallback";
  keyword_ru?: string;
  trend_brief: TrendBrief | null;
  trend_brief_ru: { in: string[]; out: string[] } | null;
  fashion_contract?: FashionContract;
  interior_contract?: InteriorContract;
  error?: string;
};

/**
 * Один вызов ИИ на статью: 3 primary + 3 secondary запроса + перевод ключа для модератора + тренд-справка
 * (photoQueries.ts:119-279). keepAudience принудительно сохраняет слова аудитории, outdoor-слово и слово пола.
 */
export async function generateTopupQueries(
  ctx: AiCtx,
  recipe: ArticleRecipeSnapshot,
  keyword: string,
  cfg: SearchCfg,
  profile: NicheProfile | null,
  attrs: Record<string, unknown> | null | undefined,
): Promise<TopupQueries> {
  const niche = recipe.nicheCode;
  const prof = profile || defaultProfile(niche, recipe.subnicheCode);
  const fashionContract = prof.niche_code === "outfits" ? buildFashionContract(keyword, attrs) : undefined;
  const interiorContract = isInteriorNiche(prof.niche_code, recipe.subnicheCode) ? buildInteriorContract(keyword, attrs) : undefined;
  const negatives = (prof.search_templates?.negative || []).join(", ");
  // Аудитория темы («black women») обязана остаться в каждом запросе, иначе поиск возвращает моделей другой этничности.
  const audience = audienceRule(keyword, niche);
  const gender = genderRule(keyword, niche);
  const genderWord = gender.allow === "female" ? "women" : gender.allow === "male" ? "men" : "";
  const audienceWord = audience ? (keyword.toLowerCase().match(new RegExp(`\\b(${audience.tokens.join("|")})\\b[\\s-]*\\w*`))?.[0] || "").trim() : "";
  const keepAudienceOnly = (q: string) => {
    if (!audience || !audienceWord) return q;
    const first = audienceWord.split(/\s+/)[0];
    return new RegExp(`\\b${first}\\b`, "i").test(q) ? q : `${q} ${audienceWord}`.replace(/\s+/g, " ").trim();
  };
  // Уличная тема обязана остаться уличной: без такого слова поиск отдаёт комнаты.
  const OUTDOOR_WORDS = /\b(?:outdoor|patio|porch|backyard|yard|garden|balcony|deck|terrace|poolside|curb appeal)\b/i;
  const outdoorWord = interiorContract?.setting === "outdoor" ? keyword.match(OUTDOOR_WORDS)?.[0] || "outdoor" : "";
  const keepAudience = (q: string) => {
    const base = keepAudienceOnly(q).replace(/\bazul[\s-]+beb[eé]\b/gi, "azul cielo").replace(/\brosa[\s-]+beb[eé]\b/gi, "rosa pastel");
    const withSetting = !outdoorWord || OUTDOOR_WORDS.test(base) ? base : `${base} ${outdoorWord}`.replace(/\s+/g, " ").trim();
    if (!genderWord || new RegExp(`\\b${genderWord}\\b`, "i").test(withSetting)) return withSetting;
    return `${withSetting} ${genderWord}`.replace(/\s+/g, " ").trim();
  };

  // оригинал: photoQueries.ts:163-189
  const builtInSystem =
    `You rewrite an image-search query into 6 alternative queries for Google Images, split into two priorities.\n` +
    `- "primary": 3 queries closest to the original wording;\n` +
    `- "secondary": 3 DIFFERENT queries for the same topic (synonyms, another angle: ideas, inspiration, real photo, another way to describe the same item/room), used only when primary results are not enough;\n` +
    `Rules:\n` +
    `- keep the EXACT same subject and every defining attribute of the topic (colour, shape, length, motif, room, garment);\n` +
    `- change only the wording: add photography words like "close up", "photo", "inspiration", "real";\n` +
    (negatives ? `- never add these words: ${negatives};\n` : "") +
    `- never add a year, never add "collage", "tutorial", "template", "chart", "printable", "vector";\n` +
    `- English only, 3 to 7 words each, no quotes, no punctuation, all different from each other and from the original.\n` +
    (fashionContract ? `\n${fashionContractPrompt(fashionContract)}\n- In piece mode, every query must retain the hero piece.\n- In look mode, every query must retain the audience/occasion/style intent stated above.\n` : "") +
    (interiorContract
      ? `\n${interiorContractPrompt(interiorContract)}\n` +
        `- In element mode, every query must retain the hero element.\n` +
        `- In room mode, every query must retain the room or outdoor zone.\n` +
        (interiorContract.setting === "outdoor" ? `- This topic is outdoor: every query must keep an outdoor word (patio, porch, backyard, balcony, deck, garden).\n` : "") +
        `- Prefer wording that returns photographs of real homes, never renders or listings.\n`
      : "") +
    (audience ? `- AUDIENCE: this topic is for ${audience.label}. EVERY query must keep the audience words from the original query (for example "${audienceWord}") — dropping them returns the wrong models;\n` : "") +
    (genderWord ? `- AGE/GENDER: every query must include "${genderWord}". The results must show adults; reject babies, children and children's garments unless the original keyword explicitly asks for them;\n` : "") +
    `Return ONLY JSON: {"primary":["...","...","..."],"secondary":["...","...","..."]}`;

  const vars: Record<string, string> = {
    focus_keyword: keyword,
    topic: keyword,
    language: "English",
    target_country: cfg.country,
    niche: String(niche || prof.niche_code || ""),
    subniche: String(recipe.subnicheCode || ""),
    topic_kind: topicKindLabel(prof, keyword),
    outfit_mode: fashionContract?.outfit_mode || "",
    fashion_contract: fashionContract ? fashionContractPrompt(fashionContract) : "",
    decor_mode: interiorContract?.decor_mode || "",
    hero_element: interiorContract?.hero_element || "",
    setting: interiorContract?.setting || "",
    interior_contract: interiorContract ? interiorContractPrompt(interiorContract) : "",
  };
  // Отдельное поле для сотрудника: перевод ключа на русский. Поиск идёт только по "primary"/"secondary".
  const RU_NOTE =
    `\n\nADDITIONAL FIELD (for a human moderator's UI only, NEVER a search query):\n` +
    `"moderator_translation_ru": natural Russian translation of the ORIGINAL query meaning (not of your rewritten queries). ` +
    `Keep brand names as is, add nothing. Russian is allowed ONLY in this field; "queries" stay in the search language.\n` +
    `Final JSON shape: {"primary":["...","...","..."],"secondary":["...","...","..."],"moderator_translation_ru":"..."}. ` +
    `If your instructions above ask for a single "queries" list, still return 6 queries split into "primary" (3 closest) and "secondary" (3 different angles).`;

  // Промт набора: неизвестные переменные — ошибка этапа (правило 08-plan §3 п.3), поэтому подстановка вне try.
  const configured = await resolvePromptOptional(recipe, "rp_photo_search");
  const filled = configured ? fillPrompt(configured, vars) : null;
  const system = (filled?.system ? filled.system : builtInSystem) + RU_NOTE + trendBriefInstruction(keyword);
  const userPrompt = filled?.user ? filled.user : `Original query: "${keyword}"\nNiche: ${prof.label}${niche ? ` (${niche})` : ""}`;

  const fallback = (error?: string, extra: Partial<TopupQueries> = {}): TopupQueries => {
    const qs = fallbackQueries(keyword, niche, prof).map(keepAudience);
    return { primary: qs.slice(0, 3), secondary: qs.slice(3, 6), queries: qs, source: "fallback", fashion_contract: fashionContract, interior_contract: interiorContract, trend_brief: null, trend_brief_ru: null, error, ...extra };
  };

  try {
    const r = await aiChat(ctx, {
      slot: SLOTS.textFast,
      model: stageModel(recipe, "rp_photo_search"),
      system,
      user: userPrompt,
      json: true,
      temperature: 0.6,
      maxTokens: 1200,
      timeoutMs: 45_000,
    });
    const parsed = (r.json && typeof r.json === "object" ? r.json : {}) as Record<string, unknown>;
    const ruRaw = String(parsed.moderator_translation_ru || "").trim().slice(0, 200);
    const keyword_ru = /[Ѐ-ӿ]/.test(ruRaw) ? ruRaw : undefined;
    const trend_brief = parseTrendBrief(parsed.trend_brief, keyword);
    const ruB = parsed.trend_brief_ru && typeof parsed.trend_brief_ru === "object" ? (parsed.trend_brief_ru as Record<string, unknown>) : null;
    const trend_brief_ru = ruB ? { in: strList(ruB.in), out: strList(ruB.out) } : null;

    const cleanList = (v: unknown, n: number) =>
      (Array.isArray(v) ? v.slice(0, n) : [])
        .map((q) => keepAudience(String(q || "").replace(/["']/g, "").trim()))
        // Кириллица в поисковом запросе = модель перепутала поля — такой запрос выбрасываем.
        .filter((q) => !/[Ѐ-ӿ]/.test(q))
        .filter((q) => q.length >= 3 && q.toLowerCase() !== keyword.toLowerCase());
    let primary = [...new Set(cleanList(parsed.primary, 3))];
    let secondary = [...new Set([...cleanList(parsed.secondary, 3), ...cleanList(parsed.queries, 6)])].filter((q) => !primary.some((p) => p.toLowerCase() === q.toLowerCase())).slice(0, 3);
    const total = primary.length + secondary.length;
    // Модель дала меньше 6 — дополняем шаблонами, чтобы второй приоритет был всегда.
    if (total >= 2 && total < 6) {
      for (const q of fallbackQueries(keyword, niche, prof).map(keepAudience)) {
        if (primary.length + secondary.length >= 6) break;
        const dup = [...primary, ...secondary].some((x) => x.toLowerCase() === q.toLowerCase()) || q.toLowerCase() === keyword.toLowerCase();
        if (dup) continue;
        if (primary.length < 3) primary = [...primary, q];
        else secondary = [...secondary, q];
      }
    }
    if (primary.length + secondary.length >= 2) {
      return { primary, secondary, queries: [...primary, ...secondary], source: "ai", fashion_contract: fashionContract, interior_contract: interiorContract, keyword_ru, trend_brief, trend_brief_ru };
    }
    return fallback("модель вернула мало вариантов", { keyword_ru, trend_brief, trend_brief_ru });
  } catch (e) {
    return fallback((e as Error).message.slice(0, 160));
  }
}
