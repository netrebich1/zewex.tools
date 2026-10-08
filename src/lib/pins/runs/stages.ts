import type { JobStage } from "../types";

/** Следующий этап после успешно завершённого — по тому, что реально нужно прогону (рецепт). */
export function nextStageAfter(stage: JobStage | string, settings: Record<string, unknown>): JobStage | "moderation" | "ready" | null {
  const mix = (settings.mix ?? {}) as { ai?: number; canvas?: number; pinora?: number; photos?: number };
  const hasAi = (mix.ai ?? 0) > 0 || (mix.pinora ?? 0) > 0;
  const hasCanvas = (mix.canvas ?? 0) > 0;
  switch (stage) {
    case "meta": return "photos";
    case "photos": return "plan";
    case "plan": return hasAi ? "prompts" : hasCanvas ? "canvas" : "moderation";
    case "prompts": return "images";
    case "images": return hasCanvas ? "canvas" : "moderation";
    case "canvas": return "moderation";
    case "texts": return "upload";
    case "upload": return "schedule";
    case "schedule": return "ready";
    // Пошаговый режим или «Стоп» на текстах оставляют stage = moderation: дальше идут тексты.
    case "moderation": return "texts";
    default: return null;
  }
}
