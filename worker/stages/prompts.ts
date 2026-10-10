import { prisma } from "@/lib/db";
import type { PinRunItem } from "@prisma/client";
import { generateAiPrompts } from "@/lib/pins/prompts/aiPrompt";
import { generatePinoraPrompts, type PinoraParams } from "@/lib/pins/prompts/pinora";
import { decideElements, pinYear, pinSiteName } from "@/lib/pins/prompts/elements";
import { ideaCountFor } from "@/lib/pins/types";
import { AiError } from "@/lib/pins/ai/errors";
import type { StageHandler } from "./index";
import { chunk, failItem, loadRunCtx, notRetryYet, okPatch, runQueue, type ItemOutcome } from "./_shared";

/** Пустой ответ модели — временная ошибка: элемент уйдёт на повтор с паузой, а не сразу в ERROR. */
const noPrompt = (msg: string) => new AiError({ code: "empty", kind: "transient", message: msg }, 502);

/** Этап prompts: промты для ИИ-пинов (OpenAI) и Pinora-пинов. Только для элементов без промта. */
export const prompts: StageHandler = async (ctx) => {
  const rc = await loadRunCtx(ctx);
  const items = await prisma.pinRunItem.findMany({
    where: { runId: rc.run.id, kind: "pin", prompt: "", status: { in: ["PENDING"] }, moderation: { not: "REJECTED" }, engine: { in: ["OPENAI", "PINORA"] }, ...notRetryYet() },
    orderBy: { sortOrder: "asc" },
  });
  await ctx.tick({ done: 0, total: items.length, label: "Промты" });
  if (!items.length) return { summary: "промты готовы" };

  const overrides = await prisma.pinStyleOverride.findMany({ where: { teamId: rc.run.teamId, isActive: true, OR: [{ siteId: rc.site.id }, { siteId: null }] } });
  const overrideFor = (styleId: string | null) => {
    if (!styleId) return undefined;
    const o = overrides.find((x) => x.styleId === styleId && x.siteId === rc.site.id) ?? overrides.find((x) => x.styleId === styleId && !x.siteId);
    return o?.instruction || undefined;
  };
  const year = pinYear(rc.recipe.text);
  const siteName = pinSiteName(rc.recipe.text, { linkDomain: rc.recipe.publishing.linkDomain, siteName: rc.settings.siteName });
  const acc: ItemOutcome = { retry: 0 };
  let done = 0;
  const bump = async (n: number) => {
    done += n;
    await ctx.tick({ done, total: items.length, label: `Промты ${done}/${items.length}` });
  };

  const byPage = new Map<string, PinRunItem[]>();
  for (const it of items) byPage.set(it.pageId, [...(byPage.get(it.pageId) || []), it]);

  await runQueue([...byPage.entries()], 3, async ([pageId, list]) => {
    const page = rc.pageById.get(pageId);
    if (!page) return;
    const aiItems = list.filter((i) => i.engine === "OPENAI");
    const pinoraItems = list.filter((i) => i.engine === "PINORA");

    for (const group of chunk(aiItems, 3)) {
      if (ctx.signal.aborted || acc.fatal) return;
      try {
        const res = await generateAiPrompts(rc.ai, {
          keyword: page.keyword,
          topic: page.topic,
          niche: page.niche || rc.site.niche,
          language: rc.recipe.text.language,
          audience: rc.recipe.text.audience,
          siteName,
          brandColor: rc.recipe.text.brandColor,
          ideaCount: ideaCountFor(page, rc.recipe.text) || undefined,
          season: page.season || undefined,
          seasonWord: page.seasonWord || undefined,
          year,
          styles: group.map((it) => ({ id: it.styleId || "", overrideInstruction: overrideFor(it.styleId), tags: decideElements(it.id, rc.recipe.text) })),
        }, { signal: ctx.signal });
        const byStyle = new Map(res.map((r) => [r.styleId, r.prompt]));
        for (const it of group) {
          const prompt = byStyle.get(it.styleId || "");
          if (prompt && prompt.trim().length >= 20) await prisma.pinRunItem.update({ where: { id: it.id }, data: { prompt, ...okPatch } });
          else await failItem(it, "prompts", noPrompt("Модель не вернула промт для стиля"), acc);
        }
      } catch (e) {
        for (const it of group) await failItem(it, "prompts", e, acc);
      }
      await bump(group.length);
    }

    if (pinoraItems.length && !ctx.signal.aborted && !acc.fatal) {
      try {
        const res = await generatePinoraPrompts(rc.ai, pinoraItems.map((it) => ({ id: it.id, params: it.styleParams as unknown as PinoraParams, keyword: page.keyword, topic: page.topic, language: rc.recipe.text.language, audience: rc.recipe.text.audience })), { signal: ctx.signal });
        for (const it of pinoraItems) {
          const r = res.get(it.id);
          if (r?.prompt) await prisma.pinRunItem.update({ where: { id: it.id }, data: { prompt: r.prompt, title: r.title ? r.title.slice(0, 255) : it.title, ...okPatch } });
          else await failItem(it, "prompts", noPrompt("Модель не вернула промт Pinora"), acc);
        }
      } catch (e) {
        for (const it of pinoraItems) await failItem(it, "prompts", e, acc);
      }
      await bump(pinoraItems.length);
    }
  }, ctx.signal);

  if (acc.fatal) return { fatal: acc.fatal };
  return { retryLater: acc.retry, summary: `промты: ${done}, отложено ${acc.retry}` };
};
