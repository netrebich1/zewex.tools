import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { PinRunStatus } from "@prisma/client";
import { PIN_STAGES, type PinStage } from "../types";

/** Счётчики по типу пина, одним запросом GROUP BY (без выгрузки элементов). */
export type KindCounters = {
  engine: string;
  planned: number;
  withPrompt: number;
  withImage: number;
  approved: number;
  rejected: number;
  withText: number;
  uploaded: number;
  scheduled: number;
  errors: number;
};

export type RunStatusView = {
  run: { id: string; name: string; status: PinRunStatus; stage: string; blockedReason: string | null; costUsd: number; stopRequested: boolean; updatedAt: string; stepByStep: boolean };
  job: { stage: string; status: string; done: number; total: number; label: string; error: string | null } | null;
  counters: KindCounters[];
  total: KindCounters;
  pages: { total: number; withKeyword: number; errors: number };
  problems: Array<{ stage: string; kind: string; message: string; count: number }>;
  stages: Array<{ key: PinStage; state: "done" | "active" | "waiting" | "problem" | "todo" }>;
};

type Row = { engine: string; planned: bigint; withPrompt: bigint; withImage: bigint; approved: bigint; rejected: bigint; withText: bigint; uploaded: bigint; scheduled: bigint; errors: bigint };
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

export async function runStatus(runId: string): Promise<RunStatusView | null> {
  const run = await prisma.pinRun.findUnique({ where: { id: runId } });
  if (!run) return null;
  const [rows, job, pagesAgg, pagesKw, pagesErr, problemRows, cost] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      SELECT engine,
        CAST(SUM(status NOT IN ('POOL','REMOVED')) AS SIGNED) AS planned,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND prompt <> '') AS SIGNED) AS withPrompt,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND (imagePath <> '' OR (engine = 'PHOTO' AND sourceImageUrl <> ''))) AS SIGNED) AS withImage,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND moderation = 'APPROVED') AS SIGNED) AS approved,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND moderation = 'REJECTED') AS SIGNED) AS rejected,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND title <> '' AND description <> '' AND altText <> '') AS SIGNED) AS withText,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND wpMediaUrl <> '') AS SIGNED) AS uploaded,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND scheduledAt IS NOT NULL) AS SIGNED) AS scheduled,
        CAST(SUM(status = 'ERROR') AS SIGNED) AS errors
      FROM PinRunItem WHERE runId = ${runId} GROUP BY engine`,
    prisma.pinJob.findFirst({ where: { runId }, orderBy: { createdAt: "desc" } }),
    prisma.pinRunPage.count({ where: { runId } }),
    prisma.pinRunPage.count({ where: { runId, keyword: { not: "" } } }),
    prisma.pinRunPage.count({ where: { runId, status: "error" } }),
    prisma.$queryRaw<Array<{ errorStage: string | null; errorKind: string | null; error: string | null; cnt: bigint }>>`
      SELECT errorStage, errorKind, SUBSTRING(error, 1, 160) AS error, COUNT(*) AS cnt
      FROM PinRunItem WHERE runId = ${runId} AND status = 'ERROR'
      GROUP BY errorStage, errorKind, SUBSTRING(error, 1, 160) ORDER BY cnt DESC LIMIT 10`,
    // расход прогона — по журналу портала (воркер дублирует сумму в PinRun.costUsd после каждой задачи)
    prisma.usageLog.aggregate({ _sum: { costUsd: true }, where: { refId: runId } }),
  ]);
  const counters: KindCounters[] = rows.map((r) => ({
    engine: r.engine, planned: n(r.planned), withPrompt: n(r.withPrompt), withImage: n(r.withImage), approved: n(r.approved), rejected: n(r.rejected), withText: n(r.withText), uploaded: n(r.uploaded), scheduled: n(r.scheduled), errors: n(r.errors),
  }));
  const total = counters.reduce<KindCounters>((a, c) => ({
    engine: "ALL", planned: a.planned + c.planned, withPrompt: a.withPrompt + c.withPrompt, withImage: a.withImage + c.withImage, approved: a.approved + c.approved, rejected: a.rejected + c.rejected, withText: a.withText + c.withText, uploaded: a.uploaded + c.uploaded, scheduled: a.scheduled + c.scheduled, errors: a.errors + c.errors,
  }), { engine: "ALL", planned: 0, withPrompt: 0, withImage: 0, approved: 0, rejected: 0, withText: 0, uploaded: 0, scheduled: 0, errors: 0 });

  const stageIdx = PIN_STAGES.indexOf((PIN_STAGES as readonly string[]).includes(run.stage) ? (run.stage as PinStage) : "pages");
  const activeStage = job && (job.status === "RUNNING" || job.status === "PENDING" || job.status === "STOPPING") ? job.stage : null;
  const stages = PIN_STAGES.map((key, i) => {
    let state: "done" | "active" | "waiting" | "problem" | "todo" = i <= stageIdx ? "done" : "todo";
    if (activeStage === key) state = "active";
    if (key === "moderation" && run.status === "WAITING_MODERATION") state = "waiting";
    if (run.status === "BLOCKED" && (activeStage === key || (job?.stage === key && job.status === "ERROR"))) state = "problem";
    return { key, state };
  });

  return {
    run: { id: run.id, name: run.name, status: run.status, stage: run.stage, blockedReason: run.blockedReason, costUsd: cost._sum.costUsd ?? run.costUsd, stopRequested: run.stopRequested, updatedAt: run.updatedAt.toISOString(), stepByStep: run.stepByStep },
    job: job ? { stage: job.stage, status: job.status, done: job.done, total: job.total, label: job.label, error: job.error } : null,
    counters,
    total,
    pages: { total: pagesAgg, withKeyword: pagesKw, errors: pagesErr },
    problems: problemRows.map((p) => ({ stage: p.errorStage ?? "", kind: p.errorKind ?? "", message: p.error ?? "", count: n(p.cnt) })),
    stages,
  };
}

/** Карточка прогона для доски на «Сегодня»: статус, этапы, прогресс задачи, проблемы. */
export type RunOverview = {
  id: string; name: string; siteName: string; status: PinRunStatus; stage: string; stepByStep: boolean; blockedReason: string | null;
  updatedAt: string; createdAt: string; costUsd: number;
  job: { stage: string; status: string; done: number; total: number; label: string } | null;
  stages: RunStatusView["stages"];
  pages: number; pins: number; errors: number; pendingModeration: number;
  topProblem: string | null;
};

export async function runsOverview(where: Prisma.PinRunWhereInput, limit = 20): Promise<RunOverview[]> {
  const runs = await prisma.pinRun.findMany({
    where: { ...where, NOT: { name: { startsWith: "__" } } },
    orderBy: { updatedAt: "desc" }, take: limit,
    include: { site: { select: { name: true } } },
  });
  const out: RunOverview[] = [];
  for (const run of runs) {
    const [view, pendingModeration] = await Promise.all([
      runStatus(run.id),
      prisma.pinRunItem.count({ where: { runId: run.id, status: "READY", moderation: "NONE", kind: "pin" } }),
    ]);
    if (!view) continue;
    out.push({
      id: run.id, name: run.name, siteName: run.site?.name ?? "—", status: run.status, stage: run.stage, stepByStep: run.stepByStep, blockedReason: run.blockedReason,
      updatedAt: run.updatedAt.toISOString(), createdAt: run.createdAt.toISOString(), costUsd: view.run.costUsd,
      job: view.job ? { stage: view.job.stage, status: view.job.status, done: view.job.done, total: view.job.total, label: view.job.label } : null,
      stages: view.stages,
      pages: view.pages.total, pins: view.total.planned, errors: view.total.errors, pendingModeration,
      topProblem: view.problems[0]?.message ?? null,
    });
  }
  return out;
}
