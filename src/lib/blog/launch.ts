/**
 * Постановка инфо-статей в очередь: запуск (BlogRun) + пост на каждый ключ со снимком рецепта.
 * Правка рецепта после запуска на уже созданные посты не влияет — их исполняет воркер по снимку.
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { sanitizeTopic } from "@/lib/articles/text/textGuards";
import { canAccessBlogSite } from "./access";
import { buildSnapshot, findDuplicateKeywords, recipeShape } from "./recipes";
import { firstStage } from "./stages";
import type { BlogRunSettings, KeywordInput } from "./types";

export type LaunchInput = { siteId: string; settings: BlogRunSettings; keywords: KeywordInput[]; name?: string };
export type LaunchResult = { runId: string; created: number; skipped: string[]; invalid: string[] };

export async function launchPosts(me: CurrentUser, input: LaunchInput): Promise<LaunchResult> {
  const site = await prisma.blogSite.findUnique({ where: { id: input.siteId }, select: { id: true, teamId: true, accessId: true, isActive: true, name: true, settings: true } });
  if (!site || !(await canAccessBlogSite(me, site))) throw new Error("Сайт не найден");
  if (!site.isActive) throw new Error("Сайт в архиве: верните его из архива в настройках");
  if (!input.settings.recipeId) throw new Error("Выберите рецепт");
  const recipeRow = await prisma.blogRecipe.findUnique({ where: { id: input.settings.recipeId } });
  if (!recipeRow || !recipeRow.isActive) throw new Error("Рецепт не найден или выключен");
  const recipe = recipeShape(recipeRow);

  const invalid: string[] = [];
  const cleaned: KeywordInput[] = [];
  for (const k of input.keywords) {
    const keyword = sanitizeTopic(k.keyword);
    if (!keyword || keyword.length < 3) { invalid.push(k.keyword); continue; }
    cleaned.push({ keyword, focusKeyword: k.focusKeyword?.trim() || undefined });
  }
  const seen = new Set<string>();
  const inner: string[] = [];
  const unique = cleaned.filter((k) => { const l = k.keyword.toLowerCase(); if (seen.has(l)) { inner.push(k.keyword); return false; } seen.add(l); return true; });
  const dup = new Set(await findDuplicateKeywords(site.id, unique.map((k) => k.keyword)));
  const skipped = [...unique.filter((k) => dup.has(k.keyword.toLowerCase())).map((k) => k.keyword), ...inner.map((k) => `${k} (повтор в списке)`)];
  const fresh = unique.filter((k) => !dup.has(k.keyword.toLowerCase()));
  if (!fresh.length) throw new Error(skipped.length ? `Все ключи уже есть у этого сайта: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}` : "Добавьте хотя бы один ключ");

  const snapshot = buildSnapshot(recipe, input.settings);
  const runName = input.name?.trim() || `${new Date().toLocaleDateString("ru-RU")} · ${recipe.name} · ${fresh.length} ключей`;
  const run = await prisma.blogRun.create({
    data: { teamId: site.teamId, siteId: site.id, recipeId: recipe.id, createdById: me.id, name: runName.slice(0, 190), settings: input.settings as unknown as Prisma.InputJsonValue },
  });
  const data: Prisma.BlogPostCreateManyInput[] = fresh.map((k) => ({
    teamId: site.teamId, siteId: site.id, runId: run.id, recipeId: recipe.id, createdById: me.id,
    keyword: k.keyword, focusKeyword: k.focusKeyword ?? "",
    recipe: snapshot as unknown as Prisma.InputJsonValue, status: "PENDING", stage: firstStage(), attempts: 0, priority: 0,
  }));
  for (let i = 0; i < data.length; i += 50) await prisma.blogPost.createMany({ data: data.slice(i, i + 50) });
  return { runId: run.id, created: fresh.length, skipped, invalid };
}
