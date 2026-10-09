import { prisma } from "@/lib/db";
import { planAiPins } from "@/lib/pins/plan/aiPlan";
import { planPinoraPins } from "@/lib/pins/plan/pinoraPlan";
import { buildPinoraParams } from "@/lib/pins/prompts/pinora";
import { decideElements, currentYear } from "@/lib/pins/prompts/elements";
import { ideaCountFor } from "@/lib/pins/types";
import { hash32 } from "@/lib/pins/plan/seed";
import type { StageHandler } from "./index";
import { loadRunCtx } from "./_shared";

/**
 * Этап plan: создаёт пустые элементы ИИ-пинов и Pinora-пинов по рецепту
 * (стиль / тип уже назначен, промта и картинки ещё нет). Canvas планируется своим этапом.
 */
export const plan: StageHandler = async (ctx) => {
  const rc = await loadRunCtx(ctx);
  const todo = rc.pages.filter((p) => !p.plannedAt && p.keyword);
  await ctx.tick({ done: 0, total: todo.length, label: "План пинов" });
  if (!todo.length) return { summary: "план уже построен" };

  const { ai: perPageAi, pinora: perPagePinora } = rc.recipe.mix;
  const sets = await prisma.pinSet.findMany({ where: { siteId: rc.site.id, setKind: "ai", id: { in: rc.recipe.sets.aiSetIds } } });
  if (perPageAi > 0 && !sets.length) return { fatal: "В рецепте включены ИИ-пины, но не выбран ни один набор стилей. Откройте настройки сайта → Стили." };
  if (perPagePinora > 0 && !rc.recipe.sets.pinoraTypes.length) return { fatal: "В рецепте включены Pinora-пины, но не выбран ни один тип Pinora." };
  const exclusions = await prisma.pinStyleExclusion.findMany({ where: { siteId: rc.site.id, kind: "ai" }, select: { topic: true, styleId: true } });

  const existing = await prisma.pinRunItem.groupBy({ by: ["pageId", "engine"], where: { runId: rc.run.id, status: { notIn: ["REMOVED"] } }, _count: { _all: true } });
  const countOf = (pageId: string, engine: "OPENAI" | "PINORA") => existing.find((e) => e.pageId === pageId && e.engine === engine)?._count._all ?? 0;

  const usedCounts = new Map<string, number>();
  const prior = await prisma.pinRunItem.groupBy({ by: ["styleId"], where: { runId: rc.run.id, engine: "OPENAI" }, _count: { _all: true } });
  for (const p of prior) if (p.styleId) usedCounts.set(p.styleId, p._count._all);

  const aiRows = perPageAi > 0
    ? planAiPins({
        pages: todo.map((p) => ({ id: p.id, topic: p.topic, existingAiCount: countOf(p.id, "OPENAI"), quota: p.pinQuota })),
        sets: sets.map((s) => ({ id: s.id, name: s.name, topic: s.topic, styleIds: (s.styleIds as string[]) })),
        exclusions,
        perPage: perPageAi,
        seed: rc.settings.seed,
        usedCounts,
      })
    : [];
  const pinoraRows = perPagePinora > 0
    ? planPinoraPins({ pages: todo.map((p) => ({ id: p.id, niche: p.niche, existingPinoraCount: countOf(p.id, "PINORA") })), types: rc.recipe.sets.pinoraTypes, perPage: perPagePinora, seed: rc.settings.seed })
    : [];

  const year = currentYear();
  const data = [
    ...aiRows.map((r) => ({ runId: rc.run.id, pageId: r.pageId, siteId: rc.site.id, kind: "pin", engine: "OPENAI" as const, styleId: r.styleId, sortOrder: r.sortOrder, styleParams: { setId: r.setId } })),
    ...pinoraRows.map((r) => {
      const page = rc.pageById.get(r.pageId)!;
      const id = `${rc.run.id}|${r.pageId}|pinora|${r.sortOrder}`;
      const tags = decideElements(id, rc.recipe.text);
      const params = buildPinoraParams({ type: r.pinType, niche: page.niche || rc.site.niche, seed: hash32(id), tags, keyword: page.keyword, pageTitle: page.pageTitle, siteName: rc.settings.siteName, ideaCount: ideaCountFor(page, rc.recipe.text) || undefined, year: tags.year ? year : undefined, season: tags.season ? page.seasonWord || page.season : undefined });
      return { runId: rc.run.id, pageId: r.pageId, siteId: rc.site.id, kind: "pin", engine: "PINORA" as const, pinType: r.pinType, sortOrder: 500 + r.sortOrder, styleParams: params as object };
    }),
  ];
  if (data.length) await prisma.pinRunItem.createMany({ data });
  for (const p of todo) {
    const set = aiRows.find((r) => r.pageId === p.id);
    await prisma.pinRunPage.update({ where: { id: p.id }, data: { plannedAt: new Date(), pinSetId: set?.setId ?? p.pinSetId } });
  }
  await ctx.tick({ done: todo.length, total: todo.length, label: "План построен" });
  return { summary: `план: ${aiRows.length} ИИ, ${pinoraRows.length} Pinora` };
};
