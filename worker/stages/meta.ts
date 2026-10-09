import { prisma } from "@/lib/db";
import { checkRedirects } from "@/lib/pins/stages/redirects";
import { extractMeta } from "@/lib/pins/stages/meta";
import { detectKeywords, fallbackKeyword } from "@/lib/pins/stages/keywords";
import { AiError } from "@/lib/pins/ai/errors";
import type { StageHandler } from "./index";
import { loadRunCtx } from "./_shared";

/**
 * Этап meta: конечные адреса (редиректы), title/H1/число фото, ключевое слово,
 * доски, тема, ниша, сезон. Делает только для страниц без ключа или досок.
 */
export const meta: StageHandler = async (ctx) => {
  const rc = await loadRunCtx(ctx);
  const boards = await prisma.pinBoard.findMany({ where: { siteId: rc.site.id }, orderBy: { sortOrder: "asc" } });
  const boardNames = boards.map((b) => b.name);
  if (!boardNames.length) return { fatal: "У сайта нет досок Pinterest. Добавьте доски в настройках сайта и нажмите «Продолжить»." };

  const todo = rc.pages.filter((p) => (!p.keyword || !(Array.isArray(p.boards) && (p.boards as unknown[]).length)) && p.metaAttempts < 3);
  await ctx.tick({ done: 0, total: todo.length, label: "Ключи и доски" });
  if (!todo.length) return { summary: "все страницы уже с ключами" };

  // 1. редиректы
  const needRedirect = todo.filter((p) => !p.finalUrl);
  if (needRedirect.length) {
    const red = await checkRedirects(needRedirect.map((p) => p.url), { signal: ctx.signal });
    for (const p of needRedirect) {
      const r = red.get(p.url);
      await prisma.pinRunPage.update({ where: { id: p.id }, data: { finalUrl: r?.finalUrl || p.url } });
      p.finalUrl = r?.finalUrl || p.url;
    }
    await ctx.tick({ label: "Редиректы проверены" });
  }

  // 2. мета
  const metaMap = await extractMeta(todo.map((p) => p.finalUrl || p.url), { signal: ctx.signal });
  for (const p of todo) {
    const m = metaMap.get(p.finalUrl || p.url);
    if (!m) continue;
    const data = { pageTitle: m.title || p.pageTitle, h1: m.h1 || p.h1, imageCount: m.imageCount, sectionImageCount: m.sectionImageCount, featuredImage: m.ogImage ?? p.featuredImage, error: m.error ?? null };
    await prisma.pinRunPage.update({ where: { id: p.id }, data });
    Object.assign(p, data);
  }
  await ctx.tick({ label: "Заголовки прочитаны" });

  // 3. ключи и доски пачками (внутри detectKeywords), прогресс через onBatch
  let done = 0;
  let kw: Awaited<ReturnType<typeof detectKeywords>>;
  try {
    kw = await detectKeywords(
      rc.ai,
      {
        pages: todo.map((p) => ({ url: p.finalUrl || p.url, title: p.pageTitle, h1: p.h1 })),
        siteNiche: rc.site.niche,
        language: rc.recipe.text.language,
        boards: boardNames,
        multiBoard: rc.recipe.boards.multiBoard,
      },
      {
        signal: ctx.signal,
        onBatch: async (d, t) => {
          done = d;
          await ctx.tick({ done: d, total: t, label: `Ключи и доски ${d}/${t}` });
        },
      },
    );
  } catch (e) {
    if (e instanceof AiError && e.cls.kind === "fatal_run") return { fatal: e.cls.message };
    throw e;
  }

  let withoutKeyword = 0;
  for (const p of todo) {
    const r = kw.get(p.finalUrl || p.url);
    const keyword = (r?.keyword || "").trim() || fallbackKeyword({ title: p.pageTitle, h1: p.h1, url: p.url });
    const pageBoards = (r?.boards || []).filter((b) => boardNames.includes(b));
    if (!pageBoards.length) pageBoards.push(boardNames[0]);
    if (!keyword) withoutKeyword++;
    await prisma.pinRunPage.update({
      where: { id: p.id },
      data: {
        keyword,
        boards: pageBoards,
        topic: r?.topic || p.topic,
        niche: r?.niche || p.niche,
        season: r?.season || p.season,
        seasonWord: r?.seasonWord || p.seasonWord,
        metaAttempts: { increment: keyword ? 0 : 1 },
        status: keyword ? "ready" : "error",
        error: keyword ? null : "Не удалось определить ключевое слово",
      },
    });
  }
  await ctx.tick({ done: todo.length, total: todo.length, label: "Ключи и доски готовы" });
  const ready = await prisma.pinRunPage.count({ where: { runId: rc.run.id, keyword: { not: "" } } });
  if (!ready) return { fatal: "Ни у одной страницы не удалось определить ключевое слово. Проверьте ссылки." };
  return { summary: `${todo.length - withoutKeyword} страниц с ключами, ${withoutKeyword} без`, retryLater: withoutKeyword && done < todo.length ? withoutKeyword : 0 };
};
