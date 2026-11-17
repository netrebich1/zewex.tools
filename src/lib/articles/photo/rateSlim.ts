/**
 * «Тонкая» оценка фото (cost-fixes-b, 2026-10-16, п.1): `PhotoSearchConfig.rateMode = "slim"`.
 *
 * Сейчас rate пишет на КАЖДОЕ оценённое фото ~280 токенов (4 оценки качества, тренд, каталог, ИИ, факты из ~10 полей,
 * описание 30–60 слов), хотя 65% тут же отклоняет, а факты/описание нужны только ~31 итоговому фото из 110. В тонком
 * режиме модель отдаёт вердикт, баллы, флаги, причину и ТОЛЬКО те поля фактов, по которым отбор раскладывает фото
 * (оси разнообразия профиля ниши — `diversity_axes`, см. `photo/diversity.ts`: признаки ищутся словами в aiFacts /
 * aiDescription / title). Полные факты и описание итоговым фото пишет `photo/describeLate.ts` в начале этапа plan.
 *
 * Пока НЕ подключено к worker/articles/stages/rate.ts — только контракт и помощники; подключение: в JSON_CONTRACT
 * заменить часть «facts/description» на `slimJsonContract(profile)`, перед записью результата прогнать `slimJudgement`.
 */
import type { NicheProfile } from "./profile";
import type { RatingJudgement } from "./ranking";

/**
 * Поля фактов, которые нужны отбору для разнообразия, по нишам. Соответствие осей профиля полям `photo_facts`:
 *  nails:    color → colors, design → decor, shape/length → shape_length, finish → finish
 *  hair:     color → colour, length, texture, styling, bangs
 *  outfits:  color → palette, garment → hero_piece, layer → layers, silhouette, shoes
 *  interior: palette, zone → hero_element + key_pieces, style, material → materials, light → lighting
 *  tattoo:   placement, style, size, subject, colour_mode;  makeup: focus, technique, palette, finish, intensity
 */
export const SLIM_FACT_KEYS: Record<string, string[]> = {
  nails: ["colors", "shape_length", "finish", "decor"],
  manicure: ["colors", "shape_length", "finish", "decor"],
  pedicure: ["colors", "shape_length", "finish", "decor"],
  hair: ["colour", "length", "texture", "styling", "bangs"],
  outfits: ["hero_piece", "layers", "palette", "silhouette", "shoes"],
  interior: ["palette", "hero_element", "key_pieces", "style", "materials", "lighting"],
  decor: ["palette", "hero_element", "key_pieces", "style", "materials", "lighting"],
  outdoor: ["palette", "hero_element", "key_pieces", "style", "materials", "lighting"],
  tattoo: ["placement", "style", "size", "subject", "colour_mode"],
  makeup: ["focus", "technique", "palette", "finish", "intensity"],
};

/** Сколько полей берём у ниши без таблицы выше (первые поля профиля). */
const FALLBACK_KEYS = 4;

/** Поля фактов тонкой оценки для профиля: из таблицы, но только те, что есть у профиля; иначе первые поля профиля. */
export function slimFactKeys(profile: NicheProfile): string[] {
  const all = Object.keys(profile.fact_block?.photo_facts || {});
  const want = SLIM_FACT_KEYS[profile.niche_code] || [];
  const picked = want.filter((k) => all.includes(k));
  if (picked.length) return picked;
  return all.slice(0, FALLBACK_KEYS);
}

/** Пустой скелет фактов для образца JSON (аналог photoFactSkeleton, но только поля разнообразия). */
export function slimFactSkeleton(profile: NicheProfile): string {
  const keys = slimFactKeys(profile);
  return (keys.length ? keys : ["description_facts"]).map((k) => `"${k}":""`).join(",");
}

/** Инструкция по полям тонкой оценки: те же описания полей, что у полной (без примеров), только по выбранным ключам. */
export function slimFactRules(profile: NicheProfile): string {
  const desc = profile.fact_block?.photo_facts || {};
  const lines = slimFactKeys(profile).map((k) => `- ${k}: ${String(desc[k] || "what you see").replace(/\s*\(e\.g\.[^)]*\)/gi, "").trim()}`);
  return (
    `FACT FIELDS (kept photos only) — 1-6 plain words each with the VALUE you actually SEE (a shade, a shape, a garment); ` +
    `the text after the field name is an instruction, never a value; not visible → "".\n` +
    lines.join("\n")
  );
}

/**
 * Хвост JSON-контракта тонкой оценки — вместо строки с `"facts":{…полный скелет…},"description":"30-60 words…"`
 * в rate.ts. Поля вердикта и оценок — те же, что сейчас читает `judgeRatingItem`/`readBreakdown`, описания нет.
 */
export function slimJsonContract(profile: NicheProfile): string {
  return (
    `\n${slimFactRules(profile)}\nReturn ONLY JSON:\n` +
    `{"photos":[{"n":1,"score":8,"verdict":"keep","topic_ok":true,"topic_miss":"","catalogue":false,"catalogue_reason":"",` +
    `"ai_likelihood":8,"ai_artifacts":[],"subject_age":"adult","virality":78,"trend":72,"trend_reason":"","composition":64,"lighting":71,"framing":58,` +
    `"reason":"clean close-up, on topic","facts":{${slimFactSkeleton(profile)}}}]}\n` +
    `score: 1-10 (topic fit). verdict: "keep" or "reject". reason: max 12 words. facts: empty object for rejected photos. No "description" field.`
  );
}

/**
 * Пометка тонкой оценки на результате `judgeRatingItem`: описание не сохраняем (judgeRatingItem подставляет текст из
 * фактов, когда модель не дала описания — для тонкого режима это не описание), в aiBreakdown ставим `slim: true`.
 * Пустое описание у ArtPhoto — признак для `describeLate`, что фото ещё нужно описать.
 */
export function slimJudgement(j: RatingJudgement): RatingJudgement {
  return { ...j, description: null, breakdown: { ...j.breakdown, slim: true } };
}

/** Фото/кандидат оценён тонко или вовсе без описания — полное описание ещё предстоит написать. */
export function needsLateDescription(p: { description?: string | null; facts?: unknown }, rateMode: "full" | "slim" | undefined, hasFacts: boolean): boolean {
  const noDescription = !String(p.description || "").trim();
  if (rateMode === "slim") return noDescription;
  // Полный режим — как раньше: описываем только фото совсем без фактов и описания (sections делал это же, но позже).
  return noDescription && !hasFacts;
}
