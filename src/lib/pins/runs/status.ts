import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import type { PinRunStatus } from "@prisma/client";
import { PIN_STAGES, type PinStage, type RunSettings } from "../types";
import { explainBlocked, explainItemError, explainPageErrors, explainSchedule, healthOf, type Health, type Problem, type ScheduleReport } from "./problems";

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
  run: { id: string; name: string; status: PinRunStatus; stage: string; blockedReason: string | null; costUsd: number; estimateUsd: number | null; stopRequested: boolean; updatedAt: string; stepByStep: boolean };
  job: { stage: string; status: string; done: number; total: number; label: string; error: string | null } | null;
  counters: KindCounters[];
  total: KindCounters;
  pages: { total: number; withKeyword: number; errors: number };
  /** Проблемы с объяснением: критичные (прогон стоит) первыми, затем предупреждения. */
  problems: Problem[];
  health: Health;
  stages: Array<{ key: PinStage; state: "done" | "active" | "waiting" | "problem" | "todo" }>;
};

type Row = { engine: string; planned: bigint; withPrompt: bigint; withImage: bigint; approved: bigint; rejected: bigint; withText: bigint; uploaded: bigint; scheduled: bigint; errors: bigint };
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

type JobRow = { stage: string; status: string; done: number; total: number; label: string; error: string | null };
type RunRow = { id: string; name: string; status: PinRunStatus; stage: string; blockedReason: string | null; costUsd: number; settings: unknown; stopRequested: boolean; updatedAt: Date; stepByStep: boolean };
type ProblemSqlRow = { errorStage: string | null; errorKind: string | null; error: string | null; cnt: bigint };

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
    // одна строка на вид ошибки и этап (тексты провайдера различаются номером запроса — берём образец)
    prisma.$queryRaw<ProblemSqlRow[]>`
      SELECT errorStage, errorKind, SUBSTRING(MAX(error), 1, 300) AS error, COUNT(*) AS cnt
      FROM PinRunItem WHERE runId = ${runId} AND status = 'ERROR'
      GROUP BY errorStage, errorKind ORDER BY cnt DESC LIMIT 10`,
    // расход прогона — по журналу портала (воркер дублирует сумму в PinRun.costUsd после каждой задачи)
    prisma.usageLog.aggregate({ _sum: { costUsd: true }, where: { refId: runId } }),
  ]);
  const view = buildView(run, rows, job, { total: pagesAgg, withKeyword: pagesKw, errors: pagesErr }, problemRows, cost._sum.costUsd);
  const problems = view.problems;
  // Блоговые статьи есть, а досок с пометкой [блог] у сайта нет — пины уйдут на общие доски; подсказываем завести.
  const blogPages = await prisma.pinRunPage.count({ where: { runId: run.id, articleKind: { notIn: ["", "ideas"] } } });
  const siteId = run.siteId;
  if (blogPages && siteId && !(await prisma.pinBoard.count({ where: { siteId, purpose: "blog" } }))) {
    problems.push({ severity: "warning", count: blogPages, stage: "meta", kind: "no_blog_boards", raw: "",
      title: `Блоговых статей: ${blogPages}, а досок для блога у сайта нет`,
      meaning: "Пины блоговых статей (как сделать, советы, чек-листы) ставятся на общие доски сайта вместе с подборками идей.",
      action: "Заведите в Pinterest доски под блог (например, «… Tips & Guides») и допишите их в настройках сайта с пометкой [блог]. Для уже размеченных статей доски не поменяются." });
  }
  view.health = healthOf(problems);
  return view;
}

/** Собирает вид прогона из уже загруженных данных (общий код для одной страницы и доски). */
function buildView(run: RunRow, rows: Row[], job: JobRow | null, pages: RunStatusView["pages"], problemRows: ProblemSqlRow[], costSum: number | null): RunStatusView {
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

  const problems = buildProblems(run, problemRows.map((p) => ({ stage: p.errorStage ?? "", kind: p.errorKind ?? "", raw: p.error ?? "", count: n(p.cnt) })), pages.errors);

  return {
    run: { id: run.id, name: run.name, status: run.status, stage: run.stage, blockedReason: run.blockedReason, costUsd: costSum ?? run.costUsd, estimateUsd: (run.settings as RunSettings | null)?.estimate?.totalUsd ?? null, stopRequested: run.stopRequested, updatedAt: run.updatedAt.toISOString(), stepByStep: run.stepByStep },
    job: job ? { stage: job.stage, status: job.status, done: job.done, total: job.total, label: job.label, error: job.error } : null,
    counters,
    total,
    pages,
    problems,
    health: healthOf(problems),
    stages,
  };
}

type ProblemRow = { stage: string; kind: string; raw: string; count: number };

/** Собирает список проблем прогона: остановка прогона → ошибки пинов → неоткрывшиеся статьи. */
function buildProblems(run: { status: PinRunStatus; stage: string; blockedReason: string | null; settings?: unknown }, rows: ProblemRow[], pageErrors: number): Problem[] {
  const out: Problem[] = [];
  if (run.status === "BLOCKED" || run.status === "FAILED") out.push(explainBlocked(run.blockedReason || (run.status === "FAILED" ? "Прогон завершился с ошибкой" : "Прогон остановлен из-за ошибки"), run.stage));
  for (const r of rows) out.push(explainItemError(r.kind, r.stage, r.raw, r.count));
  if (pageErrors > 0) out.push(explainPageErrors(pageErrors));
  const rep = (run.settings as { scheduleReport?: ScheduleReport | null } | null | undefined)?.scheduleReport;
  if (rep && typeof rep === "object") out.push(...explainSchedule({ moved: Number(rep.moved) || 0, days: Array.isArray(rep.days) ? rep.days.map(String) : [], limit: Number(rep.limit) || 100, unscheduled: Number(rep.unscheduled) || 0, lastDay: rep.lastDay, shifted: Number(rep.shifted) || 0, overDays: Array.isArray(rep.overDays) ? rep.overDays.map(String) : [], immediate: Number(rep.immediate) || 0 }));
  return out.sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === "critical" ? -1 : 1));
}

/** Проблемы сразу для списка прогонов (история): два запроса на весь список. */
export async function problemsForRuns(runs: Array<{ id: string; status: PinRunStatus; stage: string; blockedReason: string | null; settings?: unknown }>): Promise<Map<string, Problem[]>> {
  const out = new Map<string, Problem[]>();
  if (!runs.length) return out;
  const ids = runs.map((r) => r.id);
  const [items, pages] = await Promise.all([
    prisma.pinRunItem.groupBy({ by: ["runId", "errorStage", "errorKind"], where: { runId: { in: ids }, status: "ERROR" }, _count: { _all: true }, _max: { error: true } }),
    prisma.pinRunPage.groupBy({ by: ["runId"], where: { runId: { in: ids }, status: "error" }, _count: { _all: true } }),
  ]);
  for (const r of runs) {
    const rows = items.filter((i) => i.runId === r.id).map((i) => ({ stage: i.errorStage ?? "", kind: i.errorKind ?? "", raw: (i._max.error ?? "").slice(0, 300), count: i._count._all }));
    out.set(r.id, buildProblems(r, rows, pages.find((p) => p.runId === r.id)?._count._all ?? 0));
  }
  return out;
}

/** Карточка прогона для доски на «Сегодня»: статус, этапы, прогресс задачи, проблемы. */
export type RunOverview = {
  id: string; name: string; siteName: string; status: PinRunStatus; stage: string; stepByStep: boolean; blockedReason: string | null;
  updatedAt: string; createdAt: string; costUsd: number;
  job: { stage: string; status: string; done: number; total: number; label: string } | null;
  stages: RunStatusView["stages"];
  pages: number; pins: number; errors: number; pendingModeration: number;
  problems: Problem[]; health: Health;
};

export async function runsOverview(where: Prisma.PinRunWhereInput, limit = 20): Promise<RunOverview[]> {
  const runs = await prisma.pinRun.findMany({
    where: { ...where, NOT: { name: "__system__" } },
    orderBy: { updatedAt: "desc" }, take: limit,
    include: { site: { select: { name: true } } },
  });
  if (!runs.length) return [];
  // всё одним набором запросов на весь список (раньше ~9 запросов на каждый прогон)
  const ids = runs.map((r) => r.id);
  const idList = Prisma.join(ids);
  const [rows, lastJobAt, pagesAll, pagesErr, problemRows, costs, pending] = await Promise.all([
    prisma.$queryRaw<Array<Row & { runId: string }>>`
      SELECT runId, engine,
        CAST(SUM(status NOT IN ('POOL','REMOVED')) AS SIGNED) AS planned,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND prompt <> '') AS SIGNED) AS withPrompt,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND (imagePath <> '' OR (engine = 'PHOTO' AND sourceImageUrl <> ''))) AS SIGNED) AS withImage,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND moderation = 'APPROVED') AS SIGNED) AS approved,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND moderation = 'REJECTED') AS SIGNED) AS rejected,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND title <> '' AND description <> '' AND altText <> '') AS SIGNED) AS withText,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND wpMediaUrl <> '') AS SIGNED) AS uploaded,
        CAST(SUM(status NOT IN ('POOL','REMOVED') AND scheduledAt IS NOT NULL) AS SIGNED) AS scheduled,
        CAST(SUM(status = 'ERROR') AS SIGNED) AS errors
      FROM PinRunItem WHERE runId IN (${idList}) GROUP BY runId, engine`,
    prisma.pinJob.groupBy({ by: ["runId"], where: { runId: { in: ids } }, _max: { createdAt: true } }),
    prisma.pinRunPage.groupBy({ by: ["runId"], where: { runId: { in: ids } }, _count: { _all: true } }),
    prisma.pinRunPage.groupBy({ by: ["runId"], where: { runId: { in: ids }, status: "error" }, _count: { _all: true } }),
    // как в runStatus, но без LIMIT: топ-10 на прогон отбираем ниже
    prisma.$queryRaw<Array<ProblemSqlRow & { runId: string }>>`
      SELECT runId, errorStage, errorKind, SUBSTRING(MAX(error), 1, 300) AS error, COUNT(*) AS cnt
      FROM PinRunItem WHERE runId IN (${idList}) AND status = 'ERROR'
      GROUP BY runId, errorStage, errorKind ORDER BY cnt DESC`,
    prisma.usageLog.groupBy({ by: ["refId"], where: { refId: { in: ids } }, _sum: { costUsd: true } }),
    prisma.pinRunItem.groupBy({ by: ["runId"], where: { runId: { in: ids }, status: "READY", moderation: "NONE", kind: "pin" }, _count: { _all: true } }),
  ]);
  // последняя задача прогона: одна выборка по парам (runId, max createdAt)
  const jobPairs = lastJobAt.flatMap((j) => (j._max.createdAt ? [{ runId: j.runId, createdAt: j._max.createdAt }] : []));
  const jobs = jobPairs.length ? await prisma.pinJob.findMany({ where: { OR: jobPairs }, orderBy: { createdAt: "desc" } }) : [];

  const out: RunOverview[] = [];
  for (const run of runs) {
    const view = buildView(
      run,
      rows.filter((r) => r.runId === run.id),
      jobs.find((j) => j.runId === run.id) ?? null,
      // withKeyword на доске не используется
      { total: pagesAll.find((p) => p.runId === run.id)?._count._all ?? 0, withKeyword: 0, errors: pagesErr.find((p) => p.runId === run.id)?._count._all ?? 0 },
      problemRows.filter((p) => p.runId === run.id).slice(0, 10),
      costs.find((c) => c.refId === run.id)?._sum.costUsd ?? null,
    );
    const pendingModeration = pending.find((p) => p.runId === run.id)?._count._all ?? 0;
    out.push({
      id: run.id, name: run.name, siteName: run.site?.name ?? "—", status: run.status, stage: run.stage, stepByStep: run.stepByStep, blockedReason: run.blockedReason,
      updatedAt: run.updatedAt.toISOString(), createdAt: run.createdAt.toISOString(), costUsd: view.run.costUsd,
      job: view.job ? { stage: view.job.stage, status: view.job.status, done: view.job.done, total: view.job.total, label: view.job.label } : null,
      stages: view.stages,
      pages: view.pages.total, pins: view.total.planned, errors: view.total.errors, pendingModeration,
      problems: view.problems, health: view.health,
    });
  }
  return out;
}
