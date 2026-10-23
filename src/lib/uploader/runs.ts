/**
 * Запуски заливки: создание пачки заданий по сайтам, остановка, повтор, переход в фазу проверки,
 * расписание и сторож (крон воркера — uploaderTick).
 */
import { Prisma, type UplRun, type UplTask } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { eventText, logEventByPinSite } from "@/lib/projects/events";
import { TZ } from "@/lib/pins/runs/stats";
import { todayKey } from "@/lib/pins/schedule/math";
import { previewDay } from "./csv";
import { userAsCurrent, visiblePinSites } from "./sites";
import { ERROR_LABELS, LEASE_SEC, MAX_ATTEMPTS, OFFLINE_SEC, parseAgentSettings, parseSchedule, type ErrorKind, type TaskResult, type VerifyResult } from "./types";

export type CreateRunInput = { agentId: string; day: string; siteIds: string[]; parallel?: number; source?: "manual" | "schedule"; force?: boolean; userId?: string | null };
export type CreateRunResult = { runId: string | null; queued: number; skipped: Array<{ siteName: string; reason: string }> };

/** Настройки инструмента (одна строка). */
export async function uplSettings() {
  return prisma.uplSettings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
}

/**
 * Запуск: по заданию на каждый сайт с файлом на день. Сайт пропускается (и остаётся в списке как «пропущен»), если
 * профиль не сопоставлен, аккаунт не в работе, файл пуст или день уже отмечен залитым (без force).
 */
export async function createRun(me: CurrentUser, input: CreateRunInput): Promise<CreateRunResult> {
  const agent = await prisma.uplAgent.findUnique({ where: { id: input.agentId } });
  if (!agent || agent.revokedAt) throw new Error("Агент не найден");
  if (me.role !== "ADMIN" && agent.userId !== me.id) throw new Error("Это не ваш агент");
  const sites = (await visiblePinSites(me)).filter((s) => input.siteIds.includes(s.id));
  if (!sites.length) throw new Error("Не выбран ни один сайт");
  const now = new Date();
  const [accounts, uploads] = await Promise.all([
    prisma.uplAccount.findMany({ where: { pinSiteId: { in: sites.map((s) => s.id) } } }),
    prisma.prjUpload.findMany({ where: { pinSiteId: { in: sites.map((s) => s.id) }, day: input.day }, select: { pinSiteId: true } }),
  ]);
  const accBy = new Map(accounts.map((a) => [a.pinSiteId, a]));
  const uploaded = new Set(uploads.map((u) => u.pinSiteId));
  const skipped: CreateRunResult["skipped"] = [];
  const tasks: Prisma.UplTaskCreateManyRunInput[] = [];
  let order = 0;
  for (const s of sites) {
    const acc = accBy.get(s.id);
    const skip = (reason: string, errorKind: ErrorKind | null = null) => {
      skipped.push({ siteName: s.name, reason });
      tasks.push({ pinSiteId: s.id, profileId: acc?.profileId ?? "", day: input.day, phase: "upload", steps: [{ kind: "upload_csv" }], status: "SKIPPED", order: order++, error: reason.slice(0, 255), errorKind, finishedAt: now });
    };
    if (!acc?.profileId) { skip("профиль Dolphin не сопоставлен", "profile_not_found"); continue; }
    if (acc.status === "needs_login") { skip(ERROR_LABELS.not_logged_in, "not_logged_in"); continue; }
    if (acc.status === "off" || acc.status === "banned") { skip(`аккаунт: ${acc.status === "off" ? "выключен" : "заблокирован"}`); continue; }
    if ((acc.status === "paused" || acc.status === "limited") && acc.pausedUntil && acc.pausedUntil > now) { skip(`аккаунт на паузе до ${acc.pausedUntil.toLocaleString("ru-RU", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`, "rate_limited"); continue; }
    if (!input.force && uploaded.has(s.id)) { skip("уже отмечено залитым за этот день"); continue; }
    const open = await prisma.uplTask.findFirst({ where: { pinSiteId: s.id, day: input.day, phase: "upload", status: { in: ["QUEUED", "LEASED"] } }, select: { id: true } });
    if (open) { skip("уже в очереди другого запуска"); continue; }
    const preview = await previewDay(s.id, s.name, input.day, now);
    if (!preview) { skip(ERROR_LABELS.no_file, "no_file"); continue; }
    tasks.push({ pinSiteId: s.id, profileId: acc.profileId, day: input.day, phase: "upload", steps: [{ kind: "upload_csv" }], status: "QUEUED", order: order++, fileName: preview.fileName, rows: preview.count });
  }
  const queued = tasks.filter((t) => t.status === "QUEUED").length;
  if (!queued) return { runId: null, queued: 0, skipped };
  const parallel = Math.max(1, Math.min(5, input.parallel ?? parseAgentSettings(agent.settings).parallel));
  const run = await prisma.uplRun.create({
    data: { agentId: agent.id, userId: input.userId === undefined ? me.id : input.userId, source: input.source ?? "manual", day: input.day, parallel, total: queued, skipped: skipped.length, tasks: { createMany: { data: tasks } } },
    select: { id: true },
  });
  return { runId: run.id, queued, skipped };
}

/** Остановить: ждущие задания — «пропущено», занятые агент сам завершит сбоем «остановлено». */
export async function stopRun(runId: string): Promise<void> {
  const run = await prisma.uplRun.findUnique({ where: { id: runId }, select: { status: true } });
  if (!run || !["QUEUED", "RUNNING", "VERIFY_WAIT", "VERIFYING"].includes(run.status)) return;
  await prisma.uplTask.updateMany({ where: { runId, status: "QUEUED" }, data: { status: "SKIPPED", errorKind: "stopped", error: "остановлено", finishedAt: new Date() } });
  await prisma.uplRun.update({ where: { id: runId }, data: { stopRequested: true } });
  await settleRun(runId);
}

/** Повторить неудачные и пропущенные из-за временных причин задания запуска (новая попытка в том же запуске). */
export async function retryFailed(runId: string): Promise<number> {
  const run = await prisma.uplRun.findUnique({ where: { id: runId } });
  if (!run) return 0;
  const r = await prisma.uplTask.updateMany({
    where: { runId, phase: "upload", status: { in: ["FAILED", "SKIPPED"] }, profileId: { not: "" }, errorKind: { notIn: ["no_file"] } },
    data: { status: "QUEUED", attempts: 0, leaseUntil: null, error: null, errorKind: null, step: null, finishedAt: null },
  });
  if (r.count) await prisma.uplRun.update({ where: { id: runId }, data: { status: "QUEUED", phase: "upload", stopRequested: false, finishedAt: null, error: null, total: { increment: 0 } } });
  return r.count;
}

/** Счётчики запуска из заданий фазы upload. */
async function counters(runId: string) {
  const g = await prisma.uplTask.groupBy({ by: ["status"], where: { runId, phase: "upload" }, _count: { _all: true } });
  const n = (s: string) => g.find((x) => x.status === s)?._count._all ?? 0;
  return { done: n("DONE"), failed: n("FAILED"), skipped: n("SKIPPED"), open: n("QUEUED") + n("LEASED"), total: g.reduce((a, x) => a + x._count._all, 0) - n("SKIPPED") };
}

/**
 * После закрытия любого задания: пересчёт счётчиков и переходы фаз.
 * upload: все закрыты → есть успешные → VERIFY_WAIT (через verifyDelayMin), иначе FAILED/STOPPED/DONE.
 * verify: все закрыты → где-то ещё «обрабатывается» и попытки остались → VERIFY_WAIT (через verifyRetryMin), иначе DONE.
 */
export async function settleRun(runId: string): Promise<void> {
  const run = await prisma.uplRun.findUnique({ where: { id: runId } });
  if (!run) return;
  const c = await counters(runId);
  const base = { done: c.done, failed: c.failed, skipped: c.skipped, total: c.total };
  if (run.phase === "upload") {
    if (c.open > 0) {
      await prisma.uplRun.update({ where: { id: runId }, data: { ...base, status: run.stopRequested ? run.status : "RUNNING" } });
      return;
    }
    if (run.stopRequested) { await prisma.uplRun.update({ where: { id: runId }, data: { ...base, status: "STOPPED", finishedAt: new Date() } }); return; }
    if (c.done === 0) { await prisma.uplRun.update({ where: { id: runId }, data: { ...base, status: c.failed ? "FAILED" : "DONE", finishedAt: new Date(), error: c.failed ? "ни один файл не загружен" : null } }); return; }
    const s = await uplSettings();
    await prisma.uplRun.update({ where: { id: runId }, data: { ...base, status: "VERIFY_WAIT", verifyAt: new Date(Date.now() + s.verifyDelayMin * 60_000) } });
    return;
  }
  // verify
  const open = await prisma.uplTask.count({ where: { runId, phase: "verify", status: { in: ["QUEUED", "LEASED"] } } });
  if (open > 0) { await prisma.uplRun.update({ where: { id: runId }, data: { ...base, status: run.stopRequested ? run.status : "VERIFYING" } }); return; }
  if (run.stopRequested) { await prisma.uplRun.update({ where: { id: runId }, data: { ...base, status: "STOPPED", finishedAt: new Date() } }); return; }
  const s = await uplSettings();
  const uploads = await prisma.uplTask.findMany({ where: { runId, phase: "upload", status: "DONE" }, select: { result: true } });
  const pending = uploads.some((t) => { const v = (t.result as TaskResult | null)?.verify; return !v || v.processing; });
  if (pending && run.verifyAttempts < s.verifyRetries) {
    await prisma.uplRun.update({ where: { id: runId }, data: { ...base, status: "VERIFY_WAIT", verifyAt: new Date(Date.now() + s.verifyRetryMin * 60_000) } });
    return;
  }
  await prisma.uplRun.update({ where: { id: runId }, data: { ...base, status: c.failed && !c.done ? "FAILED" : "DONE", finishedAt: new Date() } });
}

/** Фаза проверки: по заданию check_history на каждый успешно залитый профиль. */
async function startVerify(run: UplRun): Promise<void> {
  const uploads = await prisma.uplTask.findMany({ where: { runId: run.id, phase: "upload", status: "DONE" }, orderBy: { order: "asc" } });
  const todo = uploads.filter((t) => { const v = (t.result as TaskResult | null)?.verify; return !v || v.processing; });
  if (!todo.length) { await prisma.uplRun.update({ where: { id: run.id }, data: { status: "DONE", phase: "verify", finishedAt: new Date() } }); return; }
  await prisma.$transaction([
    prisma.uplTask.createMany({ data: todo.map((t, i) => ({ runId: run.id, pinSiteId: t.pinSiteId, profileId: t.profileId, day: t.day, phase: "verify", steps: [{ kind: "check_history" }], status: "QUEUED", order: 1000 * (run.verifyAttempts + 1) + i, fileName: t.fileName, rows: t.rows })) }),
    prisma.uplRun.update({ where: { id: run.id }, data: { status: "VERIFYING", phase: "verify", verifyAt: null, verifyAttempts: { increment: 1 } } }),
  ]);
}

/** Результат проверки — в исходное задание заливки, в отметку CRM и в ленту проекта. */
export async function applyVerify(task: UplTask, v: VerifyResult): Promise<void> {
  const upload = await prisma.uplTask.findFirst({ where: { runId: task.runId, pinSiteId: task.pinSiteId, day: task.day, phase: "upload", status: "DONE" } });
  if (upload) {
    const prev = (upload.result as TaskResult | null) ?? {};
    await prisma.uplTask.update({ where: { id: upload.id }, data: { result: { ...prev, verify: { ...v, checkedAt: new Date().toISOString() } } as Prisma.InputJsonValue } });
  }
  const note = v.processing ? "проверка: Pinterest ещё обрабатывает" : v.published == null ? "проверка: статус не прочитан" : `проверка: опубликовано ${v.published}${v.failed ? `, ошибок ${v.failed}` : ""}`;
  await prisma.prjUpload.updateMany({ where: { pinSiteId: task.pinSiteId, day: task.day }, data: { note } });
  await prisma.uplAccount.updateMany({ where: { pinSiteId: task.pinSiteId }, data: { lastCheckAt: new Date() } });
  if (!v.processing) void logEventByPinSite(task.pinSiteId, { kind: "export_verified", refId: `${task.pinSiteId}|${task.day}`, summary: eventText.exportVerified(task.day, v.published, v.failed), payload: { published: v.published, failed: v.failed } });
}

/** Локальное время агента «HH:MM» и день «YYYY-MM-DD» в его поясе. */
function localNow(tz: string, now = new Date()): { time: string; day: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    return { time: `${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`, day: `${g("year")}-${g("month")}-${g("day")}` };
  } catch {
    return localNow("Europe/Kyiv", now);
  }
}

/**
 * Сторож и расписание (крон воркера, раз в минуту): агенты офлайн, просроченные аренды — в очередь,
 * VERIFY_WAIT → задания проверки, расписание агентов → запуск на сегодня.
 */
export async function uploaderTick(now = new Date()): Promise<{ stale: number; verify: number; scheduled: number }> {
  await prisma.uplAgent.updateMany({ where: { status: { not: "offline" }, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(now.getTime() - OFFLINE_SEC * 1000) } }] }, data: { status: "offline", state: "не на связи" } });

  // Просроченная аренда: агент пропал посреди задания — ещё попытка, после MAX_ATTEMPTS — ошибка.
  const stale = await prisma.uplTask.findMany({ where: { status: "LEASED", leaseUntil: { lt: now } }, select: { id: true, runId: true, attempts: true } });
  for (const t of stale) {
    const failed = t.attempts >= MAX_ATTEMPTS;
    await prisma.uplTask.update({ where: { id: t.id }, data: failed ? { status: "FAILED", leaseUntil: null, errorKind: "network", error: "агент не ответил — аренда задания истекла", finishedAt: now } : { status: "QUEUED", leaseUntil: null, step: null } });
    if (failed) await settleRun(t.runId);
  }

  const waiting = await prisma.uplRun.findMany({ where: { status: "VERIFY_WAIT", verifyAt: { lte: now }, stopRequested: false } });
  for (const run of waiting) await startVerify(run);

  let scheduled = 0;
  const agents = await prisma.uplAgent.findMany({ where: { revokedAt: null, status: { not: "offline" } } });
  for (const a of agents) {
    const sch = parseSchedule(a.schedule);
    if (!sch.enabled) continue;
    const { time, day } = localNow(sch.tz, now);
    if (time < sch.time || a.lastScheduledDay === day) continue;
    const me = await userAsCurrent(a.userId);
    if (!me) continue;
    await prisma.uplAgent.update({ where: { id: a.id }, data: { lastScheduledDay: day } });
    const sites = await visiblePinSites(me);
    const mapped = await prisma.uplAccount.findMany({ where: { pinSiteId: { in: sites.map((s) => s.id) }, profileId: { not: null } }, select: { pinSiteId: true } });
    if (!mapped.length) continue;
    try {
      const r = await createRun(me, { agentId: a.id, day: todayKey(now, TZ), siteIds: mapped.map((m) => m.pinSiteId), source: "schedule", userId: null });
      if (r.runId) scheduled++;
    } catch { /* нет сайтов с файлами — просто день отмечен */ }
  }
  return { stale: stale.length, verify: waiting.length, scheduled };
}

export const leaseUntil = (now = new Date()) => new Date(now.getTime() + LEASE_SEC * 1000);
