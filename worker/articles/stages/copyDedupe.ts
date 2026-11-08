/**
 * Мешап, проход против повторов по готовой статье (тест v5, 08.11.2026). Писатель пишет секции пачками по 5–6 и не видит
 * статью целиком, поэтому одни и те же фразы («fine, wavy texture», «subtle caramel highlights»), зачины абзацев и
 * советы повторяются из секции в секцию. Здесь один дешёвый вызов (модель плана, flash-lite) получает ВСЕ секции
 * сразу и переписывает только повторяющиеся предложения: факты, заголовки и число абзацев не меняются.
 * Результат сохраняется в ArtSection.html, так что повторные сборки (самопочинка, модерация) бесплатны:
 * cursor.copyDedupe хранит итог и не даёт прогнать второй раз.
 */
import { prisma } from "@/lib/db";
import { aiChat } from "@/lib/articles/ai";
import { SLOTS } from "@/lib/articles/types";
import { stageModel } from "@/lib/articles/prompts";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import type { ArtStageCtx } from "./index";

/** Модель берётся у плана по фото: это самая дешёвая модель сценария, и A/B planModel подменяет именно её. */
const MODEL_STAGE_KEY = "rp_photo_plan";

export type CopyDedupeState = { changed: number; costUsd: number; at: string; skipped?: string };

type Sec = { id: string; position: number; heading: string; html: string };

const paragraphs = (html: string) => (html.match(/<p\b/gi) ?? []).length;
const wordsOf = (html: string) => html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
const BAD_RE = /\b(polished|sophisticated|chic|effortless(?:ly)?|versatile|timeless|elevate[sd]?|stunning|statement piece|pop of color|wardrobe staple|go-to|seamless(?:ly)?|sun-kissed)\b/i;

/**
 * Один вызов на статью. Возвращает число изменённых секций; в журнал пишет итог и цену.
 * Секции с ответом, который не проходит проверку (другое число абзацев, объём вне 70–130 %, появились штампы,
 * пропали цифры), остаются как были.
 */
export async function dedupeCopySections(ctx: ArtStageCtx, sections: Sec[], focusKeyword: string): Promise<CopyDedupeState> {
  const at = new Date().toISOString();
  if (sections.length < 4) return { changed: 0, costUsd: 0, at, skipped: "мало секций" };
  const list = sections.map((s, i) => ({ n: i + 1, h2: s.heading, html: s.html }));
  const system = `You edit a photo-led article about "${focusKeyword}" that was written section by section, so the sections repeat each other. You see the whole article at once. Your only job is variety across sections:
- Find phrases, descriptions and sentence openers that appear in three or more sections (for example the same texture or color wording, the same "If you..." or "This works..." openers, the same upkeep advice). Keep each of them in at most one or two sections; in the others rephrase the sentence with different wording, or cut the sentence if it adds nothing new.
- Never add facts, never change a color, length, shape, technique, product, number or timing. Never change the meaning. Never change or move the heading. Keep the number of <p> paragraphs in each section exactly the same and keep every HTML tag as is. Keep US spelling, plain language, no praise words (no polished, chic, effortless, timeless, elevate, stunning, versatile, sophisticated).
- Do not rewrite sentences that are already unique. Return a section only when you changed it.
Return JSON only: {"sections":[{"n":1,"html":"<p>...</p>"}]}.`;
  try {
    const r = await aiChat(ctx.ai, { slot: SLOTS.textFast, model: stageModel(ctx.recipe, MODEL_STAGE_KEY), system, user: JSON.stringify({ topic: focusKeyword, sections: list }), json: true, temperature: 0.5, maxTokens: 16_000, timeoutMs: 180_000 });
    const out = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as { sections?: unknown } | null;
    const rows = Array.isArray(out?.sections) ? (out!.sections as Array<Record<string, unknown>>) : [];
    let changed = 0;
    const rejected: string[] = [];
    for (const row of rows) {
      const i = Number(row.n) - 1;
      const src = sections[i];
      const html = String(row.html ?? "").trim();
      if (!src || !html || html === src.html) continue;
      const w0 = wordsOf(src.html), w1 = wordsOf(html);
      const digits0 = (src.html.match(/\d+/g) ?? []).join(","), digits1 = (html.match(/\d+/g) ?? []).join(",");
      let why = "";
      if (paragraphs(html) !== paragraphs(src.html)) why = "абзацы";
      else if (w1 < w0 * 0.7 || w1 > w0 * 1.3) why = `объём ${w0}→${w1}`;
      else if (BAD_RE.test(html) && !BAD_RE.test(src.html)) why = "штамп";
      else if (digits0 !== digits1) why = "цифры";
      else if (/<\/?(?:h[1-6]|img|a|script|div)\b/i.test(html)) why = "теги";
      if (why) { rejected.push(`${src.position} (${why})`); continue; }
      await prisma.artSection.update({ where: { id: src.id }, data: { html, wordCount: w1 } });
      src.html = html;
      changed++;
    }
    const costUsd = r.costUsd ?? 0;
    ctx.log(`мешап, проход против повторов: изменено секций ${changed} из ${sections.length}${rejected.length ? `; отклонено ${rejected.join(", ")}` : ""}; $${costUsd.toFixed(4)}`);
    return { changed, costUsd, at };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log(`мешап, проход против повторов: вызов не удался (${msg}), секции оставлены как есть`);
    return { changed: 0, costUsd: 0, at, skipped: msg.slice(0, 200) };
  }
}
