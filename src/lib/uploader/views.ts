/** Выборки для экранов инструмента: «Сегодня», запуск, сопоставление, агенты. Без next/* — пригодны и для API. */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { TZ } from "@/lib/pins/runs/stats";
import { todayKey } from "@/lib/pins/schedule/math";
import { previewDay } from "./csv";
import { visiblePinSites } from "./sites";
import { ERROR_LABELS, parseAgentSettings, parseSchedule, type ErrorKind, type TaskResult } from "./types";

export type TodayRow = {
  site: { id: string; name: string; accessId: string | null };
  file: { fileName: string; count: number; issues: number } | null;
  account: { profileId: string | null; profileName: string | null; status: string; pausedUntil: Date | null; lastUploadAt: Date | null; lastError: string | null; pinUsername: string | null } | null;
  uploaded: { at: Date; source: string; note: string | null } | null;
  lastTask: { id: string; runId: string; status: string; errorKind: string | null; error: string | null; finishedAt: Date | null } | null;
};

/** Таблица «Сегодня»: сайты с файлом на день, их профиль, состояние аккаунта, отметка заливки, последняя попытка. */
export async function todayRows(me: CurrentUser, day = todayKey(new Date(), TZ)): Promise<TodayRow[]> {
  const sites = await visiblePinSites(me);
  const ids = sites.map((s) => s.id);
  const [accounts, uploads, tasks] = await Promise.all([
    prisma.uplAccount.findMany({ where: { pinSiteId: { in: ids } } }),
    prisma.prjUpload.findMany({ where: { pinSiteId: { in: ids }, day } }),
    prisma.uplTask.findMany({ where: { pinSiteId: { in: ids }, day, phase: "upload" }, orderBy: { updatedAt: "desc" }, select: { id: true, runId: true, pinSiteId: true, status: true, errorKind: true, error: true, finishedAt: true } }),
  ]);
  const accBy = new Map(accounts.map((a) => [a.pinSiteId, a]));
  const upBy = new Map(uploads.map((u) => [u.pinSiteId, u]));
  const taskBy = new Map<string, (typeof tasks)[number]>();
  for (const t of tasks) if (!taskBy.has(t.pinSiteId)) taskBy.set(t.pinSiteId, t);
  const now = new Date();
  const out: TodayRow[] = [];
  for (const s of sites) {
    const file = await previewDay(s.id, s.name, day, now);
    const a = accBy.get(s.id);
    const u = upBy.get(s.id);
    const t = taskBy.get(s.id);
    out.push({
      site: { id: s.id, name: s.name, accessId: s.wpConnectionId },
      file,
      account: a ? { profileId: a.profileId, profileName: a.profileName, status: a.status, pausedUntil: a.pausedUntil, lastUploadAt: a.lastUploadAt, lastError: a.lastError, pinUsername: a.pinUsername } : null,
      uploaded: u ? { at: u.uploadedAt, source: u.source, note: u.note } : null,
      lastTask: t ? { id: t.id, runId: t.runId, status: t.status, errorKind: t.errorKind, error: t.error, finishedAt: t.finishedAt } : null,
    });
  }
  return out;
}

export type AgentRow = {
  id: string; name: string; userId: string; userName: string; status: string; state: string | null; lastSeenAt: Date | null; version: string | null;
  hostInfo: Record<string, unknown> | null; settings: { parallel: number }; schedule: { enabled: boolean; time: string; tz: string }; tokenHint: string; createdAt: Date;
};

/** Агенты: свои (админ — все), с именами владельцев. */
export async function agentRows(me: CurrentUser): Promise<AgentRow[]> {
  const agents = await prisma.uplAgent.findMany({ where: { revokedAt: null, ...(me.role === "ADMIN" ? {} : { userId: me.id }) }, orderBy: { createdAt: "desc" } });
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(agents.map((a) => a.userId))] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email]));
  return agents.map((a) => ({
    id: a.id, name: a.name, userId: a.userId, userName: users.get(a.userId) ?? "сотрудник", status: a.status, state: a.state, lastSeenAt: a.lastSeenAt, version: a.version,
    hostInfo: (a.hostInfo as Record<string, unknown> | null) ?? null, settings: parseAgentSettings(a.settings), schedule: parseSchedule(a.schedule), tokenHint: a.tokenHint, createdAt: a.createdAt,
  }));
}

export type TaskView = {
  id: string; phase: string; status: string; order: number; siteId: string; siteName: string; profileId: string; profileName: string | null; day: string;
  fileName: string | null; rows: number | null; step: string | null; attempts: number; errorKind: string | null; errorLabel: string | null; error: string | null;
  result: TaskResult | null; startedAt: Date | null; finishedAt: Date | null;
};
export type RunView = {
  id: string; status: string; phase: string; source: string; day: string; parallel: number; total: number; done: number; failed: number; skipped: number;
  stopRequested: boolean; error: string | null; verifyAt: Date | null; verifyAttempts: number; startedAt: Date | null; finishedAt: Date | null; createdAt: Date;
  agent: { id: string; name: string; status: string; state: string | null };
  tasks: TaskView[];
};

/** Карточка запуска с заданиями (страница и API опроса). */
export async function runView(runId: string): Promise<RunView | null> {
  const run = await prisma.uplRun.findUnique({ where: { id: runId }, include: { agent: { select: { id: true, name: true, status: true, state: true } }, tasks: { orderBy: { order: "asc" } } } });
  if (!run) return null;
  const siteIds = [...new Set(run.tasks.map((t) => t.pinSiteId))];
  const [sites, accounts] = await Promise.all([
    prisma.pinSite.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } }),
    prisma.uplAccount.findMany({ where: { pinSiteId: { in: siteIds } }, select: { pinSiteId: true, profileName: true } }),
  ]);
  const nameBy = new Map(sites.map((s) => [s.id, s.name]));
  const profBy = new Map(accounts.map((a) => [a.pinSiteId, a.profileName]));
  return {
    id: run.id, status: run.status, phase: run.phase, source: run.source, day: run.day, parallel: run.parallel, total: run.total, done: run.done, failed: run.failed, skipped: run.skipped,
    stopRequested: run.stopRequested, error: run.error, verifyAt: run.verifyAt, verifyAttempts: run.verifyAttempts, startedAt: run.startedAt, finishedAt: run.finishedAt, createdAt: run.createdAt,
    agent: run.agent,
    tasks: run.tasks.map((t) => ({
      id: t.id, phase: t.phase, status: t.status, order: t.order, siteId: t.pinSiteId, siteName: nameBy.get(t.pinSiteId) ?? "сайт", profileId: t.profileId, profileName: profBy.get(t.pinSiteId) ?? null, day: t.day,
      fileName: t.fileName, rows: t.rows, step: t.step, attempts: t.attempts, errorKind: t.errorKind, errorLabel: t.errorKind ? ERROR_LABELS[t.errorKind as ErrorKind] ?? null : null, error: t.error,
      result: (t.result as TaskResult | null) ?? null, startedAt: t.startedAt, finishedAt: t.finishedAt,
    })),
  };
}

/** Список запусков (свои агенты или все для админа). */
export async function runRows(me: CurrentUser, take = 50) {
  return prisma.uplRun.findMany({
    where: me.role === "ADMIN" ? {} : { OR: [{ userId: me.id }, { agent: { userId: me.id } }] },
    orderBy: { createdAt: "desc" }, take,
    include: { agent: { select: { id: true, name: true } } },
  });
}
