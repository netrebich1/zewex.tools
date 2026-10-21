/**
 * Промты и модели этапов из снимка рецепта + подстановка переменных (fillVars статей: `{{var}}` и `{var}`).
 * Промты лежат в рецепте (BlogRecipe.prompts[stageKey] = {system, text}); отсутствие промта — явная ошибка этапа.
 */
import { fillVars } from "@/lib/articles/prompts";
import type { BlogPrompt, BlogRecipeSnapshot } from "./types";

export class PromptMissing extends Error {
  constructor(public readonly stageKey: string) {
    super(`Нет промта для шага «${stageKey}»: откройте рецепт и заполните его`);
    this.name = "PromptMissing";
  }
}

export function resolvePrompt(recipe: BlogRecipeSnapshot, stageKey: string): BlogPrompt {
  const p = recipe.prompts?.[stageKey];
  if (!p || !String(p.text ?? "").trim()) throw new PromptMissing(stageKey);
  return { system: String(p.system ?? ""), text: String(p.text ?? "") };
}

export function resolvePromptOptional(recipe: BlogRecipeSnapshot, stageKey: string): BlogPrompt | null {
  const p = recipe.prompts?.[stageKey];
  if (!p || !String(p.text ?? "").trim()) return null;
  return { system: String(p.system ?? ""), text: String(p.text ?? "") };
}

/** Модель этапа из рецепта (`provider:model`), иначе undefined — возьмётся модель правила слота. */
export function stageModel(recipe: BlogRecipeSnapshot, stageKey: string): string | undefined {
  const m = recipe.models?.[stageKey];
  return m && m.trim() ? m.trim() : undefined;
}

/** Подставить переменные в system и text; бросает, если остались неизвестные (кроме allowMissing). */
export function fillPrompt(p: BlogPrompt, vars: Record<string, unknown>, opts: { allowMissing?: boolean; name?: string } = {}): { system: string; user: string; missing: string[] } {
  const s = fillVars(p.system, vars);
  const u = fillVars(p.text, vars);
  const missing = [...new Set([...s.missing, ...u.missing])];
  if (missing.length && !opts.allowMissing) {
    throw new Error(`В промте «${opts.name ?? "шага"}» не подставлены переменные: ${missing.map((m) => `{{${m}}}`).join(", ")}`);
  }
  return { system: s.text, user: u.text, missing };
}
