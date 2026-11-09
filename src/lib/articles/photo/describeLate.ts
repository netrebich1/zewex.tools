/**
 * Позднее описание фото (cost-fixes-b, 2026-10-16, п.1): факты и описание 30–60 слов пишутся только фото, которые
 * остались в статье после модерации (PHOTO_REVIEW / ИИ-модерация), а не всем 110 оценённым. Вызывается в начале
 * этапа plan (первый текстовый этап) — расход попадает в окно этапа plan (UsageLog refId = статья, costs.ts → «Текст»).
 *
 * Кого описываем (`needsLateDescription` в rateSlim.ts):
 *  - rateMode = slim: все активные ArtPhoto без описания (тонкая оценка описание не сохраняет, `slimJudgement`);
 *  - rateMode = full (по умолчанию): только фото совсем без фактов и описания — это же делал этап sections по одному
 *    фото (`describePhoto`), теперь раньше и пачками; при полных фактах ничего не делаем.
 * Результат пишется в ArtPhoto.facts / ArtPhoto.description — ровно туда, откуда их читают plan (`buildPromptVars`,
 * `uniqueHeading`) и sections (`factsLine`, `photo_description`). Тонкие факты сливаются с полными: поле из тонкой
 * оценки остаётся, если полное описание его не дало. Идемпотентно: при повторе этапа описанные фото пропускаются.
 */
import { prisma } from "@/lib/db";
import type { ArtPhoto } from "@prisma/client";
import type { AiCtx } from "@/lib/articles/ai";
import type { ArticleRecipeSnapshot } from "@/lib/articles/types";
import { stageModel } from "@/lib/articles/prompts";
import { describePhoto, describePhotosBatch } from "@/lib/articles/text/photoDescribe";
import { sanitizeFacts } from "./factSanitize";
import type { NicheProfile } from "./profile";
import { needsLateDescription } from "./rateSlim";

export type LateDescribeCtx = {
  ai: AiCtx;
  recipe: ArticleRecipeSnapshot;
  signal?: AbortSignal;
  tick?: (label: string) => Promise<void>;
  log?: (msg: string) => void;
  /** Описывать по одному фото за вызов (мешап-статьи Article Copy): пачка из 8 кадров иногда путает описания между кадрами. */
  single?: boolean;
};

/** Модель второй попытки одиночного описания, когда основная не дала разбираемого ответа. */
const RETRY_MODEL = "openrouter:google/gemini-2.5-flash";
/** Правила точности для описаний мешапа (аудит 07.11.2026: выдуманная длина волос, «подсветка» там, где её нет, коллажи). */
const COPY_RULES = `STRICTNESS RULES:
- State a length (hair: chin, collarbone, mid-back; nails: short, medium, long) ONLY if the ends are fully inside the frame; otherwise write "" and do not mention length in the description.
- Highlights, streaks, balayage, money piece, root shadow: only when clearly distinct lighter or darker strands are visible; shine or lighting is not highlights.
- Shape (nail shape, cut name, bangs type) only when unambiguous; otherwise "".
- If the frame shows several people, several hands sets, a grid or a collage, start the description with "Collage:" and describe only the element they share.
- Copy colors as seen (light blue is not lavender, beige is not nude, black is not dark gray).`;

export type LateDescribeResult = { needed: number; described: number; failed: number; costUsd: number; calls: number };

/** Слова длины волос: описатель называет длину по обрезанному кадру (аудит v2 07.11: collarbone, mid-back там, где концов не видно). */
const HAIR_LENGTH_RE = [
  /\b(?:chin|jaw|jawline|collarbone|shoulder|chest|bra[- ]strap|mid[- ]back|waist|hip|armpit|elbow)[- ]length(?:\s+ends)?\b/gi,
  /(?:,\s*)?\b(?:that|which|and)?\s*\b(?:falls?|falling|reach(?:es)?|reaching|ends?|ending|hits?|hitting|grazes?|grazing|sits?|sitting|cut|trimmed|skims?|skimming|lands?|landing|stops?|stopping|extends?|extending|hangs?|hanging)\s+(?:just\s+|right\s+|well\s+|down\s+)?(?:(?:to|at|past|below|above|around|near|beneath|beyond)\s+)?(?:the\s+|her\s+)?(?:chin|jaw|jawline|collarbones?|shoulders?|shoulder blades?|chest|bust|bra strap|mid[- ]back|waist|waistline|hips?|armpits?|lower back|elbows?|ribs?|ribcage)\b/gi,
  /\b(?:long|short|medium|mid|shoulder)[- ]length\s+(?=hair|layers|cut|style|strands)/gi,
  /\b(?:very|extra|super)?\s*(?:long|short)\s+(?=hair\b|strands\b|lengths?\b)/gi,
];
/** Убрать упоминания длины из описания волос; пробелы и знаки после вырезки приводятся в порядок. */
export function stripHairLength(text: string): string {
  let s = text;
  for (const re of HAIR_LENGTH_RE) s = s.replace(re, "");
  return s
    .replace(/\b(?:with|that|which|and|but|of)\s*(?=[,.;])/g, "")
    .replace(/\s+([,.;:])/g, "$1").replace(/,\s*,/g, ",").replace(/,\s*\./g, ".").replace(/\(\s*\)/g, "").replace(/ {2,}/g, " ").trim()
    .replace(/(^|[.!?]\s+)[A-Za-z]+\.(?=\s|$)/g, "$1").replace(/ {2,}/g, " ").trim()
    .replace(/(^|[.!?]\s+)([a-z])/g, (_m, a: string, c: string) => a + c.toUpperCase());
}
/** Факты, которые говорят о длине: length, hair_length, visible_length… */
const LENGTH_FACT_RE = /length/i;

const hasFacts = (facts: unknown) => !!sanitizeFacts(facts);

/** Фото статьи, которым ещё нужно описание. */
export function photosNeedingDescription(photos: ArtPhoto[], recipe: ArticleRecipeSnapshot): ArtPhoto[] {
  const mode = recipe.photoSearch?.rateMode;
  return photos.filter((p) => !p.excluded && needsLateDescription(p, mode, hasFacts(p.facts)));
}

/**
 * Описать недостающее и записать в ArtPhoto. Модель — как у оценки фото в сценарии (`rp_photo_rate`, обычно flash-lite),
 * иначе модель правила слота vision. Возвращает счётчики для сводки этапа («описаны N фото»).
 */
export async function describeLatePhotos(ctx: LateDescribeCtx, photos: ArtPhoto[], profile: NicheProfile, keyword: string): Promise<LateDescribeResult> {
  const todo = photosNeedingDescription(photos, ctx.recipe);
  const res: LateDescribeResult = { needed: todo.length, described: 0, failed: 0, costUsd: 0, calls: 0 };
  if (!todo.length) return res;
  const model = stageModel(ctx.recipe, "rp_photo_rate");
  await ctx.tick?.(`Описание фото: ${todo.length}`);
  const batch = ctx.single
    ? { described: new Map<string, { facts: Record<string, unknown>; description: string }>(), costUsd: 0, calls: 0, failed: todo.map((p) => p.id) }
    : await describePhotosBatch(ctx.ai, profile, keyword, todo, { model, signal: ctx.signal });
  res.costUsd += batch.costUsd;
  res.calls += batch.calls;

  const byId = new Map(todo.map((p) => [p.id, p]));
  const save = async (p: ArtPhoto, d: { facts: Record<string, unknown>; description: string }) => {
    // Тонкие факты оценки дополняют полные там, где модель описания оставила поле пустым.
    const prev = (sanitizeFacts(p.facts) ?? {}) as Record<string, string>;
    const facts: Record<string, unknown> = { ...prev, ...d.facts };
    let description = d.description;
    if (ctx.single && profile.niche_code === "hair") {
      // Мешап волос: длину не пишем вообще — ни в описании, ни в фактах.
      description = stripHairLength(description);
      for (const k of Object.keys(facts)) if (LENGTH_FACT_RE.test(k)) delete facts[k];
    }
    await prisma.artPhoto.updateMany({ where: { id: p.id }, data: { facts: facts as object, description } });
    res.described++;
  };
  for (const [id, d] of batch.described) {
    const p = byId.get(id);
    if (p) await save(p, d);
  }
  // Пропущенные пачкой — по одному (прежний фолбэк sections).
  for (const id of batch.failed) {
    const p = byId.get(id);
    if (!p) continue;
    await ctx.tick?.(`Описание фото ${p.position}`);
    let d = await describePhoto(ctx.ai, profile, keyword, p, model, ctx.single ? { extraRules: COPY_RULES } : {});
    res.calls++;
    if (!d && ctx.single) { d = await describePhoto(ctx.ai, profile, keyword, p, RETRY_MODEL, { extraRules: COPY_RULES }); res.calls++; }
    if (d) await save(p, d);
    else {
      res.failed++;
      ctx.log?.(`фото ${p.position}: модель не дала описания — секцию опишет этап sections или она будет отложена`);
    }
  }
  return res;
}
