import { prisma } from "@/lib/db";
import { generatePinTexts, type TextItem } from "@/lib/pins/texts/generate";
import { dedupeTitles } from "@/lib/pins/texts/dedupe";
import { AiError } from "@/lib/pins/ai/errors";
import { LIMITS } from "@/lib/pins/types";
import type { StageHandler } from "./index";
import { chunk, failItem, loadRunCtx, notRetryYet, okPatch, type ItemOutcome } from "./_shared";

/** Этап texts: заголовок, описание и alt для одобренных пинов с картинкой; затем уникализация заголовков прогона. */
export const texts: StageHandler = async (ctx) => {
  const rc = await loadRunCtx(ctx);
  const items = await prisma.pinRunItem.findMany({
    where: {
      runId: rc.run.id, status: "READY", moderation: "APPROVED",
      AND: [
        { OR: [{ title: "" }, { description: "" }, { altText: "" }] },
        { OR: [{ imagePath: { not: "" } }, { sourceImageUrl: { not: "" } }] },
        notRetryYet(),
      ],
    },
    orderBy: { sortOrder: "asc" },
    include: { page: { select: { keyword: true, topic: true, pageTitle: true, h1: true, url: true, finalUrl: true, season: true, seasonWord: true, boards: true } } },
  });
  await ctx.tick({ done: 0, total: items.length, label: "Тексты" });
  const acc: ItemOutcome = { retry: 0 };
  let done = 0;

  for (const group of chunk(items, 30)) {
    if (ctx.signal.aborted || acc.fatal) break;
    const input: TextItem[] = group.map((it) => ({
      id: it.id,
      keyword: it.page.keyword,
      topic: it.page.topic,
      pageTitle: it.page.pageTitle,
      h1: it.page.h1,
      url: it.page.finalUrl || it.page.url,
      boardName: it.boardName || ((it.page.boards as string[])[0] ?? ""),
      kind: it.kind === "photo" ? "photo" : "pin",
      engine: it.engine,
      prompt: it.prompt || undefined,
      season: it.page.season || undefined,
      seasonWord: it.page.seasonWord || undefined,
    }));
    try {
      const res = await generatePinTexts(rc.ai, {
        items: input,
        language: rc.recipe.text.language,
        hashtags: rc.recipe.text.hashtags,
        hashtagShare: rc.recipe.text.hashtags ? rc.recipe.text.variety : 0,
        audience: rc.recipe.text.audience,
        siteName: rc.settings.siteName,
      }, { signal: ctx.signal });
      for (const it of group) {
        const t = res.get(it.id);
        if (t?.title) {
          const boardName = it.boardName || ((it.page.boards as string[])[0] ?? "");
          await prisma.pinRunItem.update({ where: { id: it.id }, data: { title: t.title.slice(0, LIMITS.title), description: t.description.slice(0, LIMITS.description), altText: t.altText.slice(0, LIMITS.alt), boardName, ...okPatch } });
        } else {
          await failItem(it, "texts", new Error("Модель не вернула текст"), acc);
        }
      }
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") return { fatal: e.cls.message };
      if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : e;
      for (const it of group) await failItem(it, "texts", e, acc);
    }
    done += group.length;
    await ctx.tick({ done, total: items.length, label: `Тексты ${done}/${items.length}` });
  }

  // уникализация заголовков в рамках прогона (одна выгрузка = одни файлы)
  if (!ctx.signal.aborted && !acc.fatal) {
    const rows = await prisma.pinRunItem.findMany({ where: { runId: rc.run.id, status: "READY", moderation: "APPROVED", title: { not: "" } }, select: { id: true, title: true, page: { select: { keyword: true } } } });
    try {
      const renamed = await dedupeTitles(rc.ai, rows.map((r) => ({ id: r.id, title: r.title, keyword: r.page.keyword })), { signal: ctx.signal });
      for (const [id, title] of renamed) await prisma.pinRunItem.update({ where: { id }, data: { title: title.slice(0, LIMITS.title) } });
      if (renamed.size) ctx.log(`titles deduped: ${renamed.size}`);
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") return { fatal: e.cls.message };
      ctx.log("dedupe failed", e);
    }
  }
  if (acc.fatal) return { fatal: acc.fatal };
  return { retryLater: acc.retry, summary: `тексты: ${done}, отложено ${acc.retry}` };
};
