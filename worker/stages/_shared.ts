import { prisma } from "@/lib/db";
import type { PinRun, PinRunItem, PinRunPage, PinSite } from "@prisma/client";
import { mergeRecipe, type Recipe, type RunSettings } from "@/lib/pins/types";
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import type { StageCtx } from "./index";

/** Контекст прогона для этапов: сайт, рецепт (снимок из прогона), страницы. */
export type RunCtx = {
  run: PinRun;
  site: PinSite;
  recipe: Recipe;
  settings: RunSettings;
  pages: PinRunPage[];
  pageById: Map<string, PinRunPage>;
  ai: { userId: string; teamId: string; runId: string; siteId: string; signal: AbortSignal };
};

export async function loadRunCtx(ctx: StageCtx): Promise<RunCtx> {
  const run = ctx.run;
  if (!run.siteId) throw new Error("У прогона нет сайта");
  const site = await prisma.pinSite.findUniqueOrThrow({ where: { id: run.siteId } });
  const settings = run.settings as unknown as RunSettings;
  const recipe = mergeRecipe(settings);
  const pages = await prisma.pinRunPage.findMany({ where: { runId: run.id }, orderBy: { sortOrder: "asc" } });
  const userId = run.createdById ?? "";
  if (!userId) throw new Error("У прогона не указан пользователь: некому выбрать ключи ИИ");
  return {
    run, site, recipe, settings, pages,
    pageById: new Map(pages.map((p) => [p.id, p])),
    ai: { userId, teamId: run.teamId, runId: run.id, siteId: site.id, signal: ctx.signal },
  };
}

/** Параллельная очередь с ограничением и остановкой по сигналу. */
export async function runQueue<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (i < items.length) {
      if (signal?.aborted) return;
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type ItemOutcome = { retry: number; fatal?: string };

/**
 * Единая обработка ошибки элемента: временная — отложить с backoff,
 * постоянная — пометить ERROR, фатальная — вернуть причину для блокировки прогона.
 */
export async function failItem(item: Pick<PinRunItem, "id" | "attempts">, stage: string, e: unknown, acc: ItemOutcome): Promise<void> {
  const err = e instanceof Error ? e : new Error(String(e));
  // Остановка пользователем — не ошибка элемента: пробрасываем, задачу закроет runner как STOPPED.
  if (err.name === "StopRequested") throw err;
  const httpStatus = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 0;
  const cls = e instanceof AiError
    ? e.cls
    : httpStatus === 401 || httpStatus === 403
      ? { kind: "fatal_run" as const, code: "auth", message: `WordPress отклонил доступ: ${err.message}` }
      : { kind: (httpStatus === 429 || httpStatus >= 500 || /timeout|fetch failed|ECONNRESET|ETIMEDOUT|network|aborted|отменено|не ответил|перегружен/i.test(err.message) ? "transient" : "permanent") as "transient" | "permanent", code: "error", message: err.message };
  if (cls.kind === "fatal_run") {
    acc.fatal = acc.fatal ?? cls.message;
    await prisma.pinRunItem.update({ where: { id: item.id }, data: { error: cls.message.slice(0, 2000), errorStage: stage, errorKind: cls.code } });
    return;
  }
  const attempts = item.attempts + 1;
  if (cls.kind === "transient" && attempts < 5) {
    acc.retry++;
    await prisma.pinRunItem.update({ where: { id: item.id }, data: { attempts, nextRetryAt: new Date(Date.now() + backoffMs(attempts)), error: cls.message.slice(0, 2000), errorStage: stage, errorKind: cls.code } });
    return;
  }
  await prisma.pinRunItem.update({ where: { id: item.id }, data: { attempts, status: "ERROR", error: cls.message.slice(0, 2000), errorStage: stage, errorKind: cls.kind === "transient" ? "permanent_after_retries" : cls.code } });
}

/** Элемент успешно прошёл этап: сброс счётчиков ошибок. */
export const okPatch = { attempts: 0, nextRetryAt: null, error: null, errorStage: null, errorKind: null } as const;

export const notRetryYet = (now = new Date()) => ({ OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] });
