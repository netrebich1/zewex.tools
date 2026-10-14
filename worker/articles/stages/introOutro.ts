/**
 * Этап `intro_outro` (шаг 72 оригинала, stage7-write-intro/index.ts; шаг 74 stage7-write-outro не переносится —
 * аудит 03, §7.7). Один промт `stage_7_intro_outro` отдаёт вступление и заключение в одном JSON; оба блока
 * проверяются отдельно: вступление — ровно 2 <p> и 90–120 слов, заключение — 30–200 слов. До 5 попыток с
 * замечанием модели; лучший валидный блок каждой части сохраняется между попытками, «приемлемое» вступление
 * (60–160 слов, 2 абзаца) принимается, если строгое не достигнуто (оригинал: 452, 487-490).
 * Полный набор переменных (outro_plan, care_plan, content_angle, subcategories, trend_details…) — 08-plan §3 п.2.
 */
import { prisma } from "@/lib/db";
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import { aiChat } from "@/lib/articles/ai";
import { SLOTS } from "@/lib/articles/types";
import { resolvePrompt, resolvePromptOptional, fillPrompt, stageModel } from "@/lib/articles/prompts";
import { countTokenPromptBlock } from "@/lib/articles/text/countToken";
import { cleanLabelsAndEmphasis } from "@/lib/articles/text/textGuards";
import { countWords, looksLikeModelThinking, normalizeIntroParagraphs, parseIntroOutroResponse } from "@/lib/articles/text/introOutroParse";
import { cleanArticleHtml, OUTRO_HEADING } from "@/lib/articles/text/html";
import { buildPromptVars, loadProfile } from "@/lib/articles/text/vars";
import type { ArtStageHandler } from "./index";
import { INTRO_POS, isWritten, loadActivePhotos, loadPhotoSections, OUTRO_POS } from "./plan";

const STAGE_KEY = "stage_7_intro_outro";
const MAX_ATTEMPTS = 5; // оригинал: 379
/** Жёсткие рамки объёма (оригинал: 455-476) */
const INTRO_MIN = 90, INTRO_MAX = 120, INTRO_SOFT_MIN = 60, INTRO_SOFT_MAX = 160;
const OUTRO_MIN = 30, OUTRO_MAX = 200;

export const introOutro: ArtStageHandler = async (ctx) => {
  const { article, recipe } = ctx;

  if (article.introHtml?.trim() && article.outroHtml?.trim()) {
    return { summary: "Вступление и заключение уже есть — пропуск", details: { skipped: true } };
  }

  const photos = await loadActivePhotos(article.id);
  const sections = await loadPhotoSections(article.id);
  if (!sections.length) return { next: "plan", summary: "Нет секций — возврат к плану по фото" };
  const written = sections.filter(isWritten);
  const profile = await loadProfile(ctx);
  const vars = await buildPromptVars(ctx, { photos, sections, written, profile });

  // Промты: system писателя как база, system/user набора «вступление и заключение» поверх (оригинал: 337-352).
  const combined = await resolvePrompt(recipe, STAGE_KEY);
  const filled = fillPrompt(combined, vars);
  let system = filled.system.trim();
  if (!system) {
    const writerSys = await resolvePromptOptional(recipe, "stage_7_writer_system");
    if (writerSys) {
      const f = fillPrompt(writerSys, vars);
      system = [f.system, f.user].filter((x) => x.trim()).join("\n\n");
    }
  }
  // Количество идей пишется меткой; единое правило объёма поверх всех промтов (оригинал: 355-357).
  system += `\n\n${countTokenPromptBlock()}`;
  system += `\n\nINTRO LENGTH — MANDATORY: Write exactly 2 concise paragraphs totaling ${INTRO_MIN}-${INTRO_MAX} words. Preserve the exact topic, {{COUNT}}, search intent, and a brief statement of what the reader will get. Do not list every section, repeat examples, pad the opening, or add a third paragraph. This rule overrides any longer intro length requested elsewhere in the prompt.`;
  const userPrompt = filled.user;
  const model = stageModel(recipe, STAGE_KEY);

  let bestIntro: string | null = null;
  let softIntro: string | null = null;
  let bestOutro: string | null = null;
  let correction = "";
  let lastError: Error | null = null;
  let usedModel: string | null = null;
  let parseMode = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await ctx.tick(`Вступление и заключение: попытка ${attempt}/${MAX_ATTEMPTS}`);
    let text = "";
    try {
      const r = await aiChat(ctx.ai, {
        slot: SLOTS.textMain,
        model,
        system,
        user: correction ? `${userPrompt}\n\n${correction}` : userPrompt,
        json: true,
        temperature: 0.8,
        maxTokens: 6000,
        timeoutMs: 180_000,
      });
      text = r.text;
      usedModel = r.model;
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "transient" && attempt < MAX_ATTEMPTS) {
        lastError = e;
        ctx.log(`попытка ${attempt}: временная ошибка провайдера — ${e.message}`);
        await new Promise((res) => setTimeout(res, backoffMs(attempt - 1)));
        continue;
      }
      throw e;
    }

    try {
      if (!text.trim() || text.trim() === "{}") throw new Error("Модель вернула пустой ответ");
      const candidate = parseIntroOutroResponse(text);
      parseMode = candidate.parse_mode;
      const intro = normalizeIntroParagraphs(candidate.intro_html);
      const introW = countWords(intro);
      const introP = (intro.match(/<p(?:\s|>)/gi) || []).length;
      const outro = candidate.outro_html?.trim() || "";
      const outroW = countWords(outro);

      const introOk = introP === 2 && introW >= INTRO_MIN && introW <= INTRO_MAX;
      const introSoft = introP === 2 && introW >= INTRO_SOFT_MIN && introW <= INTRO_SOFT_MAX;
      const outroOk = !!outro && outroW >= OUTRO_MIN && outroW <= OUTRO_MAX;
      if (introOk && !bestIntro) bestIntro = intro;
      if (introSoft && !softIntro) softIntro = intro;
      if (outroOk && !bestOutro) bestOutro = outro;
      if (bestIntro && bestOutro) break;

      const notes: string[] = [];
      if (!introOk) {
        notes.push(
          `INTRO CORRECTION — MANDATORY. Your previous introduction had ${introW} words and ${introP} paragraphs; exactly ${INTRO_MIN}-${INTRO_MAX} words and 2 paragraphs are required. ` +
            (introW < INTRO_MIN
              ? `Rewrite it as exactly 2 concise paragraphs totaling ${INTRO_MIN}-${INTRO_MAX} words. Keep the exact topic, {{COUNT}}, search intent, and what the reader will get, without padding or invented facts.`
              : `Rewrite it as exactly 2 concise paragraphs totaling ${INTRO_MIN}-${INTRO_MAX} words. Cut repetition and long lists, not the exact topic, {{COUNT}}, search intent, or reader benefit.`),
        );
      }
      if (!outroOk) {
        notes.push(
          outro
            ? `LENGTH CORRECTION — MANDATORY. Your previous conclusion was ${outroW} words, which is outside the allowed range of ${OUTRO_MIN}-${OUTRO_MAX} words. Rewrite the conclusion so it is 80-140 words.`
            : "Your previous answer had no conclusion. Return BOTH intro_html and outro_html; the conclusion is mandatory (80-140 words).",
        );
      }
      notes.push(`Keep the other part valid (introduction ${INTRO_MIN}-${INTRO_MAX} words in exactly 2 paragraphs, conclusion ${OUTRO_MIN}-${OUTRO_MAX} words). Return the same JSON structure, no bold, no italic, no asterisks.`);
      correction = notes.join(" ");
      lastError = new Error(`Вступление ${introW} слов / ${introP} абзацев, заключение ${outroW} слов — вне рамок`);
      ctx.log(`попытка ${attempt} отбракована: ${lastError.message}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      correction = "";
      ctx.log(`попытка ${attempt} отбракована: ${lastError.message}`);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((res) => setTimeout(res, 1200 * attempt)); // оригинал: 483
  }

  const introRaw = bestIntro ?? softIntro;
  if (!introRaw || !bestOutro) {
    throw lastError ?? new Error("Не удалось получить вступление и заключение");
  }
  if (!bestIntro) ctx.log("строгий объём вступления не достигнут — принят ближайший корректный вариант");

  // Пост-обработка: без выделений, без служебных пометок, абзацами HTML, без «мыслей» модели (оригинал: 496-519).
  const labels = [article.keyword, article.focusKeyword];
  const introText = cleanLabelsAndEmphasis(cleanArticleHtml(introRaw), labels);
  const outroText = cleanLabelsAndEmphasis(cleanArticleHtml(bestOutro), labels);
  if (!outroText.trim()) throw new Error("Заключение обязательно: модель не вернула его — этап не сохранён");
  if (looksLikeModelThinking(introText) || looksLikeModelThinking(outroText)) {
    throw new Error("В тексте вступления/заключения черновые размышления модели — этап не сохранён");
  }
  if (!/<p[\s>]/i.test(introText) || !/<p[\s>]/i.test(outroText)) {
    throw new Error("Вступление и заключение должны быть абзацами HTML");
  }
  const introWords = countWords(introText);
  const outroWords = countWords(outroText);

  await prisma.$transaction([
    prisma.article.update({ where: { id: article.id }, data: { introHtml: introText, outroHtml: outroText } }),
    prisma.artSection.upsert({
      where: { articleId_position: { articleId: article.id, position: INTRO_POS } },
      create: { articleId: article.id, position: INTRO_POS, heading: "", html: introText, wordCount: introWords, status: "written" },
      update: { html: introText, wordCount: introWords, status: "written", error: null },
    }),
    prisma.artSection.upsert({
      where: { articleId_position: { articleId: article.id, position: OUTRO_POS } },
      create: { articleId: article.id, position: OUTRO_POS, heading: OUTRO_HEADING, html: outroText, wordCount: outroWords, status: "written" },
      update: { html: outroText, wordCount: outroWords, status: "written", error: null },
    }),
  ]);

  return {
    summary: `Вступление ${introWords} слов, заключение ${outroWords} слов`,
    details: { introWords, outroWords, parseMode, strictIntro: !!bestIntro, model: usedModel },
  };
};
