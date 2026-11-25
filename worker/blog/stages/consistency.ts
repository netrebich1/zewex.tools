/**
 * Проверка согласованности готовой статьи перед сборкой (один вызов text_fast, ~$0.002): противоречия между частями
 * (температуры, размеры, время, количества, советы «делай/не делай») и небезопасные значения. Ответ переводится в проблемы
 * в формате проверки качества («Секция N: …», «FAQ: …», «Вступление: …») — дальше их чинит общая самопочинка assemble.
 * Выполняется один раз на пост (cursor.consistencyChecked); сбой проверки статью не останавливает.
 */
import type { BlogPost, BlogSection } from "@prisma/client";
import { AiError } from "@/lib/pins/ai/errors";
import { aiChatRetry } from "@/lib/blog/ai";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { stageModel } from "@/lib/blog/prompts";
import { SLOTS } from "@/lib/blog/types";
import type { StageCtx } from "./index";

const SYSTEM = `You are a fact-consistency editor for a how-to blog article. You get the article split into labelled parts.
Find ONLY real problems: (1) two parts that contradict each other (different temperatures, sizes, times, amounts, or one part says do X and another says never do X); (2) an unsafe or clearly wrong value (e.g. a heat setting far above what the body recommends). Ignore style, repetition and minor wording.
For each problem name the part that is WRONG (the one that disagrees with the step-by-step body) and say exactly what to change.
Return ONLY JSON: {"issues":[{"part":"section 3" | "faq" | "intro" | "conclusion" | "takeaways","problem":"...","fix":"..."}]} — at most 5 issues, an empty list if the article is consistent.`;

const plain = (h: string | null | undefined) => String(h ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export async function consistencyProblems(ctx: StageCtx, post: BlogPost, sections: BlogSection[]): Promise<{ problems: string[]; costUsd: number }> {
  const parts: string[] = [`[intro] ${plain(post.introHtml)}`];
  if (post.takeawaysHtml) parts.push(`[takeaways] ${plain(post.takeawaysHtml)}`);
  for (const s of sections.filter((x) => x.status === "written").sort((a, b) => a.position - b.position)) parts.push(`[section ${s.position}: ${s.heading}] ${plain(s.html)}`);
  const faq = Array.isArray(post.faq) ? (post.faq as Array<{ question?: string; answer?: string }>) : [];
  if (faq.length) parts.push(`[faq] ${faq.map((f) => `Q: ${f.question ?? ""} A: ${plain(f.answer)}`).join(" | ")}`);
  parts.push(`[conclusion] ${plain(post.conclusionHtml)}`);
  try {
    const r = await aiChatRetry(ctx.ai, { slot: SLOTS.textFast, model: stageModel(ctx.recipe, "meta"), system: SYSTEM, user: `Article: "${post.h1 || post.keyword}"\n\n${parts.join("\n\n").slice(0, 30000)}`, json: true, temperature: 0.1, maxTokens: 900, timeoutMs: 120_000 });
    const j = (parseModelJsonSafe(r.text) ?? {}) as { issues?: Array<{ part?: unknown; problem?: unknown; fix?: unknown }> };
    const problems: string[] = [];
    for (const it of (Array.isArray(j.issues) ? j.issues : []).slice(0, 5)) {
      const part = String(it.part ?? "").toLowerCase();
      const what = `противоречие: ${String(it.problem ?? "").slice(0, 200)} → ${String(it.fix ?? "").slice(0, 200)}`;
      const n = part.match(/section\s*(\d+)/)?.[1];
      if (n && sections.some((s) => s.position === Number(n))) problems.push(`Секция ${n}: ${what}`);
      else if (part.includes("faq")) problems.push(`FAQ: ${what}`);
      else if (part.includes("intro")) problems.push(`Вступление: ${what}`);
      else if (part.includes("conclusion")) problems.push(`Заключение: ${what}`);
      else if (part.includes("takeaway")) problems.push(`Выводы: ${what}`);
    }
    return { problems, costUsd: r.costUsd ?? 0 };
  } catch (e) {
    if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
    ctx.log(`проверка согласованности не выполнена: ${e instanceof Error ? e.message : String(e)}`);
    return { problems: [], costUsd: 0 };
  }
}
