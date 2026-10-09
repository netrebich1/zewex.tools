import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { guessAccent, renderPin } from "@/lib/pins/canvas";
import { toRecipe } from "@/lib/pins/canvas/styleSpec";
import { approvedStylesForSite } from "@/lib/pins/canvas/catalog";
import { generateHooks, type CanvasHook } from "@/lib/pins/canvas/hooks";
import { cachedPhoto } from "@/lib/pins/canvas/photos";
import { planCanvasPins } from "@/lib/pins/plan/canvasPlan";
import { hash32 } from "@/lib/pins/plan/seed";
import { decideElements, currentYear, seasonForDate, seasonWord } from "@/lib/pins/prompts/elements";
import { ideaCountFor } from "@/lib/pins/types";
import { makeThumb } from "@/lib/pins/images";
import { itemImageRel, itemThumbRel, writeFileAtomic } from "@/lib/pins/storage";
import { AiError } from "@/lib/pins/ai/errors";
import type { StageHandler } from "./index";
import { loadRunCtx } from "./_shared";

/**
 * Этап canvas: Canvas-пины на сервере. Для каждой страницы: хуки (ИИ) → план по утверждённым
 * стилям и пулу фото → рендер → JPEG + миниатюра → элемент engine=CANVAS.
 */
export const canvasStage: StageHandler = async (ctx) => {
  const rc = await loadRunCtx(ctx);
  const perPage = rc.recipe.mix.canvas;
  if (perPage <= 0) return { summary: "canvas выключен" };
  const styles = await approvedStylesForSite(rc.site.id, rc.recipe.sets.canvasSetIds, rc.recipe.sets.canvasStyleIds ?? []);
  if (!styles.length) return { fatal: (rc.recipe.sets.canvasStyleIds?.length || rc.recipe.sets.canvasSetIds.length)
    ? "Выбранные Canvas-стили больше не утверждены или скрыты. Откройте настройки прогона, выберите стили заново и нажмите «Продолжить»."
    : "Нет утверждённых Canvas-стилей для этого сайта. Откройте Стили → Canvas-стили, утвердите стили каталога и нажмите «Продолжить»." };

  const pages = rc.pages.filter((p) => p.keyword);
  const pool = await prisma.pinRunItem.findMany({ where: { runId: rc.run.id, engine: "PHOTO", status: { in: ["POOL", "READY"] } }, select: { pageId: true, sourceImageUrl: true } });
  const poolByPage = new Map<string, string[]>();
  for (const p of pool) poolByPage.set(p.pageId, [...(poolByPage.get(p.pageId) ?? []), p.sourceImageUrl]);
  // Обрывки от сбоя (элемент создан, файл не записан) убираем, чтобы страница получила пин заново.
  await prisma.pinRunItem.deleteMany({ where: { runId: rc.run.id, engine: "CANVAS", imagePath: "", status: { in: ["PENDING", "ERROR"] } } });
  const existing = await prisma.pinRunItem.groupBy({ by: ["pageId"], where: { runId: rc.run.id, engine: "CANVAS", status: { not: "REMOVED" } }, _count: { _all: true } });
  const existingCount = (id: string) => existing.find((e) => e.pageId === id)?._count._all ?? 0;

  const plan = planCanvasPins({
    pages: pages.map((p) => ({ id: p.id, poolPhotoCount: (poolByPage.get(p.id) ?? []).length, existingCanvasCount: existingCount(p.id), quota: p.canvasQuota })),
    styles: styles.map((s) => ({ id: s.id, counts: s.spec.counts })),
    perPage,
    seed: rc.settings.seed,
  });
  await ctx.tick({ done: 0, total: plan.length, label: "Canvas-пины" });
  if (!plan.length) return { summary: "canvas-пины уже собраны" };

  // хуки для страниц, где они ещё не сохранены
  const needHooks = pages.filter((p) => plan.some((r) => r.pageId === p.id) && !(Array.isArray(p.canvasHooks) && (p.canvasHooks as unknown[]).length));
  if (needHooks.length) {
    try {
      const hooks = await generateHooks(rc.ai, {
        pages: needHooks.map((p) => ({ id: p.id, keyword: p.keyword, title: p.pageTitle || p.h1, topic: p.topic, niche: p.niche || rc.site.niche, season: p.seasonWord || p.season || undefined, ideaCount: ideaCountFor(p, rc.recipe.text) || undefined })),
        language: rc.recipe.text.language,
        audience: rc.recipe.text.audience,
        perPage: Math.max(perPage, 3),
      }, { signal: ctx.signal });
      for (const p of needHooks) {
        const h = hooks.get(p.id) ?? [];
        await prisma.pinRunPage.update({ where: { id: p.id }, data: { canvasHooks: h as unknown as Prisma.InputJsonValue } });
        p.canvasHooks = h as unknown as typeof p.canvasHooks;
      }
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : e;
      if (e instanceof AiError && e.cls.kind === "fatal_run") return { fatal: e.cls.message };
      ctx.log("hooks failed, fallback to titles", e);
    }
  }

  let done = 0, failed = 0;
  // Домен на пине: домен для ссылок из рецепта, иначе хост страницы, иначе название сайта.
  const siteDomain = rc.settings.siteName.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const domainFor = (url?: string | null) => {
    if (rc.recipe.publishing.linkDomain) return rc.recipe.publishing.linkDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    try { return url ? new URL(url).hostname.replace(/^www\./, "") : siteDomain; } catch { return siteDomain; }
  };
  for (const row of plan) {
    if (ctx.signal.aborted) break;
    const page = rc.pageById.get(row.pageId);
    const style = styles.find((s) => s.id === row.styleId);
    if (!page || !style) { failed++; continue; }
    try {
      const urls = poolByPage.get(page.id) ?? [];
      const seed = hash32(`${rc.settings.seed}|${page.id}|${row.styleId}|${row.sortOrder}`);
      const start = seed % Math.max(1, urls.length);
      const chosen: string[] = [];
      for (let i = 0; i < urls.length && chosen.length < row.photoCount; i++) chosen.push(urls[(start + i) % urls.length]);
      const photos: Buffer[] = [];
      for (const u of chosen) { try { photos.push(await cachedPhoto(u, ctx.signal)); } catch { /* битое фото */ } }
      if (!photos.length) throw new Error("Нет доступных фото статьи");
      const hooks = (page.canvasHooks as unknown as CanvasHook[] | null) ?? [];
      const hook = hooks.length ? hooks[row.sortOrder % hooks.length] : { title: page.keyword };
      // Элементы пина по процентам рецепта (как у ИИ-пинов): сезон/год — в кикер, число — только
      // если стиль умеет цифру (обязательная цифра стиля ставится всегда), призыв и имя сайта — по жребию.
      const tags = decideElements(`${page.id}|${row.styleId}|${row.sortOrder}`, rc.recipe.text);
      const ideaCount = ideaCountFor(page, rc.recipe.text);
      const numberRequired = style.spec.number?.mode === "required";
      const showNumber = ideaCount >= 3 && !!style.spec.number && (numberRequired || tags.number);
      const lang = rc.recipe.text.language;
      const seasonTxt = tags.season ? (page.seasonWord || seasonWord((page.season as "fall" | "winter" | "spring" | "summer") || seasonForDate(), lang)) : "";
      const yearTxt = tags.year ? currentYear() : "";
      const kickerParts = [seasonTxt, yearTxt].filter(Boolean);
      const kicker = kickerParts.length ? kickerParts.join(" ") : hook.kicker;
      // Профиль акцента для умной обрезки: ниша сайта и ключ страницы (ногти, волосы, одежда…).
      const accent = guessAccent(page.niche || rc.site.niche, page.keyword, page.topic, page.pageTitle || page.h1);
      const recipe = { ...toRecipe(style.spec, seed, photos.length), accent };
      const r = await renderPin({ recipe, photos, texts: { title: hook.title, kicker, cta: tags.cta ? hook.cta : undefined, domain: tags.siteName ? domainFor(page.finalUrl || page.url) : undefined, number: showNumber ? String(ideaCount) : undefined }, seed });
      const item = await prisma.pinRunItem.create({
        data: { runId: rc.run.id, pageId: page.id, siteId: rc.site.id, kind: "pin", engine: "CANVAS", styleId: row.styleId, sourceImageUrl: chosen[0] ?? "", sortOrder: 2000 + row.sortOrder, status: "PENDING", title: "", styleParams: { hook, tags, ideaCount, photos: chosen, photoCount: photos.length, issues: r.issues } as object },
      });
      const rel = itemImageRel(rc.run.id, item.id);
      await writeFileAtomic(rel, r.jpeg);
      const thumbRel = itemThumbRel(rc.run.id, item.id);
      await writeFileAtomic(thumbRel, await makeThumb(r.jpeg));
      await prisma.pinRunItem.update({ where: { id: item.id }, data: { imagePath: rel, thumbPath: thumbRel, imageW: r.width, imageH: r.height, status: "READY" } });
    } catch (e) {
      failed++;
      ctx.log(`canvas pin failed page=${page.id.slice(0, 8)} style=${row.styleId}`, e);
    }
    done++;
    await ctx.tick({ done, total: plan.length, label: `Canvas ${done}/${plan.length}` });
  }
  if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("aborted");
  return { summary: `canvas: ${done - failed} готово, ${failed} с ошибкой` };
};
