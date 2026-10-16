/**
 * Этап `sections` (шаг 73 оригинала, stage7-write-sections/index.ts, ветка real_photo/compact3; раскладка волн —
 * direct-pipeline.runStage73:2192-2395). Писатель `stage_7_writer_system` + `stage_7_writer_user`, пачки
 * recipe.text.batchSize (по умолчанию 5; оригинал ||8), волны по 7 (3 для claude/sonnet) параллельных вызовов,
 * минимум 40 слов, 2 попытки на пачку, частичный результат сохраняется. Недостающие → пачками по 3 (≤2 круга) →
 * по одной. Пустые секции после всех попыток → fatal с перечнем позиций, ничего не удаляется (08-plan §3 п.8).
 *
 * Исправления аудита 03: номер секции берётся из ответа модели, не по позиции в пачке (§7.2, 08-plan §3 п.7);
 * фото без фактов чинится по одному и не валит пачку (§7.5); сырой ответ модели никогда не становится текстом (§7.6);
 * проверка «остались ли {{…}}» — через fillPrompt (§7.4).
 */
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/db";
import type { ArtPhoto, ArtSection } from "@prisma/client";
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import { aiChat, imagePart, type ContentPart } from "@/lib/articles/ai";
import { SLOTS } from "@/lib/articles/types";
import { resolvePrompt, fillPrompt, stageModel, type ResolvedPrompt } from "@/lib/articles/prompts";
import { absPath, exists } from "@/lib/articles/storage";
import { countTokenPromptBlock } from "@/lib/articles/text/countToken";
import { containsInternalLabel, countWordsFromHtml, headingKey, looksLikeFactDump, sanitizeTopic, stripInternalLabels, stripLeadingFactDump, uniqueHeading } from "@/lib/articles/text/textGuards";
import { looksLikeModelThinking, looksLikeRawJson } from "@/lib/articles/text/introOutroParse";
import { extractJsonFromResponse, extractLikelySectionObjects, toSectionList } from "@/lib/articles/text/jsonRepair";
import { cleanArticleHtml } from "@/lib/articles/text/html";
import { describePhoto } from "@/lib/articles/text/photoDescribe";
import { buildPromptVars, factsLine, focusKeywordOf, isOutfitsNiche, loadProfile, type JsonRecord } from "@/lib/articles/text/vars";
import { BANNED_PROMPT_LINE, findBannedPhrases, findOverused, overusedPhrases, polishHeading, polishHtml, repeatedWithinArticle, usesUsSpelling, type PolishOpts } from "@/lib/articles/text/polish";
import type { NicheProfile } from "@/lib/articles/photo/profile";
import type { ArtStageCtx, ArtStageHandler } from "./index";
import { briefOf, isWritten, loadActivePhotos, loadPhotoSections, MAX_PHOTO_POS } from "./plan";

const SYSTEM_KEY = "stage_7_writer_system";
const USER_KEY = "stage_7_writer_user";
/** Минимум слов в секции (оригинал: 184, 754) */
const MIN_WORDS = 40;
/** Пачка по умолчанию (задание: 5; оригинал: stage7_batch_size || 8) */
const DEFAULT_BATCH = 5;

// ───────────────────────── бриф секции (оригинал: buildRecipeBrief 961-982, buildCompact3Brief 2974-3208 — только ветка real_photo) ─────────────────────────

// Аудит text-v2: подсказки углов и заходов больше не просят первое лицо, «реакцию» и «признание» — именно они
// превращались в «I wore these to a wedding» и «I was skeptical». Старые ключи (personal_story, skeptic, reaction,
// confession, scene, opinion) остаются для уже сохранённых рецептов секций, но с нейтральной подсказкой.
const ANGLE_HINTS: Record<string, string> = {
  photo_read: "read this exact design: what makes it work, using only the photo facts",
  how_to_ask: "the exact words to ask the tech or stylist for, built from the visible details",
  personal_story: "who this suits and the one detail that makes it work",
  mistake: "the mistake people make with this look and how to dodge it",
  comparison: "set it against a close alternative and say which suits whom",
  who_suits: "who this genuinely flatters and who should pass",
  wear_reality: "how this finish or cut typically wears and what upkeep it needs (general knowledge, never a personal test)",
  cost_time: "how much time and upkeep it takes (chair time, refills, trims), never money",
  seasonal: "why it lands in this season or setting",
  technique: "how it is built, technically",
  diy_howto: "how to get close to it at home",
  honest_take: "a fair look at the trade-off and who should skip it",
  skeptic: "a fair look at the trade-off and who should skip it",
};
const OPENER_HINTS: Record<string, string> = {
  observation: "open with a precise observation about the design",
  verdict: "open with a clear one-line assessment",
  question: "open with a question the reader actually has",
  fact: "open with a concrete fact about the design",
  rule: "open with a practical rule",
  contrast: "open by setting it against a close alternative",
  reaction: "open with a precise observation about the design",
  opinion: "open with a clear one-line assessment",
  confession: "open with a concrete fact about the design",
  scene: "open with where or when this works best",
};
/** Объёмы по рецепту (оригинал: 958) */
const LENGTH_WORDS: Record<string, string> = { short: "70-95 words", medium: "110-135 words", long: "150-185 words" };

/** Рецепт шага «План секций» → инструкция автору. */
function buildRecipeBrief(position: number, heading: string, r: JsonRecord): string {
  const lines: string[] = [];
  lines.push(`Section ${position} — ${heading}`);
  lines.push(`  ANGLE: ${String(r.angle)} (${ANGLE_HINTS[String(r.angle)] || "as named"})`);
  lines.push(`  OPENING: ${OPENER_HINTS[String(r.opener)] || String(r.opener)}`);
  lines.push(`  LENGTH: ${LENGTH_WORDS[String(r.length)] || "110-135 words"}, ${Number(r.paragraphs) === 2 ? "two paragraphs" : "one paragraph"}`);
  if (r.focus_fact) lines.push(`  LEAN ON: ${String(r.focus_fact)}`);
  const yes: string[] = [];
  const no: string[] = [];
  (r.include_list ? yes : no).push(`short list${r.include_list && r.list_focus ? ` about ${String(r.list_focus)}` : ""}`);
  (r.include_care ? yes : no).push("wear + upkeep");
  (r.include_occasion ? yes : no).push("season / occasion");
  (r.include_diy_vs_salon ? yes : no).push("DIY vs salon");
  (r.include_honest_minus ? yes : no).push("honest downside");
  if (yes.length) lines.push(`  INCLUDE: ${yes.join(", ")}`);
  if (no.length) lines.push(`  DO NOT INCLUDE: ${no.join(", ")}`);
  if (Array.isArray(r.avoid) && r.avoid.length) lines.push(`  AVOID (already used nearby): ${(r.avoid as unknown[]).join(", ")}`);
  if (r.note) lines.push(`  NOTE: ${String(r.note)}`);
  if (r.narrative_role) lines.push(`  NARRATIVE ROLE: ${String(r.narrative_role)}`);
  if (r.reader_question) lines.push(`  READER QUESTION: ${String(r.reader_question)}`);
  if (r.primary_takeaway) lines.push(`  PRIMARY TAKEAWAY: ${String(r.primary_takeaway)}`);
  return lines.join("\n");
}

/**
 * Поля плана секции (rp_photo_plan), которые идут автору как сырой материал; служебные и фото-поля не дублируем.
 * Аудит text-v2: планировщик сочинял «опыт» (real_experience «I wore these to a summer wedding», сроки носки,
 * переходы, оценки, вердикты), автор вставлял его дословно — эти поля автору больше не показываются, даже в планах,
 * сохранённых до правки промтов. Формат/регистр/ритм заданы рецептом секции (section_plan) и тут только спорили с ним.
 */
const BRIEF_SKIP = new Set([
  "recipe", "h2", "h2_draft", "name", "photo_id", "photo_n", "position", "section_number", "keywords_to_bold", "seo_keyword",
  "fashion_contract", "interior_contract", "outfit_id", "photo_facts", "photo_description", "photo_caption", "photo_source_url",
  "photo_url", "format_used", "register_used", "keywords_used", "batch_number", "role", "revised",
  // выдуманный опыт и служебные оценки плана
  "real_experience", "estimated_wear_time", "transition_from_previous", "stylist_score", "color_palette", "style_verdict",
  "standalone_sentence", "standalone_type", "angle_note", "reaction", "hero_piece", "celebrity_inspiration",
  // структура — из рецепта секции
  "format", "register", "voice_seed", "sentence_rhythm", "disorder_element", "target_word_count", "section_angle", "bonus_type",
]);
/** Ключи плана, которые модель переносила в текст как термины («hero piece»): показываем автору понятным словом. */
const BRIEF_RENAME: Record<string, string> = { hero_piece: "main_item", fashion_details: "outfit_details", interior_details: "room_details" };

/** Бриф одной секции real_photo: заголовок, рецепт, план секции, SEO, направление. Фото — отдельно (вложение или описание). */
function buildSectionBrief(sec: ArtSection, photo: ArtPhoto, previousEnding: string | undefined, boldedSoFar: string[], photoAttached: boolean, nicheCode: string): string {
  const b = briefOf(sec);
  const recipe = b.recipe && typeof b.recipe === "object" ? (b.recipe as JsonRecord) : null;
  let brief = `SECTION ${sec.position}: ${sec.heading || String(b.h2_draft || "")}\n`;
  if (recipe) brief += `${buildRecipeBrief(sec.position, sec.heading, recipe)}\n`;
  if (photoAttached) brief += `Photo of this section is attached — describe what you SEE, verify colors and details.\n`;
  brief += `\n══ SECTION PLAN ══\n`;
  if (b.role) brief += `role: ${String(b.role)}\n`;
  for (const [k, v] of Object.entries(b)) {
    if (BRIEF_SKIP.has(k) || v == null || v === "") continue;
    const label = BRIEF_RENAME[k] ?? k;
    if (typeof v === "object") {
      const line = Array.isArray(v) ? (v as unknown[]).map(String).filter(Boolean).join(", ") : factsLine(renameKeys(v as JsonRecord));
      if (line) brief += `${label}: ${line}\n`;
    } else {
      brief += `${label}: ${String(v)}\n`;
    }
  }
  brief += `\n══ SEO ══\n`;
  const kws = Array.isArray(b.keywords_to_bold) ? (b.keywords_to_bold as unknown[]).map(String).filter(Boolean) : [];
  if (kws.length) brief += `Keywords to use once, in plain text: ${kws.join(", ")}\n`;
  if (b.seo_keyword) brief += `Keyword to weave: "${String(b.seo_keyword)}"\n`;
  if (boldedSoFar.length) brief += `Already used earlier (do not repeat): ${boldedSoFar.join(", ")}\n`;
  if (previousEnding) brief += `\n══ PREVIOUS SECTION ENDED WITH ══\n"${previousEnding.slice(0, 200)}"\nTransition naturally.\n`;
  brief += `\n══ DIRECTION ══\n`;
  if (photoAttached) brief += `Photo is attached. IN DISPUTES: PHOTO WINS over brief text.\n`;
  if (recipe) {
    brief += `THE RECIPE ABOVE IS AUTHORITATIVE: its length, paragraph count, angle, opening and blocks override every other length or structure rule.\n`;
    brief += `Cover only what the recipe allows — do not add care, occasion, lists or downsides it excludes.\n`;
  } else {
    brief += `Follow the length and structure rules from the writer prompt.\n`;
    brief += `Include: what the photo actually shows, how the look wears in real life, care/maintenance, your honest take.\n`;
  }
  brief += `Connect facts logically: each sentence follows from the previous.\n`;
  // Одежде нужны посадка, длина и видимая фактура ткани (аудит text-v2, п. 8): запрет «sizing or fabrics» снят.
  if (isOutfitsNiche(nicheCode)) {
    brief += `NEVER mention prices, brands or shops: this article sells nothing. Fit, length, proportion and visible fabric texture are welcome; never claim fabric composition or comfort you cannot see.\n`;
  } else {
    brief += `NEVER mention prices, brands or shops: this article sells nothing.\n`;
  }
  brief += `ACCURACY: describe only what the photo facts state; if unsure about a detail (a stone, a pattern, bangs, a fabric), do not name it.\n`;
  brief += `NEVER write "in the photo", "pictured above" or reference the image itself, and never say what is NOT visible.\n`;
  brief += `DO NOT: invent personal anecdotes, wear tests, salon visits, compliments or exact wear durations; create "I doubted then loved" arcs; write sentences with zero facts.\n`;
  brief += `SEMANTIC MARKUP: NO emphasis, never use <strong>/<b>/<em>/<i>, never markdown **word** or _word_.\n`;
  void photo;
  return brief;
}

function renameKeys(o: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  for (const [k, v] of Object.entries(o)) out[BRIEF_RENAME[k] ?? k] = v;
  return out;
}

/** Блок описаний фото для режима без вложений (оригинал: 553-579; персона «Maya» заменена на нейтральную формулировку). */
function photoDescriptionsBlock(batch: ArtSection[], photoById: Map<string, ArtPhoto>): string {
  const blocks = batch
    .map((sec) => {
      const p = sec.photoId ? photoById.get(sec.photoId) : undefined;
      const d = factsLine(p?.facts) || p?.description || null;
      if (!d) return null;
      return `Section ${sec.position} — ${sec.heading}\nPHOTO: ${d}`;
    })
    .filter(Boolean);
  if (!blocks.length) return "";
  return (
    `\n\nPHOTO DESCRIPTIONS (one per section). Visual facts come ONLY from here: never invent ` +
    `a shade, shape, length, finish or detail that is not listed, and if a detail is uncertain, leave it out. ` +
    `Do NOT paraphrase the description as a caption: explain who the design suits, what to ask for, ` +
    `how this kind of finish or cut typically wears and what upkeep it needs (general knowledge, never a personal test). ` +
    `Never write "in the photo", "pictured above" or reference the image itself. Never invent personal testing, ` +
    `salon visits, compliments, exact wear duration or first-person anecdotes. Give only the recipe's single primary ` +
    `takeaway and avoid repeating advice from adjacent sections.\n` +
    `HARD BAN: never copy this data structure into the text: no "key: value" pairs, no comma-only ` +
    `lists of attributes ("Long coffin shape, filed to a sharp point, glossy red"), no opening ` +
    `sentence that only enumerates shape/length/finish/color. Every section must open with a ` +
    `full sentence containing a verb, and weave the visual facts into prose later.\n${blocks.join("\n\n")}`
  );
}

/** Текстовые модели не принимают изображения (оригинал: 539-543). Неизвестная модель правила — пробуем, при отказе повтор без фото. */
function modelSupportsVision(m: string | undefined): boolean {
  if (!m) return true;
  const s = m.toLowerCase();
  if (/deepseek|qwen|mistral|llama|kimi|glm|minimax|nemotron/.test(s)) return false;
  return /gemini|gpt|claude|sonnet|haiku|opus|grok|pixtral|vision|o3|o4/.test(s);
}

async function photoContent(photo: ArtPhoto): Promise<ContentPart | null> {
  if (photo.path && (await exists(photo.path))) return imagePart(await readFile(absPath(photo.path)), "image/jpeg", "auto");
  const url = photo.wpUrl || photo.publicUrl;
  if (/^https?:\/\//i.test(url || "")) return { type: "image_url", image_url: { url: url!, detail: "auto" } };
  return null;
}

/**
 * Номер секции — из ответа модели; чужие и отсутствующие номера отбрасываются, кроме случая «одна ожидаемая — один объект».
 * Пропуск в середине пачки = «недостающая секция», а не сдвиг текстов на чужие фото (аудит 03, §7.2).
 */
export function normalizeSections(list: JsonRecord[], expected: number[], raw: string): JsonRecord[] {
  const exp = new Set(expected);
  const out = new Map<number, JsonRecord>();
  for (const sec of list) {
    const n = Number(sec.section_number ?? sec.section ?? sec.number ?? sec.position ?? NaN);
    if (Number.isFinite(n) && exp.has(n)) {
      if (!out.has(n)) out.set(n, { ...sec, section_number: n });
      continue;
    }
    if (expected.length === 1 && list.length === 1) out.set(expected[0], { ...sec, section_number: expected[0] });
  }
  if (out.size) return [...out.values()];
  return extractLikelySectionObjects(raw, expected);
}

type BatchOutcome = { written: number[]; missing: number[]; transient: boolean; reasons: string[] };

type WriterEnv = {
  ctx: ArtStageCtx;
  profile: NicheProfile;
  sysPrompt: ResolvedPrompt;
  userPrompt: ResolvedPrompt;
  model: string | undefined;
  attachPhotos: boolean;
  photos: ArtPhoto[];
  photoById: Map<string, ArtPhoto>;
  usedHeadings: Set<string>;
  totalBatches: number;
  maxTokens: number;
  /** Чистка текста (тире, американское написание) */
  pol: PolishOpts;
  /** Обороты, затёртые на сайте (последние статьи той же ниши) — автору как запрет */
  overused: string[];
};

async function writeBatch(env: WriterEnv, batch: ArtSection[], batchNumber: number): Promise<BatchOutcome> {
  const { ctx, photoById } = env;
  const { article } = ctx;
  const expected = batch.map((s) => s.position);
  const outcome: BatchOutcome = { written: [], missing: [...expected], transient: false, reasons: [] };

  // Контекст предыдущих пачек — по уже написанным секциям статьи (параллельные волны видят друг друга частично, как в оригинале).
  const all = await loadPhotoSections(article.id);
  const written = all.filter(isWritten);
  const boldedSoFar: string[] = [];
  const briefs = batch
    .map((sec, i) => {
      const photo = photoById.get(sec.photoId!)!;
      const prev = i > 0 ? batch[i - 1] : null;
      const prevEnding = prev ? String((briefOf(prev).recipe as JsonRecord | undefined)?.primary_takeaway || "") || undefined : undefined;
      const text = buildSectionBrief(sec, photo, prevEnding, [...boldedSoFar], env.attachPhotos, ctx.recipe.nicheCode);
      const kws = briefOf(sec).keywords_to_bold;
      if (Array.isArray(kws)) boldedSoFar.push(...(kws as unknown[]).map(String));
      return text;
    })
    .join("\n\n");
  if (!briefs.trim()) throw new Error("Брифы секций пустые — автору нечего писать");

  const vars = await buildPromptVars(ctx, {
    photos: env.photos,
    sections: all,
    batch,
    written,
    profile: env.profile,
    extra: { batch_number: batchNumber, total_batches: env.totalBatches, batch_size: batch.length, section_briefs: briefs, batch_sections: briefs, section_brief: briefs },
  });
  // system = system+user набора «постоянный блок»; system набора «секции» перекрывает (оригинал: 455-461)
  const sysF = fillPrompt(env.sysPrompt, vars);
  const userF = fillPrompt(env.userPrompt, vars);
  let system = [sysF.system, sysF.user].filter((x) => x.trim()).join("\n\n");
  if (userF.system.trim()) system = userF.system;
  system += `\n\n${countTokenPromptBlock()}`;
  // Стоп-лист поверх промта набора (его могли править в портале) и затёртые на сайте обороты (аудит text-v2, п. 10–11).
  system += `\n\n${BANNED_PROMPT_LINE}`;
  if (env.overused.length) system += `\nOVERUSED ON THIS SITE (never use these phrases or close variants): ${env.overused.slice(0, 15).map((g) => `"${g}"`).join(", ")}.`;
  let user = userF.user;
  if (!user.includes("SECTION BRIEFS") && !user.includes("SECTION PLANS FOR THIS BATCH")) user += `\n\nSECTION BRIEFS:\n${briefs}`;

  let multimodal: ContentPart[] | null = null;
  if (env.attachPhotos) {
    const parts: ContentPart[] = [{ type: "text", text: user }];
    let attached = 0;
    for (const sec of batch) {
      const part = await photoContent(photoById.get(sec.photoId!)!);
      if (!part) continue;
      parts.push({ type: "text", text: `\n--- PHOTO for Section ${sec.position}: ${sec.heading} ---` });
      parts.push(part);
      attached++;
    }
    if (attached) multimodal = parts;
  }
  if (!multimodal) user += photoDescriptionsBlock(batch, photoById);

  // Две попытки (оригинал: 2341-2497); вторая — с жёсткими требованиями к формату. Лимиты и сеть — до 3 ожиданий.
  let best: { list: JsonRecord[]; missing: number[] } | null = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryInstruction = attempt === 1 ? "" : `\n\nCRITICAL OUTPUT REQUIREMENTS:\n- Return STRICT JSON object only.\n- Top-level key MUST be "sections".\n- No markdown, no prose outside JSON.\n- Every section must include: section_number, h2_heading, html_content.`;
    let text = "";
    let got = false;
    for (let rl = 0; rl < 3 && !got; rl++) {
      await ctx.tick(`Пачка ${batchNumber}: секции ${expected.join(",")} (попытка ${attempt}${rl ? `, повтор ${rl}` : ""})`);
      try {
        const content: string | ContentPart[] = multimodal
          ? (attempt === 1 ? multimodal : [...multimodal, { type: "text", text: retryInstruction }])
          : user + retryInstruction;
        const r = await aiChat(ctx.ai, { slot: SLOTS.textMain, model: env.model, system, user: content, json: true, temperature: 0.8, maxTokens: env.maxTokens, timeoutMs: 300_000 });
        text = r.text;
        got = true;
      } catch (e) {
        if (!(e instanceof AiError)) throw e;
        if (e.cls.kind === "fatal_run") throw e;
        if (e.cls.kind === "permanent") {
          // Провайдер не принимает изображения — тот же запрос без фото (оригинал: 2397-2406)
          if (multimodal && /image input|image_url|does not support image|no endpoints found that support image|invalid image|image/i.test(e.message)) {
            ctx.log(`модель отвергла фото — повтор по описаниям: ${e.message.slice(0, 120)}`);
            multimodal = null;
            user += photoDescriptionsBlock(batch, photoById);
            rl--; // эта попытка не считается
            continue;
          }
          lastErr = `ошибка провайдера: ${e.message}`;
          outcome.reasons.push(lastErr);
          return finalizeMissing(outcome, false);
        }
        // transient: 429 → 30·n с (оригинал: 2364-2391), иначе backoff
        const wait = e.cls.code === "rate_limited" ? 30_000 * (rl + 1) : backoffMs(rl);
        lastErr = `временная ошибка: ${e.message}`;
        ctx.log(`${lastErr} — ждём ${Math.round(wait / 1000)} с`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
    if (!got) {
      outcome.transient = true;
      outcome.reasons.push(lastErr || "провайдер недоступен");
      break;
    }

    try {
      const parsed = extractJsonFromResponse(text || "{}");
      const list = normalizeSections(toSectionList(parsed), expected, text || "");
      if (!list.length) throw new Error("JSON разобран, но секций в нём нет");
      const received = new Set(list.map((s) => Number(s.section_number)));
      const missing = expected.filter((n) => !received.has(n));
      if (!best || list.length > best.list.length) best = { list, missing };
      if (!missing.length) break;
      lastErr = `модель вернула не все секции: нет ${missing.join(",")}`;
      ctx.log(`пачка ${batchNumber}, попытка ${attempt}: ${lastErr}`);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      ctx.log(`пачка ${batchNumber}, попытка ${attempt}: ответ не разобран — ${lastErr}`);
    }
  }
  if (!best) {
    outcome.reasons.push(lastErr || "ответ модели не разобран");
    return finalizeMissing(outcome, outcome.transient);
  }

  // Сохраняем то, что прошло проверки (оригинал: 673-821)
  const labels = [article.keyword, article.focusKeyword];
  for (const got of best.list) {
    const pos = Number(got.section_number);
    const sec = batch.find((s) => s.position === pos);
    if (!sec) continue;
    const photo = photoById.get(sec.photoId!)!;
    const b = briefOf(sec);

    // Заголовок задаёт планер; автор его не переписывает (оригинал: 690-700)
    const plannedH2 = String(b.h2_draft || b.h2 || sec.heading || "").trim();
    const rawH2 = plannedH2 || String(got.h2_heading || got.h2 || got.heading || `Idea ${pos}`);
    const cleanH2 = sanitizeTopic(stripInternalLabels(rawH2, article.keyword)) || rawH2;
    const h2 = uniqueHeading(polishHeading(cleanH2, env.pol), env.usedHeadings, { facts: photo.facts, description: photo.description, keyword: [article.keyword, article.focusKeyword, article.seoKeyword].filter(Boolean).join(" ") });
    if (h2 !== cleanH2) ctx.log(`секция ${pos}: дубль заголовка «${cleanH2}» → «${h2}»`);

    const rawText = [got.html_content, got.html, got.content, got.body, got.text, got.paragraph].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    let html = rawText ?? "";
    if (!html && (typeof got.intro_text === "string" || typeof got.styling_advice === "string")) {
      html = [got.intro_text, got.styling_advice].filter((t): t is string => typeof t === "string" && !!t.trim()).join("\n\n");
    }
    const skip = (why: string) => {
      outcome.reasons.push(`секция ${pos}: ${why}`);
      ctx.log(`секция ${pos}: ${why} — не сохраняется`);
    };
    if (!html.trim()) { skip("пустой текст"); continue; }
    // Сырой JSON или «мысли» модели никогда не становятся текстом (аудит 03, §7.6)
    if (looksLikeRawJson(html) || looksLikeModelThinking(html)) { skip("сырой JSON или черновые размышления вместо текста"); continue; }
    html = cleanArticleHtml(html);
    if (looksLikeFactDump(html)) {
      const cleaned = stripLeadingFactDump(html);
      if (cleaned && !looksLikeFactDump(cleaned) && countWordsFromHtml(cleaned) >= MIN_WORDS) {
        ctx.log(`секция ${pos}: утечка фактов фото в текст — вырезано начало`);
        html = cleaned;
      } else {
        skip("текст выглядит как перечисление фактов фото");
        continue;
      }
    }
    for (const t of labels) if (t && containsInternalLabel(html, t)) html = stripInternalLabels(html, t);
    // Тире → запятая, colour → color, парность <p> (аудит text-v2, п. 2): у каждой секции, без ИИ.
    html = polishHtml(html, env.pol);
    const wordCount = countWordsFromHtml(html);
    if (wordCount < MIN_WORDS) { skip(`слишком коротко (${wordCount} слов, минимум ${MIN_WORDS})`); continue; }

    await prisma.artSection.update({
      where: { id: sec.id },
      data: {
        heading: h2,
        html,
        wordCount,
        status: "written",
        error: null,
        brief: {
          ...b,
          h2,
          h2_draft: h2,
          format_used: got.format_used ?? got.format ?? b.format ?? null,
          register_used: got.register_used ?? got.register ?? b.register ?? null,
          keywords_used: Array.isArray(got.keywords_used) ? got.keywords_used : undefined,
          batch_number: batchNumber,
        } as object,
      },
    });
    outcome.written.push(pos);
  }
  outcome.missing = expected.filter((n) => !outcome.written.includes(n));
  return outcome;
}

function finalizeMissing(o: BatchOutcome, transient: boolean): BatchOutcome {
  o.transient = o.transient || transient;
  return o;
}

export const sections: ArtStageHandler = async (ctx) => {
  const { article, recipe } = ctx;
  const all = await loadPhotoSections(article.id);
  if (!all.length) return { next: "plan", summary: "Нет секций — возврат к плану по фото" };
  const photos = await loadActivePhotos(article.id);
  const photoById = new Map(photos.map((p) => [p.id, p]));

  // Идемпотентность: пишем только ненаписанное (оригинал: 177-200, runStage73:2213-2221)
  const unwritten = all.filter((s) => !isWritten(s));
  if (!unwritten.length) return { summary: `Все ${all.length} секций уже написаны — пропуск`, details: { skipped: true } };
  let pending = unwritten.filter((s) => s.photoId && photoById.has(s.photoId));
  const orphans = unwritten.filter((s) => !(s.photoId && photoById.has(s.photoId)));
  for (const s of orphans) {
    await prisma.artSection.update({ where: { id: s.id }, data: { status: "failed", error: "У секции нет активного фото — в статью не войдёт" } });
  }
  if (!pending.length) return { summary: `Нет секций с фото для написания (без фото: ${orphans.map((s) => s.position).join(",")})` };

  const profile = await loadProfile(ctx);
  const sysPrompt = await resolvePrompt(recipe, SYSTEM_KEY);
  const userPrompt = await resolvePrompt(recipe, USER_KEY);
  const model = stageModel(recipe, USER_KEY) ?? stageModel(recipe, SYSTEM_KEY);
  const wantVision = recipe.photoSearch?.writerMode === "vision";
  const visionOk = modelSupportsVision(model);
  if (wantVision && !visionOk) ctx.log(`модель «${model}» текстовая — фото уходят описаниями`);
  const attachPhotos = wantVision && visionOk;
  const isClaude = /sonnet|claude/i.test(model || "");
  const maxTokens = /sonnet/i.test(model || "") ? 32768 : 16384; // оригинал: 656
  const parallel = isClaude ? 3 : 7; // оригинал: runStage73:2242
  const waveDelayMs = (/sonnet/i.test(model || "") ? 10 : isClaude ? 8 : 1) * 1000; // оригинал: 2290
  const batchSize = Math.max(1, Number(recipe.text?.batchSize) || DEFAULT_BATCH);
  const keyword = focusKeywordOf(ctx) || article.keyword;

  // Автопочинка фактов фото: кандидат → vision-описание; без фактов секция откладывается, пачка не падает (аудит 03, §7.5)
  const noFacts = pending.filter((s) => {
    const p = photoById.get(s.photoId!)!;
    return !factsLine(p.facts) && !p.description?.trim();
  });
  for (const s of noFacts) {
    const p = photoById.get(s.photoId!)!;
    await ctx.tick(`Описание фото секции ${s.position}`);
    let fixed: { facts: Record<string, unknown> | null; description: string | null } | null = null;
    if (p.candidateId) {
      const cand = await prisma.artPhotoCandidate.findUnique({ where: { id: p.candidateId }, select: { aiFacts: true, aiDescription: true } });
      if (cand && (cand.aiFacts || cand.aiDescription)) fixed = { facts: (cand.aiFacts as Record<string, unknown> | null) ?? null, description: cand.aiDescription ?? null };
    }
    if (!fixed) {
      const d = await describePhoto(ctx.ai, profile, keyword, p);
      if (d) fixed = d;
    }
    if (fixed && (factsLine(fixed.facts) || fixed.description)) {
      const upd = await prisma.artPhoto.update({ where: { id: p.id }, data: { facts: (fixed.facts ?? undefined) as object | undefined, description: fixed.description ?? undefined } });
      photoById.set(p.id, upd);
      ctx.log(`секция ${s.position}: описание фото восстановлено`);
    } else {
      await prisma.artSection.update({ where: { id: s.id }, data: { status: "failed", error: "У фото нет фактов и описания, и ИИ не смог их получить" } });
      pending = pending.filter((x) => x.id !== s.id);
      ctx.log(`секция ${s.position}: нет фактов фото — отложена`);
    }
  }
  if (!pending.length) return { fatal: `Ни у одной секции нет фактов фото — писать нечего. Проверьте фото статьи.` };

  // Заголовки ВСЕХ секций статьи, кроме тех, что пишем сейчас (оригинал: 663-671)
  const pendingIds = new Set(pending.map((s) => s.id));
  const usedHeadings = new Set<string>();
  for (const s of all) {
    if (pendingIds.has(s.id)) continue;
    const k = headingKey(s.heading);
    if (k) usedHeadings.add(k);
  }

  const pol: PolishOpts = { usSpelling: usesUsSpelling(recipe.photoSearch?.language, recipe.photoSearch?.country) };
  const overused = await loadSitePhraseMemory(ctx).catch((e) => {
    ctx.log(`память оборотов сайта не загружена: ${e instanceof Error ? e.message : String(e)}`);
    return [] as string[];
  });
  const env: WriterEnv = {
    ctx, profile, sysPrompt, userPrompt, model, attachPhotos, photos, photoById, usedHeadings,
    totalBatches: Math.ceil(all.length / batchSize), maxTokens, pol, overused,
  };

  const reasons: string[] = [];
  let transientSeen = false;
  let totalWritten = 0;
  const run = async (group: ArtSection[], batchNumber: number): Promise<number[]> => {
    try {
      const o = await writeBatch(env, group, batchNumber);
      totalWritten += o.written.length;
      if (o.transient) transientSeen = true;
      reasons.push(...o.reasons);
      return o.missing;
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
      if (e instanceof Error && e.name === "StopRequested") throw e;
      if (ctx.signal.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      reasons.push(`пачка ${batchNumber}: ${msg}`);
      ctx.log(`пачка ${batchNumber} упала: ${msg}`);
      return group.map((s) => s.position);
    }
  };

  // Фаза 1: пачки волнами (оригинал: runStage73:2237-2295)
  const batches: ArtSection[][] = [];
  for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));
  let missing = new Set<number>();
  for (let wi = 0; wi < batches.length; wi += parallel) {
    const wave = batches.slice(wi, wi + parallel);
    const results = await Promise.all(wave.map((b, k) => run(b, wi + k + 1)));
    for (const m of results) for (const n of m) missing.add(n);
    await ctx.tick(`Волна ${Math.floor(wi / parallel) + 1}: написано ${totalWritten}, не хватает ${missing.size}`);
    if (wi + parallel < batches.length) await new Promise((r) => setTimeout(r, waveDelayMs));
  }

  // Фаза 2: недостающие пачками по 3, до двух кругов (оригинал: 2303-2350)
  const byPos = new Map(pending.map((s) => [s.position, s]));
  for (let round = 0; round < 2 && missing.size; round++) {
    const fresh = await loadPhotoSections(article.id);
    const still = [...missing].filter((n) => { const s = fresh.find((x) => x.position === n); return s && !isWritten(s); }).sort((a, b) => a - b);
    missing = new Set();
    for (let i = 0; i < still.length; i += 3) {
      const group = still.slice(i, i + 3).map((n) => byPos.get(n)!).filter(Boolean);
      for (const n of await run(group, 900 + round)) missing.add(n);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Фаза 3: последний шанс — по одной (оригинал: 2370-2378)
  if (missing.size) {
    const fresh = await loadPhotoSections(article.id);
    const still = [...missing].filter((n) => { const s = fresh.find((x) => x.position === n); return s && !isWritten(s); }).sort((a, b) => a - b);
    missing = new Set();
    for (const n of still) for (const m of await run([byPos.get(n)!], 950)) missing.add(m);
  }

  // Итог: пустые секции не удаляем (аудит 03, §7.9; 08-plan §3 п.8)
  const finalRows = await loadPhotoSections(article.id);
  const empty = finalRows.filter((s) => s.photoId && photoById.has(s.photoId) && !isWritten(s));
  const writtenNow = finalRows.filter(isWritten).length;
  if (empty.length) {
    const positions = empty.map((s) => s.position).join(", ");
    if (transientSeen) {
      // Окно и паузы временных сбоев — у раннера (errors.ts): ~1 ч, затем ошибка; написанное сохранено.
      return { retryInMs: backoffMs(ctx.retries.transient), retryKind: "transient", summary: `Написано ${writtenNow}/${finalRows.length}; провайдер был недоступен — повтор для секций ${positions}`, details: { reasons } };
    }
    for (const s of empty) {
      await prisma.artSection.update({ where: { id: s.id }, data: { status: "failed", error: reasons.filter((r) => r.startsWith(`секция ${s.position}:`)).join("; ") || "Модель не вернула текст секции" } });
    }
    // Модель не вернула текст части секций (формат, обрыв ответа) — отложенный повтор этапа: пишутся только пустые
    // секции, написанные сохранены. После 3 таких повторов — ошибка с перечнем позиций.
    return {
      retryInMs: 2 * 60_000,
      retryKind: "malformed",
      summary: `Написано ${writtenNow}/${finalRows.length}; модель не вернула текст секций ${positions}`,
      giveUp: `Секции без текста после всех попыток: ${positions}. Фото и секции сохранены — проверьте причины в журнале, при необходимости исключите фото и повторите этап «Тексты секций».`,
      details: { reasons: reasons.slice(0, 50), written: writtenNow, empty: empty.map((s) => s.position) },
    };
  }

  // Проверка после записи: стоп-лист, затёртые на сайте и повторённые внутри статьи обороты → одна перепись
  // только плохих секций той же моделью (аудит text-v2, п. 10–11).
  const revision = await reviseFlagged(env, finalRows.filter(isWritten));
  const rows = revision.revised ? await loadPhotoSections(article.id) : finalRows;
  const words = rows.reduce((acc, s) => acc + (isWritten(s) ? s.wordCount : 0), 0);
  return {
    summary: `Написано ${totalWritten} секций (всего ${writtenNow}/${finalRows.length}), ${words} слов${attachPhotos ? ", с фото" : ", по описаниям"}${revision.revised ? `; переписано из-за штампов: ${revision.revised}` : ""}`,
    details: { written: totalWritten, total: finalRows.length, words, model, attachPhotos, batchSize, parallel, orphans: orphans.map((s) => s.position), reasons: reasons.slice(0, 50), overusedOnSite: overused.length, revision },
  };
};

// ───────────────────────── проверка после записи (аудит text-v2, п. 10–11) ─────────────────────────

/** Сколько последних статей сайта той же ниши смотрим и в скольких должен встретиться оборот, чтобы считаться шаблоном. */
const MEMORY_ARTICLES = 30;
const MEMORY_MIN_ARTICLES = 3;
/** Предел переписываемых секций на статью (защита от лишнего расхода при плохом промте). */
const MAX_REVISIONS = 8;

/**
 * Затёртые обороты сайта: 4-граммы из текстов последних ~30 статей сайта той же ниши (секции, вступление, заключение),
 * встретившиеся в 3+ статьях. Только запрос к базе и подсчёт, без ИИ.
 */
async function loadSitePhraseMemory(ctx: ArtStageCtx): Promise<string[]> {
  const { article, recipe } = ctx;
  const recent = await prisma.article.findMany({
    where: { siteId: article.siteId, id: { not: article.id }, recipeRef: { nicheCode: recipe.nicheCode }, sections: { some: { status: "written" } } },
    orderBy: { updatedAt: "desc" },
    take: MEMORY_ARTICLES,
    select: { id: true },
  });
  if (recent.length < MEMORY_MIN_ARTICLES) return [];
  const rows = await prisma.artSection.findMany({
    where: { articleId: { in: recent.map((a) => a.id) }, status: "written" },
    select: { articleId: true, html: true },
  });
  const byArticle = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.html) continue;
    const list = byArticle.get(r.articleId) ?? [];
    list.push(r.html);
    byArticle.set(r.articleId, list);
  }
  return overusedPhrases([...byArticle.values()], { minArticles: MEMORY_MIN_ARTICLES, limit: 40, keyword: [article.keyword, article.focusKeyword].filter(Boolean).join(" ") });
}

type RevisionReport = { checked: number; flagged: number; revised: number; kept: number; costUsd: number; items: Array<{ position: number; issues: string[]; ok: boolean; why?: string }> };

/** Найти проблемы секции: стоп-лист, затёртые на сайте обороты, обороты, повторённые в 3+ секциях статьи. */
export function sectionIssues(html: string, overused: string[], inArticle: string[]): string[] {
  const out = [...findBannedPhrases(html), ...findOverused(html, overused), ...findOverused(html, inArticle)];
  return [...new Set(out.map((x) => x.trim()).filter(Boolean))];
}

/**
 * Одна перепись каждой секции с проблемами (не больше MAX_REVISIONS на статью, только раз на секцию — brief.revised).
 * Новый текст принимается, если он не короче минимума, объём в пределах 60–150 % и проблем стало меньше.
 */
async function reviseFlagged(env: WriterEnv, written: ArtSection[]): Promise<RevisionReport> {
  const { ctx } = env;
  const report: RevisionReport = { checked: written.length, flagged: 0, revised: 0, kept: 0, costUsd: 0, items: [] };
  // Оборот, повторённый в 3+ секциях статьи, — проблема всех секций, кроме первой, где он встретился.
  const ordered = [...written].sort((a, b) => a.position - b.position);
  const repeated = repeatedWithinArticle(ordered.map((s) => s.html || ""), 3, [ctx.article.keyword, ctx.article.focusKeyword].filter(Boolean).join(" "));
  const firstPos = new Map<string, number>();
  for (const g of repeated) {
    const first = ordered.find((s) => findOverused(s.html || "", [g]).length);
    if (first) firstPos.set(g, first.position);
  }
  const inArticleFor = (sec: ArtSection) => repeated.filter((g) => firstPos.get(g) !== sec.position);
  const flagged = ordered
    .filter((s) => s.position >= 1 && s.position < MAX_PHOTO_POS && !briefOf(s).revised)
    .map((s) => ({ sec: s, issues: sectionIssues(s.html || "", env.overused, inArticleFor(s)) }))
    .filter((x) => x.issues.length)
    .sort((a, b) => b.issues.length - a.issues.length);
  report.flagged = flagged.length;
  if (!flagged.length) return report;

  const queue = flagged.slice(0, MAX_REVISIONS);
  for (let i = 0; i < queue.length; i += 4) {
    await Promise.all(queue.slice(i, i + 4).map(async ({ sec, issues }) => {
      const item: RevisionReport["items"][number] = { position: sec.position, issues, ok: false };
      report.items.push(item);
      try {
        const r = await rewriteSection(env, sec, issues, inArticleFor(sec));
        report.costUsd += r.costUsd;
        if (!r.html) { item.why = r.why; report.kept++; return; }
        await prisma.artSection.update({
          where: { id: sec.id },
          data: { html: r.html, wordCount: countWordsFromHtml(r.html), brief: { ...briefOf(sec), revised: { issues, at: new Date().toISOString() } } as object },
        });
        item.ok = true;
        report.revised++;
      } catch (e) {
        if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
        if (e instanceof Error && e.name === "StopRequested") throw e;
        item.why = e instanceof Error ? e.message.slice(0, 200) : String(e);
        report.kept++;
      }
    }));
  }
  report.costUsd = Math.round(report.costUsd * 1e6) / 1e6;
  ctx.log(`проверка штампов: найдено в ${report.flagged} секциях, переписано ${report.revised}, оставлено ${report.kept}, $${report.costUsd}`);
  return report;
}

async function rewriteSection(env: WriterEnv, sec: ArtSection, issues: string[], inArticle: string[]): Promise<{ html: string | null; why?: string; costUsd: number }> {
  const { ctx } = env;
  const photo = sec.photoId ? env.photoById.get(sec.photoId) : undefined;
  const facts = factsLine(photo?.facts) || photo?.description || "";
  const before = sec.html || "";
  const words = countWordsFromHtml(before);
  await ctx.tick(`Перепись секции ${sec.position}: штампы`);
  const system =
    `You are a copy editor for a US women's lifestyle blog. Rewrite ONE article section so it keeps every useful fact ` +
    `and its structure (<p>, <ul>, <li> only) but drops the listed phrases. Replace a first-person claim of wearing, testing, ` +
    `booking or compliments with a plain statement or general knowledge ("this finish typically lasts two to three weeks"). ` +
    `Replace a cliché with a concrete, specific sentence. Keep the length within 10% (${words} words now). ` +
    `American English, second person or plain statements, no em dashes or en dashes, no emphasis tags, no new facts ` +
    `beyond the photo facts. ${BANNED_PROMPT_LINE}\nReturn ONLY JSON: {"html": "<p>...</p>"}`;
  const user =
    `SECTION HEADING: ${sec.heading}\nPHOTO FACTS (the only visual facts allowed): ${facts || "none"}\n` +
    `PHRASES TO REMOVE (and never use close variants): ${issues.map((x) => `"${x}"`).join(", ")}\n\nSECTION HTML:\n${before}`;
  const r = await aiChat(ctx.ai, { slot: SLOTS.textMain, model: env.model, system, user, json: true, temperature: 0.6, maxTokens: 2000, timeoutMs: 120_000 });
  const cost = r.costUsd ?? 0;
  let html = "";
  try {
    const parsed = extractJsonFromResponse(r.text || "{}") as JsonRecord;
    html = String(parsed?.html ?? parsed?.html_content ?? "");
  } catch {
    return { html: null, why: "ответ не JSON", costUsd: cost };
  }
  if (!html.trim() || looksLikeRawJson(html) || looksLikeModelThinking(html)) return { html: null, why: "пустой или сырой ответ", costUsd: cost };
  html = polishHtml(cleanArticleHtml(html), env.pol);
  const after = countWordsFromHtml(html);
  if (after < MIN_WORDS || after < words * 0.6 || after > words * 1.5) return { html: null, why: `объём ${after} слов против ${words}`, costUsd: cost };
  if (looksLikeFactDump(html)) return { html: null, why: "перечисление фактов вместо текста", costUsd: cost };
  const left = sectionIssues(html, env.overused, inArticle);
  if (left.length >= issues.length) return { html: null, why: `проблем не меньше: ${left.join(", ")}`, costUsd: cost };
  return { html, costUsd: cost };
}
