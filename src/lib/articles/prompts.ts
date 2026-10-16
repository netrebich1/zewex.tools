/**
 * Резолвинг промтов и моделей этапа по снимку рецепта + подстановка переменных.
 * Порядок как в оригинале (promptSet.ts): рецепт.stagePromptIds[stage] → набор рецепта (или активный набор ниши/формата)
 * → первый вариант шага по дате. Отсутствие промта — явная ошибка этапа.
 */
import { prisma } from "@/lib/db";
import type { ArtFormat } from "@prisma/client";
import type { ArticleRecipeSnapshot } from "./types";

export type ResolvedPrompt = { id: string; stageKey: string; name: string; system: string; text: string; setId: string };

export class PromptMissing extends Error {
  constructor(public readonly stageKey: string, detail: string) {
    super(`Нет промта для шага «${stageKey}»: ${detail}`);
    this.name = "PromptMissing";
  }
}

/** Набор промтов для рецепта: явный promptSetId, иначе активный набор по нише/поднише/формату. */
export async function resolvePromptSetId(recipe: Pick<ArticleRecipeSnapshot, "promptSetId" | "nicheCode" | "subnicheCode" | "format">): Promise<string | null> {
  if (recipe.promptSetId) return recipe.promptSetId;
  const exact = await prisma.artPromptSet.findFirst({ where: { nicheCode: recipe.nicheCode, subnicheCode: recipe.subnicheCode ?? null, format: recipe.format as ArtFormat, isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (exact) return exact.id;
  const byNiche = await prisma.artPromptSet.findFirst({ where: { nicheCode: recipe.nicheCode, format: recipe.format as ArtFormat, isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return byNiche?.id ?? null;
}

export async function resolvePrompt(recipe: ArticleRecipeSnapshot, stageKey: string): Promise<ResolvedPrompt> {
  const wantedId = recipe.stagePromptIds?.[stageKey];
  if (wantedId) {
    const p = await prisma.artPrompt.findUnique({ where: { id: wantedId } });
    // Выбранный вариант должен быть именно этого шага (в оригинале не проверялось — аудит 01, п.4).
    if (p && p.stageKey === stageKey && p.isActive) return { id: p.id, stageKey, name: p.name, system: p.system ?? "", text: p.text, setId: p.setId };
  }
  const setId = await resolvePromptSetId(recipe);
  if (!setId) throw new PromptMissing(stageKey, `нет набора промтов для ниши «${recipe.nicheCode}» (${recipe.format})`);
  const p = await prisma.artPrompt.findFirst({ where: { setId, stageKey, isActive: true }, orderBy: { createdAt: "asc" } });
  if (!p) throw new PromptMissing(stageKey, "в наборе нет такого шага — откройте рецепт и добавьте промт");
  return { id: p.id, stageKey, name: p.name, system: p.system ?? "", text: p.text, setId: p.setId };
}

/** Промт шага, если он есть; null — этап использует встроенный текст (как оригинал для stage_77 и т.п.). */
export async function resolvePromptOptional(recipe: ArticleRecipeSnapshot, stageKey: string): Promise<ResolvedPrompt | null> {
  try {
    return await resolvePrompt(recipe, stageKey);
  } catch (e) {
    if (e instanceof PromptMissing) return null;
    throw e;
  }
}

/** Модель этапа из рецепта (`provider:model`), иначе undefined — возьмётся модель правила слота. */
export function stageModel(recipe: ArticleRecipeSnapshot, stageKey: string): string | undefined {
  const m = recipe.stageModels?.[stageKey];
  return m && m.trim() ? m.trim() : undefined;
}

/** Переменные, которые разрешено оставлять в тексте после подстановки (их заменяет сборка). */
const KEEP_VARS = new Set(["COUNT"]);

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}|(?<![{\w])\{\s*([A-Za-z0-9_]+)\s*\}(?![}\w])/g;

export type FillResult = { text: string; missing: string[]; used: string[] };

/**
 * Единая подстановка: понимает `{{var}}` и `{var}`. Значение — строка, число, boolean или объект (сериализуется JSON).
 * Неизвестные переменные остаются в тексте и возвращаются в `missing` (кроме {{COUNT}}), чтобы этап мог упасть
 * с понятной ошибкой, а не отдавать модели буквальные плейсхолдеры (аудит 01, п.4; 03, п.1).
 */
export function fillVars(template: string, vars: Record<string, unknown>): FillResult {
  const missing = new Set<string>();
  const used = new Set<string>();
  const text = (template ?? "").replace(VAR_RE, (whole, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b)!;
    if (KEEP_VARS.has(name)) return `{{${name}}}`;
    if (!(name in vars) || vars[name] === undefined) {
      missing.add(name);
      return whole;
    }
    used.add(name);
    const v = vars[name];
    if (v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v, null, 2);
  });
  return { text, missing: [...missing], used: [...used] };
}

/** Подставить переменные в system и text промта; бросает, если остались неизвестные переменные. */
export function fillPrompt(p: ResolvedPrompt, vars: Record<string, unknown>, opts: { allowMissing?: boolean } = {}): { system: string; user: string; missing: string[] } {
  const s = fillVars(p.system, vars);
  const u = fillVars(p.text, vars);
  const missing = [...new Set([...s.missing, ...u.missing])];
  if (missing.length && !opts.allowMissing) {
    throw new Error(`В промте «${p.name}» (${p.stageKey}) не подставлены переменные: ${missing.map((m) => `{{${m}}}`).join(", ")}`);
  }
  return { system: s.text, user: u.text, missing };
}

/** Список переменных, упомянутых в тексте промта (для редактора рецепта). */
export function promptVariables(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(VAR_RE)) out.add((m[1] ?? m[2])!);
  return [...out];
}
