/**
 * Этап `wrap`: по готовому телу статьи — вступление (1–2 абзаца, 60–120 слов), блок ключевых выводов (если план велел),
 * заключение (50–140 слов), FAQ (вопросы из плана/PAA, ответы 25–70 слов) и дисклеймер (YMYL). Один вызов text_main (json),
 * до 3 попыток с замечаниями по объёму. Промт — `wrap` рецепта.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import { aiChat } from "@/lib/blog/ai";
import { MalformedAiOutput } from "@/lib/articles/errors";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { usesUsSpelling } from "@/lib/articles/text/polish";
import { fillPrompt, resolvePrompt, stageModel } from "@/lib/blog/prompts";
import { briefShort, cleanSectionHtml, countWords, firstWords, looksLikeJunk } from "@/lib/blog/text";
import { SLOTS } from "@/lib/blog/types";
import { ACCURACY_RULE, YMYL_RULE, voiceText } from "./write";
import type { StageHandler } from "./index";

const STAGE_KEY = "wrap";
const TRIES = 3;
const INTRO = [50, 140] as const;
const CONCLUSION = [40, 170] as const;
const ANSWER = [15, 90] as const;

type R = Record<string, unknown>;

export const wrap: StageHandler = async (ctx) => {
  const { post, recipe, brief, outline } = ctx;
  if (!outline) return { next: "outline", summary: "Нет плана — возврат к плану" };
  if (post.introHtml?.trim() && post.conclusionHtml?.trim() && (!outline.faq.enabled || (Array.isArray(post.faq) && (post.faq as unknown[]).length >= 2))) {
    return { summary: "Вступление, заключение и FAQ уже есть — пропуск", details: { skipped: true } };
  }
  const sections = await prisma.blogSection.findMany({ where: { postId: post.id, status: "written" }, orderBy: { position: "asc" } });
  if (!sections.length) return { next: "write", summary: "Нет написанных секций — возврат к тексту" };
  const params = recipe.params;
  const pol = { usSpelling: usesUsSpelling(params.language, params.country) };

  const faqWanted = outline.faq.enabled;
  const faqCount = Math.max(params.faqCount.min, Math.min(params.faqCount.max, outline.faq.count || params.faqCount.min));
  const summary = sections.map((s) => `${s.position}. ${s.heading} [${s.kind}]: ${firstWords(s.html, 45)}…`).join("\n");
  const prompt = resolvePrompt(recipe, STAGE_KEY);
  const filled = fillPrompt(prompt, {
    keyword: post.keyword, h1: outline.h1 || post.h1 || post.keyword, brief_short: briefShort(brief), article_summary: summary,
    faq_questions: faqWanted ? outline.faq.questions.slice(0, faqCount + 2).map((q) => `- ${q}`).join("\n") : "(no FAQ)",
    faq_count: faqWanted ? faqCount : 0,
    takeaways_wanted: outline.takeaways ? "yes" : "no",
    disclaimer_wanted: outline.disclaimer ? "yes" : "no",
    voice: voiceText(params.voice, params.persona), persona: params.persona,
  }, { name: STAGE_KEY });
  const system = `${filled.system}\n\n${ACCURACY_RULE}${brief?.ymyl ? `\n${YMYL_RULE}` : ""}`;
  const model = stageModel(recipe, STAGE_KEY);

  let correction = "";
  let lastWhy = "";
  let usedModel: string | null = null;
  for (let i = 0; i < TRIES; i++) {
    await ctx.tick(`Вступление и заключение: попытка ${i + 1}/${TRIES}`);
    let text = "";
    try {
      const r = await aiChat(ctx.ai, { slot: SLOTS.textMain, model, system, user: filled.user + correction, json: true, temperature: 0.7, maxTokens: 6000, timeoutMs: 180_000 });
      text = r.text;
      usedModel = r.model;
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "transient" && i + 1 < TRIES) { await new Promise((res) => setTimeout(res, backoffMs(i))); continue; }
      throw e;
    }
    const out = parseModelJsonSafe(text) as R | null;
    if (!out || typeof out !== "object") { lastWhy = "ответ не JSON"; correction = "\n\nIMPORTANT: return ONLY one valid JSON object."; continue; }
    const intro = cleanSectionHtml(String(out.intro_html ?? out.intro ?? ""), ["p"], pol);
    const conclusion = cleanSectionHtml(String(out.conclusion_html ?? out.conclusion ?? out.outro_html ?? ""), ["p", "ul", "li"], pol);
    const takeaways = outline.takeaways ? cleanSectionHtml(String(out.takeaways_html ?? out.takeaways ?? ""), ["p", "ul", "li", "strong"], pol) : "";
    const disclaimer = outline.disclaimer ? cleanSectionHtml(String(out.disclaimer_html ?? out.disclaimer ?? ""), ["p"], pol) : "";
    const faqRaw = Array.isArray(out.faq) ? out.faq : [];
    const faq = faqRaw.map((x) => {
      const o = (x && typeof x === "object" ? x : {}) as R;
      return { question: String(o.question ?? o.q ?? "").trim().replace(/<[^>]+>/g, "").slice(0, 200), answer: cleanSectionHtml(String(o.answer ?? o.a ?? ""), ["p"], pol) };
    }).filter((f) => f.question && f.answer && !looksLikeJunk(f.answer));

    const problems: string[] = [];
    const iw = countWords(intro);
    const cw = countWords(conclusion);
    if (!intro || looksLikeJunk(intro)) problems.push("intro_html is missing");
    else if (iw < INTRO[0] || iw > INTRO[1]) problems.push(`intro_html has ${iw} words; it must be ${INTRO[0]}-${INTRO[1]} words in 1-2 paragraphs`);
    if (!conclusion || looksLikeJunk(conclusion)) problems.push("conclusion_html is missing");
    else if (cw < CONCLUSION[0] || cw > CONCLUSION[1]) problems.push(`conclusion_html has ${cw} words; it must be ${CONCLUSION[0]}-${CONCLUSION[1]} words`);
    if (outline.takeaways && (!takeaways || !/<li\b/i.test(takeaways))) problems.push("takeaways_html must be a <ul> with 3-5 <li> items");
    if (faqWanted && faq.length < Math.min(faqCount, 3)) problems.push(`faq must have ${faqCount} question/answer pairs`);
    const badAnswers = faq.filter((f) => countWords(f.answer) < ANSWER[0] || countWords(f.answer) > ANSWER[1]).length;
    if (faqWanted && badAnswers > Math.ceil(faq.length / 2)) problems.push(`FAQ answers must be ${ANSWER[0]}-${ANSWER[1]} words each`);
    if (outline.disclaimer && !disclaimer) problems.push("disclaimer_html is missing (one short paragraph)");
    if (problems.length && i + 1 < TRIES) {
      lastWhy = problems.join("; ");
      correction = `\n\nCORRECTION — your previous answer was rejected: ${problems.join("; ")}. Return the same JSON structure, fixed.`;
      ctx.log(`попытка ${i + 1} отклонена: ${lastWhy}`);
      continue;
    }
    if (!intro || !conclusion) throw new MalformedAiOutput(`Вступление или заключение не получены: ${lastWhy || problems.join("; ")}`);

    const faqFinal = faqWanted ? faq.slice(0, faqCount) : [];
    await prisma.blogPost.update({
      where: { id: post.id },
      data: {
        introHtml: intro, conclusionHtml: conclusion, takeawaysHtml: takeaways || null, disclaimerHtml: disclaimer || null,
        faq: faqFinal.length ? (faqFinal as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
    return {
      summary: `Вступление ${iw} слов, заключение ${cw} слов${takeaways ? ", выводы" : ""}${faqFinal.length ? `, FAQ ${faqFinal.length}` : ""}${disclaimer ? ", дисклеймер" : ""}${problems.length ? ` (принято с замечаниями: ${problems.join("; ")})` : ""}`,
      details: { introWords: iw, conclusionWords: cw, takeaways: !!takeaways, faq: faqFinal.length, disclaimer: !!disclaimer, model: usedModel, problems },
    };
  }
  throw new MalformedAiOutput(`Обвязка статьи не получена за ${TRIES} попыток: ${lastWhy}`);
};
