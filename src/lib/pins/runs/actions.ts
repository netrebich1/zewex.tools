import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { enqueueJob, requestStop, activeJob, JobConflict } from "../jobs";
import { mergeRecipe, type JobStage, type ModerationMode, type Recipe, type RunSettings } from "../types";
import { hash32 } from "../plan/seed";
import { removePath, runDir } from "../storage";
import { nextStageAfter } from "./stages";
import { autoModerate, pendingModeration } from "./moderation";

/** Пользователь работает только с сайтами своих команд (админ — со всеми). */
export function canAccessTeam(me: CurrentUser, teamId: string): boolean {
  return me.role === "ADMIN" || me.teamIds.includes(teamId);
}

export async function getRunForUser(me: CurrentUser, runId: string) {
  const run = await prisma.pinRun.findUnique({ where: { id: runId }, include: { site: true } });
  if (!run || !canAccessTeam(me, run.teamId)) return null;
  return run;
}

export function parseUrls(text: string): { urls: string[]; invalid: string[]; duplicates: number } {
  const seen = new Set<string>();
  const urls: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const raw of text.split(/\r?\n|,|\s+/)) {
    const s = raw.trim();
    if (!s) continue;
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      invalid.push(s);
      continue;
    }
    u.hash = "";
    const norm = u.toString();
    if (seen.has(norm)) {
      duplicates++;
      continue;
    }
    seen.add(norm);
    urls.push(norm);
  }
  return { urls, invalid, duplicates };
}

export type CreateRunInput = {
  siteId: string;
  urls: string[];
  name?: string;
  moderationMode?: ModerationMode;
  stepByStep?: boolean;
  includeUsed?: boolean;
  /** Настройки этого прогона (по умолчанию — рецепт сайта). */
  recipe?: Recipe;
};

/**
 * Создаёт прогон: снимок рецепта сайта, страницы, история ссылок, и ставит первую задачу (meta).
 * Защита от дублей: если у сайта есть незавершённый прогон с ≥50 % тех же ссылок — отказ с подсказкой.
 */
export async function createRun(me: CurrentUser, input: CreateRunInput): Promise<{ runId: string; warnings: string[] }> {
  const site = await prisma.pinSite.findUnique({ where: { id: input.siteId } });
  if (!site || !canAccessTeam(me, site.teamId)) throw new Error("Сайт не найден");
  if (!input.urls.length) throw new Error("Добавьте хотя бы одну ссылку");
  if (input.urls.length > 500) throw new Error("Не больше 500 ссылок за один прогон");
  const warnings: string[] = [];

  const recipe = mergeRecipe(input.recipe ?? site.recipe);
  if (input.moderationMode) recipe.schedule.moderationMode = input.moderationMode;
  const enabledKinds = Object.values(recipe.mix).filter((v) => v > 0).length;
  if (!enabledKinds) throw new Error("В рецепте сайта выключены все типы пинов");
  if (recipe.mix.ai > 0 && !recipe.sets.aiSetIds.length) throw new Error("В рецепте включены ИИ-пины, но не выбраны наборы стилей");

  const open = await prisma.pinRun.findMany({ where: { siteId: site.id, status: { notIn: ["DONE", "FAILED"] } }, select: { id: true, name: true, pages: { select: { url: true } } } });
  for (const r of open) {
    const set = new Set(r.pages.map((p) => p.url));
    const overlap = input.urls.filter((u) => set.has(u)).length;
    if (overlap && overlap / Math.max(set.size, input.urls.length) >= 0.5) {
      throw new Error(`У сайта уже есть незавершённый прогон «${r.name || r.id.slice(0, 8)}» с теми же ссылками (${overlap} совпадений). Откройте его и нажмите «Продолжить».`);
    }
  }
  if (!input.includeUsed) {
    const used = await prisma.pinUrlHistory.findMany({ where: { siteId: site.id, url: { in: input.urls } }, select: { url: true } });
    if (used.length) warnings.push(`${used.length} ссылок уже использовались на этом сайте раньше; они включены в прогон.`);
  }

  const seed = hash32(`${site.id}|${Date.now()}`);
  const settings: RunSettings = { ...recipe, siteName: site.name, siteSlug: site.slug, seed, launchedAt: new Date().toISOString() };
  const run = await prisma.$transaction(async (tx) => {
    const run = await tx.pinRun.create({
      data: {
        teamId: site.teamId, siteId: site.id, createdById: me.id,
        name: input.name?.trim() || `${site.name} · ${new Date().toLocaleDateString("ru-RU")} · ${input.urls.length} ссылок`,
        autopilot: true, stepByStep: !!input.stepByStep, status: "DRAFT", stage: "pages", settings,
      },
    });
    await tx.pinRunPage.createMany({ data: input.urls.map((url, i) => ({ runId: run.id, url, boards: [], sortOrder: i })) });
    await tx.pinUrlHistory.createMany({ data: input.urls.map((url) => ({ siteId: site.id, url, runId: run.id })) });
    return run;
  });
  await enqueueJob(run.id, "meta");
  return { runId: run.id, warnings };
}

/** «Продолжить»: следующий этап после последнего завершённого, или повтор заблокированного. */
export async function continueRun(me: CurrentUser, runId: string): Promise<string> {
  const run = await getRunForUser(me, runId);
  if (!run) throw new Error("Прогон не найден");
  const job = await activeJob(runId);
  if (job) throw new JobConflict("Задача уже выполняется");
  const lastJob = await prisma.pinJob.findFirst({ where: { runId }, orderBy: { createdAt: "desc" } });
  let stage: JobStage | null = null;
  if (run.status === "BLOCKED" || (lastJob && lastJob.status === "ERROR")) stage = (lastJob?.stage as JobStage) ?? "meta";
  else if (run.status === "WAITING_MODERATION") {
    const mode = mergeRecipe(run.settings).schedule.moderationMode;
    if (mode === "auto") await autoModerate(runId);
    const pending = await pendingModeration(runId);
    if (pending > 0) throw new Error(`Осталось промодерировать ${pending} пинов`);
    await prisma.pinRun.update({ where: { id: runId }, data: { moderatedAt: new Date() } });
    stage = "texts";
  } else if (run.stage === "pages") stage = "meta";
  else if (run.stage === "moderation") {
    // Модерация пройдена (пошаговый режим / «Стоп» на текстах) — продолжаем с текстов.
    const pending = await pendingModeration(runId);
    if (pending > 0) {
      await prisma.pinRun.update({ where: { id: runId }, data: { status: "WAITING_MODERATION" } });
      throw new Error(`Осталось промодерировать ${pending} пинов`);
    }
    stage = "texts";
  } else {
    const next = nextStageAfter(run.stage as JobStage, run.settings as Record<string, unknown>);
    if (next === "moderation") {
      await prisma.pinRun.update({ where: { id: runId }, data: { stage: "moderation", status: "WAITING_MODERATION" } });
      return "moderation";
    }
    if (next === "ready" || !next) {
      await prisma.pinRun.update({ where: { id: runId }, data: { stage: "ready", status: "DONE" } });
      return "ready";
    }
    stage = next;
  }
  if (!stage) throw new Error("Нечего продолжать");
  await prisma.pinRun.update({ where: { id: runId }, data: { blockedReason: null } });
  await enqueueJob(runId, stage);
  return stage;
}

/** «Доделать недостающее»: снять ERROR с элементов без картинки и прогнать промты → картинки. */
export async function redoMissing(me: CurrentUser, runId: string): Promise<number> {
  const run = await getRunForUser(me, runId);
  if (!run) throw new Error("Прогон не найден");
  if (await activeJob(runId)) throw new JobConflict("Задача уже выполняется");
  const reset = { attempts: 0, nextRetryAt: null, error: null, errorKind: null, errorStage: null };
  // Пины без картинки — заново в промты/картинки; пины с картинкой, упавшие на текстах/WP/расписании — снова READY.
  const r = await prisma.pinRunItem.updateMany({ where: { runId, status: "ERROR", imagePath: "", kind: "pin" }, data: { status: "PENDING", ...reset } });
  const r2 = await prisma.pinRunItem.updateMany({ where: { runId, status: "ERROR", OR: [{ imagePath: { not: "" } }, { kind: "photo" }] }, data: { status: "READY", ...reset } });
  await prisma.pinRun.update({ where: { id: runId }, data: { blockedReason: null } });
  const late = ["moderation", "texts", "upload", "schedule", "ready"].includes(run.stage);
  await enqueueJob(runId, late && r.count === 0 ? "texts" : "prompts");
  return r.count + r2.count;
}

/** «Пропустить сбойные»: отклонить элементы, у которых так и нет картинки. */
export async function skipFailed(me: CurrentUser, runId: string): Promise<number> {
  const run = await getRunForUser(me, runId);
  if (!run) throw new Error("Прогон не найден");
  const r = await prisma.pinRunItem.updateMany({ where: { runId, kind: "pin", imagePath: "", status: { in: ["ERROR", "PENDING"] }, moderation: { not: "REJECTED" } }, data: { moderation: "REJECTED", rejectReason: "skipped_no_image" } });
  return r.count;
}

export async function stopRun(me: CurrentUser, runId: string): Promise<boolean> {
  const run = await getRunForUser(me, runId);
  if (!run) throw new Error("Прогон не найден");
  return requestStop(runId);
}

export async function deleteRun(me: CurrentUser, runId: string): Promise<void> {
  const run = await getRunForUser(me, runId);
  if (!run) throw new Error("Прогон не найден");
  if (await activeJob(runId)) throw new Error("Сначала остановите прогон");
  await prisma.pinRun.delete({ where: { id: runId } });
  await removePath(runDir(runId)).catch(() => {});
}
