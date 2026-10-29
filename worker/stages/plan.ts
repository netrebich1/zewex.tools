import { prisma } from "@/lib/db";
import { planAiPins } from "@/lib/pins/plan/aiPlan";
import { planPinoraPins } from "@/lib/pins/plan/pinoraPlan";
import { buildPinoraParams } from "@/lib/pins/prompts/pinora";
import { decideElements, pinYearFor, pinSiteName } from "@/lib/pins/prompts/elements";
import { allowedPinoraTypes } from "@/lib/pins/recipeForm";
import { nicheLabel } from "@/lib/pins/prompts/pinoraTypes";
import { ideaCountFor } from "@/lib/pins/types";
import { hash32 } from "@/lib/pins/plan/seed";
import { articleKindsFor } from "@/lib/pins/articleKind";
import { blogAiStylesFor, getAiStyle, isBlogAiStyle } from "@/lib/pins/prompts/aiStyles";
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
  // Блоговые статьи (2026-10-26, lib/pins/articleKind.ts) получают ИИ-пины из блоговых стилей своего типа
  // (категория blog в ai-styles.json) независимо от наборов сайта; подборки — из наборов сайта без блоговых стилей.
  const kinds = await articleKindsFor(rc.site.wpConnectionId, todo);
  const blogTodo = todo.filter((p) => kinds.get(p.id)?.kind);
  const ideaTodo = todo.filter((p) => !kinds.get(p.id)?.kind);
  const perPageBlogAi = rc.recipe.blog.ai;
  if (perPageAi > 0 && !sets.length && ideaTodo.length) return { fatal: "В рецепте включены ИИ-пины, но не выбран ни один набор стилей. Откройте настройки сайта → Стили." };
  // Ниша Pinora: заданная в прогоне для всех статей, либо «авто» — по каждой статье; типы — только допустимые для ниши.
  const pinoraNiche = rc.recipe.sets.pinoraNiche && rc.recipe.sets.pinoraNiche !== "auto" ? rc.recipe.sets.pinoraNiche : "";
  const pinoraTypes = rc.recipe.sets.pinoraTypes.filter((t) => allowedPinoraTypes(pinoraNiche || "auto").includes(t));
  if (perPagePinora > 0 && !pinoraTypes.length) return { fatal: `В настройках прогона включены Pinora-пины, но не выбран ни один тип Pinora${pinoraNiche ? ` для ниши «${nicheLabel(pinoraNiche)}»` : " (для ниши «авто» нужны универсальные типы)"}.` };
  const exclusions = await prisma.pinStyleExclusion.findMany({ where: { siteId: rc.site.id, kind: "ai" }, select: { topic: true, styleId: true } });

  const existing = await prisma.pinRunItem.groupBy({ by: ["pageId", "engine"], where: { runId: rc.run.id, status: { notIn: ["REMOVED"] } }, _count: { _all: true } });
  const countOf = (pageId: string, engine: "OPENAI" | "PINORA") => existing.find((e) => e.pageId === pageId && e.engine === engine)?._count._all ?? 0;

  const usedCounts = new Map<string, number>();
  const prior = await prisma.pinRunItem.groupBy({ by: ["styleId"], where: { runId: rc.run.id, engine: "OPENAI" }, _count: { _all: true } });
  for (const p of prior) if (p.styleId) usedCounts.set(p.styleId, p._count._all);

  const ideaSets = sets.map((s) => {
    const ids = s.styleIds as string[];
    const noBlog = ids.filter((id) => !isBlogAiStyle(id));
    return { id: s.id, name: s.name, topic: s.topic, styleIds: noBlog.length ? noBlog : ids };
  });
  const aiRows = perPageAi > 0
    ? planAiPins({
        pages: ideaTodo.map((p) => ({ id: p.id, topic: p.topic, existingAiCount: countOf(p.id, "OPENAI"), quota: p.pinQuota })),
        sets: ideaSets,
        exclusions,
        perPage: perPageAi,
        seed: rc.settings.seed,
        usedCounts,
      })
    : [];
  // Блоговые статьи — свой набор прогона (recipe.blog.ai), а не общий mix.ai.
  if (perPageBlogAi > 0 && blogTodo.length) {
    const byKind = new Map<string, typeof blogTodo>();
    for (const p of blogTodo) { const k = kinds.get(p.id)!.kind!; byKind.set(k, [...(byKind.get(k) ?? []), p]); }
    for (const [kind, list] of byKind) {
      aiRows.push(...planAiPins({
        pages: list.map((p) => ({ id: p.id, topic: "", existingAiCount: countOf(p.id, "OPENAI"), quota: p.pinQuota })),
        sets: [{ id: "blog", name: "Blog", topic: "", styleIds: blogAiStylesFor(kind).map((s) => s.id) }],
        exclusions,
        perPage: perPageBlogAi,
        seed: hash32(`${rc.settings.seed}|blog|${kind}`),
        usedCounts,
        // у блоговых стилей по 5 подстилей — одной статье разные стили, а не два подстиля одного
        familyOf: (id) => getAiStyle(id)?.variantOf ?? id,
      }));
    }
  }
  const pinoraRows = perPagePinora > 0
    ? planPinoraPins({ pages: ideaTodo.map((p) => ({ id: p.id, niche: pinoraNiche || p.niche || rc.site.niche, existingPinoraCount: countOf(p.id, "PINORA") })), types: pinoraTypes, perPage: perPagePinora, seed: rc.settings.seed })
    : [];

  const siteName = pinSiteName(rc.recipe.text, { linkDomain: rc.recipe.publishing.linkDomain, siteName: rc.settings.siteName });
  const data = [
    ...aiRows.map((r) => ({ runId: rc.run.id, pageId: r.pageId, siteId: rc.site.id, kind: "pin", engine: "OPENAI" as const, styleId: r.styleId, sortOrder: r.sortOrder, styleParams: { setId: r.setId } })),
    ...pinoraRows.map((r) => {
      const page = rc.pageById.get(r.pageId)!;
      const id = `${rc.run.id}|${r.pageId}|pinora|${r.sortOrder}`;
      const tags = decideElements(id, rc.recipe.text);
      const params = buildPinoraParams({ type: r.pinType, niche: r.niche || page.niche || rc.site.niche, seed: hash32(id), tags, keyword: page.keyword, pageTitle: page.pageTitle, siteName, ideaCount: ideaCountFor(page, rc.recipe.text) || undefined, year: tags.year ? pinYearFor(rc.recipe.text, page) : undefined, season: tags.season ? page.seasonWord || page.season : undefined });
      return { runId: rc.run.id, pageId: r.pageId, siteId: rc.site.id, kind: "pin", engine: "PINORA" as const, pinType: r.pinType, sortOrder: 500 + r.sortOrder, styleParams: params as object };
    }),
  ];
  if (data.length) await prisma.pinRunItem.createMany({ data });
  for (const p of todo) {
    const set = aiRows.find((r) => r.pageId === p.id && r.setId !== "blog");
    await prisma.pinRunPage.update({ where: { id: p.id }, data: { plannedAt: new Date(), pinSetId: set?.setId ?? p.pinSetId } });
  }
  await ctx.tick({ done: todo.length, total: todo.length, label: "План построен" });
  const blogAi = aiRows.filter((r) => r.setId === "blog").length;
  return { summary: `план: ${aiRows.length} ИИ${blogAi ? ` (из них блоговых ${blogAi} для ${blogTodo.length} статей)` : ""}, ${pinoraRows.length} Pinora` };
};
