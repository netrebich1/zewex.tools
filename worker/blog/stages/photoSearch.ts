/**
 * Этап `photo_search`: по каждому слоту картинки (BlogImageSlot) без выбранного фото — один поисковый запрос Google Images
 * (DataForSEO, резерв SerpApi): первый проход — slot.query, второй (после неудачной оценки) — altQuery или вариант с ключом.
 * Кандидаты → BlogPhotoCandidate (found); дубли по URL внутри поста и запрещённые домены отсеиваются сразу.
 * Кэш: тот же текст запроса у другого поста → его не отклонённые кандидаты без обращения к API.
 */
import { prisma } from "@/lib/db";
import type { BlogImageSlot, Prisma } from "@prisma/client";
import { AiError } from "@/lib/pins/ai/errors";
import { buildSearchQuery, hostOf, isBlockedDomain, searchCfgFor, searchImagesWithFallback, type PhotoCandidateInput, type SearchCfg } from "@/lib/blog/photo/search";
import type { StageHandler, StageResult } from "./index";

/** Сколько раз ищем для одного слота (основной запрос, запасной). */
export const MAX_SLOT_SEARCHES = 2;

export function slotOrientation(s: Pick<BlogImageSlot, "orientation">): "tall" | "square" | "any" {
  return s.orientation === "tall" || s.orientation === "square" ? s.orientation : "any";
}

/** Запрос для очередного прохода слота: query → altQuery → «ключ + суть». */
export function slotQueryFor(slot: Pick<BlogImageSlot, "query" | "altQuery" | "searches">, keyword: string): string {
  if (slot.searches === 0) return slot.query;
  if (slot.altQuery?.trim() && slot.altQuery.trim().toLowerCase() !== slot.query.trim().toLowerCase()) return slot.altQuery.trim();
  const q = slot.query.replace(/\b(real photo|close-up|closeup|photo)\b/gi, "").replace(/\s+/g, " ").trim();
  return `${keyword} ${q}`.slice(0, 160);
}

export const photoSearch: StageHandler = async (ctx) => {
  const { post, recipe } = ctx;
  const ps = recipe.photoSearch;
  const slots = await prisma.blogImageSlot.findMany({ where: { postId: post.id }, orderBy: { createdAt: "asc" } });
  if (!slots.length) return { next: "outline", summary: "Нет слотов картинок — возврат к плану" };
  const pending = slots.filter((s) => !s.chosenPhotoId && s.status !== "empty" && (s.status === "pending" || s.searches === 0));
  if (!pending.length) return { summary: "Все слоты уже с кандидатами — пропуск", details: { skipped: true } };

  const known = new Set((await prisma.blogPhotoCandidate.findMany({ where: { postId: post.id }, select: { url: true } })).map((c) => c.url));
  const notes: string[] = [];
  let total = 0;
  let failure: StageResult | null = null;
  const perSlot: Record<string, number> = {};

  for (const slot of pending) {
    if (slot.searches >= MAX_SLOT_SEARCHES) {
      await prisma.blogImageSlot.update({ where: { id: slot.id }, data: { status: "searched" } });
      continue;
    }
    const cfg: SearchCfg = searchCfgFor(ps, slotOrientation(slot));
    const english = slotQueryFor(slot, post.keyword);
    const query = buildSearchQuery(english, cfg);
    await ctx.tick(`Поиск фото: ${slot.key} «${english.slice(0, 50)}»`);

    let items: PhotoCandidateInput[] = [];
    let engine = "";
    const cached = await prisma.blogPhotoCandidate.findMany({
      where: { searchQuery: query, postId: { not: post.id }, status: { not: "rejected" } },
      select: { url: true, thumbUrl: true, pageUrl: true, domain: true, title: true, width: true, height: true },
      take: ps.perSlot,
    });
    if (cached.length >= Math.min(ps.perSlot, 25)) {
      items = cached.map((c) => ({ source: "cache", searchQuery: query, url: c.url, thumbUrl: c.thumbUrl || null, pageUrl: c.pageUrl || null, domain: c.domain || null, title: c.title || null, width: c.width, height: c.height }));
      engine = "кэш";
    } else {
      const r = await searchImagesWithFallback(ctx.ai, query, cfg, ps.perSlot);
      items = r.items;
      engine = r.engine;
      if (r.error) notes.push(`${slot.key}: ${r.error}`);
      if (!r.items.length) {
        if (r.notConfigured) throw new AiError({ code: "no_binding", kind: "fatal_run", message: `Не подключены ключи поиска картинок: нужен DataForSEO (слот «photo_dfs») или SerpAPI («photo_serp») для проекта «Pin Blog Article». ${r.error || ""}`.trim() }, 409);
        if (r.keyProblem && !r.transient) throw new AiError({ code: "no_credits", kind: "fatal_run", message: `Поиск картинок: ${r.keyProblem}` }, 402);
        if (r.transient && !failure) failure = { retryInMs: 90_000, retryKind: "transient", summary: `Поиск картинок временно недоступен (${r.error || "ошибка провайдера"})`, giveUp: `Поиск картинок недоступен около часа: ${r.error || "ошибка провайдера"}` };
      }
    }

    const rows: Prisma.BlogPhotoCandidateCreateManyInput[] = [];
    let position = 0;
    for (const it of items) {
      position++;
      if (!it.url || known.has(it.url)) continue;
      const domain = it.domain || hostOf(it.pageUrl) || hostOf(it.url) || "";
      if (isBlockedDomain(domain, cfg.exclude_domains)) continue;
      if (it.width && it.height) {
        if (Math.min(it.width, it.height) < Math.min(cfg.min_width, cfg.min_height)) continue;
      }
      known.add(it.url);
      rows.push({
        postId: post.id, slotId: slot.id, url: it.url.slice(0, 2000), pageUrl: (it.pageUrl || "").slice(0, 2000), domain: domain.slice(0, 190), thumbUrl: (it.thumbUrl || "").slice(0, 2000),
        title: (it.title || "").slice(0, 2000), searchQuery: query.slice(0, 490), position, width: it.width ?? null, height: it.height ?? null, status: "found",
      });
    }
    for (let i = 0; i < rows.length; i += 200) await prisma.blogPhotoCandidate.createMany({ data: rows.slice(i, i + 200) });
    perSlot[slot.key] = rows.length;
    total += rows.length;
    // Временный сбой провайдера — запрос не считаем использованным, иначе слот потеряет попытку.
    const consumed = !(items.length === 0 && failure);
    await prisma.blogImageSlot.update({ where: { id: slot.id }, data: { status: "searched", ...(consumed ? { searches: { increment: 1 } } : {}) } });
    ctx.log(`${slot.key} (${engine}): «${query}» → ${items.length} найдено, ${rows.length} добавлено`);
  }

  if (failure && total === 0) return failure;
  const emptySlots = Object.entries(perSlot).filter(([, n]) => n === 0).map(([k]) => k);
  return {
    summary: `Найдено кандидатов: ${total} для ${pending.length} слотов${emptySlots.length ? ` (пусто: ${emptySlots.join(", ")})` : ""}`,
    details: { total, perSlot, notes, emptySlots },
  };
};
