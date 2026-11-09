/**
 * Этап `research`: разметка интента ключа и «бриф знаний» для автора — факты с уверенностью, что нужно/нельзя,
 * ошибки, безопасность, материалы, сроки, вопросы читателей; YMYL-флаг (здоровье, деньги, безопасность).
 * При `params.research.serp` — реальные People Also Ask и заголовки топа из SerpApi (слот serp_organic) идут в промт.
 * Один вызов text_fast (json). Идемпотентно: бриф уже есть — пропуск.
 */
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import { aiChat } from "@/lib/blog/ai";
import { MalformedAiOutput } from "@/lib/articles/errors";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { fillPrompt, resolvePrompt, stageModel } from "@/lib/blog/prompts";
import { fetchSerpBrief, serpBlockText } from "@/lib/blog/serp";
import { INTENTS, SLOTS, type BlogBrief, type Intent } from "@/lib/blog/types";
import type { StageHandler } from "./index";

const STAGE_KEY = "research";
const TRIES = 3;

type R = Record<string, unknown>;
const strList = (v: unknown, n = 15, max = 240) => (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? String((x as R).text ?? "") : String(x ?? ""))).map((s) => s.trim().slice(0, max)).filter(Boolean).slice(0, n);

export const research: StageHandler = async (ctx) => {
  const { post, recipe } = ctx;
  if (ctx.brief && ctx.brief.summary && (ctx.brief.facts?.length ?? 0) > 0) {
    return { summary: "Бриф уже есть — пропуск", details: { skipped: true } };
  }
  const keyword = post.keyword;
  const focus = post.focusKeyword || keyword;
  const params = recipe.params;

  let serp: Awaited<ReturnType<typeof fetchSerpBrief>> | null = null;
  if (params.research.serp) {
    await ctx.tick("Выдача Google");
    serp = await fetchSerpBrief(ctx.ai, keyword, params.country, params.language);
    if (serp.error) ctx.log(`выдача не получена: ${serp.error}`);
  }

  const prompt = resolvePrompt(recipe, STAGE_KEY);
  const filled = fillPrompt(prompt, { keyword, focus_keyword: focus, language: params.language, country: params.country, serp_block: serpBlockText(serp) }, { name: STAGE_KEY });
  const model = stageModel(recipe, STAGE_KEY);

  let lastWhy = "";
  let correction = "";
  let usedModel: string | null = null;
  for (let i = 0; i < TRIES; i++) {
    await ctx.tick(`Исследование: запрос ${i + 1}/${TRIES}`);
    let text = "";
    try {
      const r = await aiChat(ctx.ai, { slot: SLOTS.textFast, model, system: filled.system, user: filled.user + (post.topic?.trim() ? `\n\nEDITOR'S ARTICLE TITLE: "${post.topic.trim()}" — research exactly this angle (if it promises a number of items, collect enough distinct items).` : "") + correction, json: true, temperature: i === 0 ? 0.4 : 0.2, maxTokens: 6000, timeoutMs: 180_000 });
      text = r.text;
      usedModel = r.model;
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "transient" && i + 1 < TRIES) {
        ctx.log(`временная ошибка: ${e.message}`);
        await new Promise((res) => setTimeout(res, backoffMs(i)));
        continue;
      }
      throw e;
    }
    const out = parseModelJsonSafe(text) as R | null;
    if (!out || typeof out !== "object") { lastWhy = "ответ не JSON"; correction = "\n\nIMPORTANT: your previous answer was not valid JSON. Return ONLY one JSON object."; continue; }
    const facts = (Array.isArray(out.facts) ? out.facts : []).map((f) => {
      const o = (f && typeof f === "object" ? f : { text: f }) as R;
      const c = String(o.confidence ?? "medium").toLowerCase();
      return { text: String(o.text ?? "").trim().slice(0, 300), confidence: (c === "high" || c === "low" ? c : "medium") as "high" | "medium" | "low" };
    }).filter((f) => f.text).slice(0, 25);
    if (facts.length < 3) { lastWhy = `слишком мало фактов (${facts.length})`; correction = "\n\nIMPORTANT: return at least 6 concrete facts in \"facts\" (each with text and confidence)."; continue; }
    const intentRaw = String(out.intent ?? "other").toLowerCase().replace(/[\s-]+/g, "_");
    const intent = (INTENTS.includes(intentRaw as Intent) ? intentRaw : "other") as Intent;
    const brief: BlogBrief = {
      intent,
      topicDomain: String(out.topic_domain ?? out.topicDomain ?? "general").slice(0, 80),
      audience: String(out.audience ?? "").slice(0, 300),
      ymyl: out.ymyl === true || /health|medical|skin|hair loss|vitamin|diet|pregnan|baby|money|legal|safety/i.test(String(out.topic_domain ?? "")) && out.ymyl !== false,
      summary: String(out.summary ?? "").slice(0, 1500),
      facts,
      dos: strList(out.dos),
      donts: strList(out.donts),
      mistakes: strList(out.mistakes),
      safety: strList(out.safety),
      materials: strList(out.materials),
      timeline: String(out.timeline ?? "").slice(0, 300),
      questions: strList(out.questions, 14, 200),
      serp: serp ? { questions: serp.questions, titles: serp.titles, headings: [] } : null,
      model: usedModel,
    };
    await ctx.save({ brief });
    return {
      summary: `Интент ${brief.intent}, ${brief.topicDomain}${brief.ymyl ? ", YMYL" : ""}: фактов ${brief.facts.length}, вопросов ${brief.questions.length}${serp?.questions.length ? `, PAA ${serp.questions.length}` : ""}`,
      details: { intent: brief.intent, topicDomain: brief.topicDomain, ymyl: brief.ymyl, facts: brief.facts.length, questions: brief.questions.length, serp: serp ? { questions: serp.questions.length, titles: serp.titles.length, error: serp.error ?? null } : null, model: usedModel },
    };
  }
  throw new MalformedAiOutput(`Исследование не получено: ${lastWhy || "модель не вернула бриф"} (после ${TRIES} попыток)`);
};
