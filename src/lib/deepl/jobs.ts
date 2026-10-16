/**
 * Прогоны DeepL Articler: доступ, создание, очередь статей для воркера, остановка/продолжение, повтор, публикация, откат.
 * Прогон видят автор, его команды и админы. Очередь — по статьям (DeeplItem), а не по прогонам: несколько статей
 * обрабатываются параллельно (DEEPL_WORKER_CONCURRENCY в воркере).
 */
import { Prisma, type DeeplItem, type DeeplJob } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { ITEM_LEASE_SECONDS, publishHtml } from "./process";
import { getPost, requireSite, savePost, siteCreds } from "./wp";
import { MAX_JOB_ITEMS, type DeeplSettings } from "./types";

/* ---------- Доступ ---------- */

export function jobWhere(me: CurrentUser): Prisma.DeeplJobWhereInput {
  if (me.role === "ADMIN") return {};
  return { OR: [{ createdById: me.id }, ...(me.teamIds.length ? [{ teamId: { in: me.teamIds } }] : [])] };
}

export function canAccessJob(me: CurrentUser, job: { createdById: string; teamId: string | null }): boolean {
  if (me.role === "ADMIN" || job.createdById === me.id) return true;
  return job.teamId != null && me.teamIds.includes(job.teamId);
}

export async function requireJob(me: CurrentUser, id: string): Promise<DeeplJob> {
  const job = await prisma.deeplJob.findUnique({ where: { id } });
  if (!job || !canAccessJob(me, job)) throw new Error("Прогон не найден");
  return job;
}

export async function requireItem(me: CurrentUser, id: string): Promise<DeeplItem & { job: DeeplJob }> {
  const item = await prisma.deeplItem.findUnique({ where: { id }, include: { job: true } });
  if (!item || !canAccessJob(me, item.job)) throw new Error("Статья не найдена");
  return item;
}

/* ---------- Создание ---------- */

export type LaunchPost = { id: number; title: string; link: string; status: string; date: string };

export async function createJob(me: CurrentUser, accessId: string, settings: DeeplSettings, posts: LaunchPost[], name: string): Promise<string> {
  const site = await requireSite(me, accessId);
  if (!posts.length) throw new Error("Отметьте хотя бы одну статью");
  if (posts.length > MAX_JOB_ITEMS) throw new Error(`В одном прогоне не больше ${MAX_JOB_ITEMS} статей`);
  if (!settings.translateSteps.length && !settings.headings.enabled && !settings.postEdit.enabled) throw new Error("Включите хотя бы один этап");
  const seen = new Set<number>();
  const list = posts.filter((p) => Number.isInteger(p.id) && p.id > 0 && !seen.has(p.id) && seen.add(p.id));
  const job = await prisma.deeplJob.create({
    data: {
      teamId: me.teamIds[0] ?? null,
      createdById: me.id,
      accessId,
      siteName: site.name,
      name: name.trim().slice(0, 120) || `${site.name} · ${new Date().toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Kyiv" })}`,
      status: "QUEUED",
      settings: settings as unknown as Prisma.InputJsonValue,
      total: list.length,
    },
    select: { id: true },
  });
  await prisma.deeplItem.createMany({
    data: list.map((p, i) => ({
      jobId: job.id,
      position: i,
      wpPostId: p.id,
      title: String(p.title ?? "").slice(0, 1000),
      sourceUrl: p.link || null,
      wpStatus: p.status || null,
      wpDate: p.date || null,
    })),
  });
  return job.id;
}

/* ---------- Очередь (воркер) ---------- */

/** Атомарно берёт следующую статью из прогонов в очереди (старые прогоны первыми, статьи по порядку). */
export async function claimItem(workerId: string): Promise<(DeeplItem & { job: DeeplJob }) | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; jobId: string }>>`
    SELECT i.id, i.jobId FROM DeeplItem i JOIN DeeplJob j ON j.id = i.jobId
    WHERE i.status = 'pending' AND j.status IN ('QUEUED', 'RUNNING') AND j.stopRequested = 0
    ORDER BY j.createdAt ASC, i.position ASC LIMIT 8`;
  for (const r of rows) {
    const n = await prisma.$executeRaw`UPDATE DeeplItem SET status = 'processing', workerId = ${workerId}, attempts = attempts + 1,
      startedAt = COALESCE(startedAt, NOW(3)), leaseUntil = DATE_ADD(NOW(3), INTERVAL ${ITEM_LEASE_SECONDS} SECOND)
      WHERE id = ${r.id} AND status = 'pending'`;
    if (n !== 1) continue;
    await prisma.$executeRaw`UPDATE DeeplJob SET status = 'RUNNING', startedAt = COALESCE(startedAt, NOW(3)) WHERE id = ${r.jobId} AND status = 'QUEUED'`;
    return prisma.deeplItem.findUniqueOrThrow({ where: { id: r.id }, include: { job: true } });
  }
  return null;
}

/** Статьи, чей воркер умер (аренда истекла) или остались от прошлого процесса этого хоста, — снова в очередь. */
export async function requeueStaleItems(hostPrefix?: string): Promise<number> {
  return prisma.$executeRaw`UPDATE DeeplItem SET status = 'pending', workerId = NULL, leaseUntil = NULL
    WHERE status = 'processing' AND (leaseUntil < NOW(3) ${hostPrefix ? Prisma.sql`OR workerId LIKE ${hostPrefix + "-%"}` : Prisma.empty})`;
}

export async function failItem(id: string, message: string): Promise<void> {
  await prisma.deeplItem.update({ where: { id }, data: { status: "error", error: message.slice(0, 2000), workerId: null, leaseUntil: null, finishedAt: new Date() } });
}

/** Пересчёт статуса прогона после статьи: всё обработано → DONE (или FAILED, если ни одна статья не получилась). */
export async function refreshJobStatus(jobId: string): Promise<void> {
  const groups = await prisma.deeplItem.groupBy({ by: ["status"], where: { jobId }, _count: { _all: true } });
  const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
  const job = await prisma.deeplJob.findUnique({ where: { id: jobId }, select: { status: true, stopRequested: true } });
  if (!job) return;
  const active = n("pending") + n("processing");
  if (job.stopRequested && n("processing") === 0) {
    await prisma.deeplItem.updateMany({ where: { jobId, status: "pending" }, data: { status: "stopped" } });
    await prisma.deeplJob.update({ where: { id: jobId }, data: { status: "STOPPED", stopRequested: false, finishedAt: new Date() } });
    return;
  }
  if (active > 0 || job.status === "STOPPED") return;
  const ok = n("done") + n("warning");
  const errors = n("error");
  await prisma.deeplJob.update({
    where: { id: jobId },
    data: {
      status: ok === 0 && errors > 0 ? "FAILED" : "DONE",
      finishedAt: new Date(),
      error: errors || n("warning") ? `${errors} с ошибкой, ${n("warning")} требуют проверки` : null,
    },
  });
}

/* ---------- Управление ---------- */

export async function stopJob(me: CurrentUser, id: string): Promise<void> {
  const job = await requireJob(me, id);
  if (job.status !== "QUEUED" && job.status !== "RUNNING") return;
  await prisma.deeplItem.updateMany({ where: { jobId: id, status: "pending" }, data: { status: "stopped" } });
  const processing = await prisma.deeplItem.count({ where: { jobId: id, status: "processing" } });
  // Статьи в работе дописывают текущий этап и встают (снимки сохраняются, «Продолжить» начнёт с места остановки).
  if (processing) await prisma.deeplJob.update({ where: { id }, data: { stopRequested: true } });
  else await prisma.deeplJob.update({ where: { id }, data: { status: "STOPPED", stopRequested: false, finishedAt: new Date() } });
}

export async function resumeJob(me: CurrentUser, id: string): Promise<number> {
  const job = await requireJob(me, id);
  if (job.status === "RUNNING" && !job.stopRequested) return 0;
  const r = await prisma.deeplItem.updateMany({ where: { jobId: id, status: "stopped" }, data: { status: "pending", workerId: null, leaseUntil: null } });
  if (!r.count) throw new Error("Нечего продолжать: остановленных статей нет");
  await prisma.deeplJob.update({ where: { id }, data: { status: "QUEUED", stopRequested: false, finishedAt: null } });
  return r.count;
}

/** Повтор статей: готовые и проверенные гоним заново с исходника, с ошибкой — продолжаем с последнего готового этапа. */
export async function retryItems(me: CurrentUser, jobId: string, itemIds: string[] | "failed", fresh = false): Promise<number> {
  await requireJob(me, jobId);
  const where: Prisma.DeeplItemWhereInput = itemIds === "failed"
    ? { jobId, status: { in: ["error", "warning"] } }
    : { jobId, id: { in: itemIds }, status: { notIn: ["processing", "pending"] } };
  const items = await prisma.deeplItem.findMany({ where, select: { id: true, status: true, stages: true } });
  for (const it of items) {
    const full = fresh || it.status === "done" || it.status === "warning";
    const stages = Array.isArray(it.stages) ? (it.stages as Array<{ key?: string }>) : [];
    await prisma.deeplItem.update({
      where: { id: it.id },
      data: {
        status: "pending", stage: "pending", error: null, warnings: Prisma.JsonNull, workerId: null, leaseUntil: null, finishedAt: null,
        ...(full ? { stages: stages.filter((s) => s?.key === "source") as unknown as Prisma.InputJsonValue, finalHtml: null, keywordReport: Prisma.JsonNull } : {}),
      },
    });
  }
  if (items.length) await prisma.deeplJob.update({ where: { id: jobId }, data: { status: "QUEUED", stopRequested: false, finishedAt: null, error: null } });
  return items.length;
}

export async function deleteJob(me: CurrentUser, id: string): Promise<void> {
  await requireJob(me, id);
  const busy = await prisma.deeplItem.count({ where: { jobId: id, status: "processing" } });
  if (busy) throw new Error("Статьи ещё в работе — сначала остановите прогон и дождитесь остановки");
  await prisma.deeplJob.delete({ where: { id } });
}

/* ---------- Публикация вручную и откат ---------- */

export async function publishItem(me: CurrentUser, itemId: string, mode: "source" | "new", status: string): Promise<string> {
  const item = await requireItem(me, itemId);
  const html = item.finalHtml;
  if (!html?.trim()) throw new Error("У статьи ещё нет готового текста");
  if (item.stage === "publishing") throw new Error("Публикация этой статьи уже выполняется");
  const claimed = await prisma.deeplItem.updateMany({ where: { id: itemId, stage: item.stage }, data: { stage: "publishing" } });
  if (!claimed.count) throw new Error("Публикация этой статьи уже выполняется");
  try {
    const r = await publishHtml(item.job, item, html, mode, status);
    await prisma.deeplItem.update({ where: { id: itemId }, data: { stage: item.stage, publishedUrl: r.link, publishedPostId: r.id, publishMode: r.mode, publishedAt: new Date(), revertedAt: null } });
    return r.link;
  } catch (e) {
    await prisma.deeplItem.update({ where: { id: itemId }, data: { stage: item.stage } });
    throw e;
  }
}

/** Опубликовать все готовые (done) и ещё не опубликованные статьи прогона. */
export async function publishReady(me: CurrentUser, jobId: string, mode: "source" | "new", status: string, includeWarnings: boolean): Promise<{ ok: number; failed: string[] }> {
  await requireJob(me, jobId);
  const items = await prisma.deeplItem.findMany({
    where: { jobId, status: { in: includeWarnings ? ["done", "warning"] : ["done"] }, publishedAt: null, finalHtml: { not: null } },
    select: { id: true, title: true },
    orderBy: { position: "asc" },
  });
  let ok = 0;
  const failed: string[] = [];
  for (const it of items) {
    try {
      await publishItem(me, it.id, mode, status);
      ok++;
    } catch (e) {
      failed.push(`${it.title || it.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok, failed };
}

/** Вернуть в WordPress оригинал поста, сохранённый перед заменой. */
export async function revertItem(me: CurrentUser, itemId: string): Promise<void> {
  const item = await requireItem(me, itemId);
  if (!item.originalWpHtml || !item.wpPostId) throw new Error("Оригинал не сохранён — откат невозможен");
  if (!item.job.accessId) throw new Error("У прогона нет сайта");
  const creds = await siteCreds(item.job.accessId);
  const payload: Record<string, unknown> = { content: item.originalWpHtml };
  if (item.originalWpStatus) payload.status = item.originalWpStatus;
  if (item.originalWpTitle) payload.title = item.originalWpTitle;
  await savePost(creds, item.wpPostId, payload);
  await prisma.deeplItem.update({ where: { id: itemId }, data: { revertedAt: new Date(), publishedUrl: null, publishMode: null, publishedAt: null } });
}

/** Текущий текст поста в WP (для сравнения перед публикацией). */
export async function currentWpHtml(me: CurrentUser, itemId: string): Promise<string> {
  const item = await requireItem(me, itemId);
  if (!item.job.accessId || !item.wpPostId) throw new Error("Нет поста в WordPress");
  return (await getPost(await siteCreds(item.job.accessId), item.wpPostId)).html;
}

/* ---------- Списки для страниц ---------- */

export async function listJobs(me: CurrentUser, take = 100) {
  const jobs = await prisma.deeplJob.findMany({ where: jobWhere(me), orderBy: { createdAt: "desc" }, take });
  const ids = jobs.map((j) => j.id);
  const counts = ids.length
    ? await prisma.deeplItem.groupBy({ by: ["jobId", "status"], where: { jobId: { in: ids } }, _count: { _all: true }, _sum: { costUsd: true, deeplChars: true } })
    : [];
  const published = ids.length ? await prisma.deeplItem.groupBy({ by: ["jobId"], where: { jobId: { in: ids }, publishedAt: { not: null } }, _count: { _all: true } }) : [];
  return jobs.map((j) => {
    const c = counts.filter((x) => x.jobId === j.id);
    const by = (s: string) => c.find((x) => x.status === s)?._count._all ?? 0;
    return {
      ...j,
      counts: { pending: by("pending"), processing: by("processing"), done: by("done"), warning: by("warning"), error: by("error"), stopped: by("stopped") },
      published: published.find((p) => p.jobId === j.id)?._count._all ?? 0,
      costUsd: c.reduce((a, x) => a + (x._sum.costUsd ?? 0), 0),
      deeplChars: c.reduce((a, x) => a + (x._sum.deeplChars ?? 0), 0),
    };
  });
}

export type JobItemRow = {
  id: string; position: number; title: string; sourceUrl: string | null; wpPostId: number | null; wpStatus: string | null; wpDate: string | null;
  status: string; stage: string; error: string | null; warnings: Array<{ code: string; detail: string }>; keywordReport: Array<{ key: string; source: number; current: number; min: number; max: number; ok: boolean }>;
  publishedUrl: string | null; publishedAt: Date | null; publishMode: string | null; revertedAt: Date | null; hasOriginal: boolean;
  costUsd: number; deeplChars: number; startedAt: Date | null; finishedAt: Date | null; stageKeys: string[];
};

/** Статьи прогона без тяжёлых HTML (для таблицы и опроса раз в несколько секунд). */
export async function jobItems(jobId: string): Promise<JobItemRow[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, position, title, sourceUrl, wpPostId, wpStatus, wpDate, status, stage, error, warnings, keywordReport, publishedUrl, publishedAt, publishMode,
      revertedAt, (originalWpHtml IS NOT NULL) AS hasOriginal, costUsd, deeplChars, startedAt, finishedAt,
      JSON_EXTRACT(stages, '$[*].key') AS stageKeys
    FROM DeeplItem WHERE jobId = ${jobId} ORDER BY position ASC`;
  const json = <T,>(v: unknown, d: T): T => {
    if (v == null) return d;
    if (typeof v === "string") {
      try {
        return JSON.parse(v) as T;
      } catch {
        return d;
      }
    }
    return v as T;
  };
  return rows.map((r) => ({
    id: String(r.id),
    position: Number(r.position),
    title: String(r.title ?? ""),
    sourceUrl: (r.sourceUrl as string | null) ?? null,
    wpPostId: r.wpPostId == null ? null : Number(r.wpPostId),
    wpStatus: (r.wpStatus as string | null) ?? null,
    wpDate: (r.wpDate as string | null) ?? null,
    status: String(r.status),
    stage: String(r.stage),
    error: (r.error as string | null) ?? null,
    warnings: json(r.warnings, []),
    keywordReport: json(r.keywordReport, []),
    publishedUrl: (r.publishedUrl as string | null) ?? null,
    publishedAt: (r.publishedAt as Date | null) ?? null,
    publishMode: (r.publishMode as string | null) ?? null,
    revertedAt: (r.revertedAt as Date | null) ?? null,
    hasOriginal: Boolean(Number(r.hasOriginal)),
    costUsd: Number(r.costUsd ?? 0),
    deeplChars: Number(r.deeplChars ?? 0),
    startedAt: (r.startedAt as Date | null) ?? null,
    finishedAt: (r.finishedAt as Date | null) ?? null,
    stageKeys: json<string[]>(r.stageKeys, []),
  }));
}
