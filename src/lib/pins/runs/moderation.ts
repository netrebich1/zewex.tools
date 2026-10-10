import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { publicUrl } from "../storage";
import { enqueueJob, JobConflict } from "../jobs";
import { mergeRecipe } from "../types";
import { pinRunWhere } from "@/lib/sites/access";

/** Пин в очереди модерации: только то, что нужно сетке. */
export type ModerationItem = {
  id: string;
  runId: string;
  siteName: string;
  engine: string;
  kind: string;
  keyword: string;
  title: string;
  thumbUrl: string;
  imageUrl: string;
};

export type ModerationFilter = { siteId?: string; runId?: string; engine?: string; cursor?: string; limit?: number };

const teamWhere = (me: CurrentUser): Promise<Prisma.PinRunWhereInput> => pinRunWhere(me);

/** Непроверенные пины с картинкой, keyset-пагинация по id. */
export async function moderationBatch(me: CurrentUser, f: ModerationFilter): Promise<{ items: ModerationItem[]; nextCursor: string | null }> {
  const limit = Math.min(120, Math.max(10, f.limit ?? 60));
  const rows = await prisma.pinRunItem.findMany({
    where: {
      run: { ...(await teamWhere(me)), ...(f.runId ? { id: f.runId } : {}), ...(f.siteId ? { siteId: f.siteId } : {}) },
      moderation: "NONE",
      status: "READY",
      ...(f.engine ? { engine: f.engine as "OPENAI" | "PINORA" | "CANVAS" | "PHOTO" } : {}),
      ...(f.cursor ? { id: { gt: f.cursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: limit + 1,
    include: { run: { select: { site: { select: { name: true } } } }, page: { select: { keyword: true } } },
  });
  const slice = rows.slice(0, limit);
  const items = slice.map((r) => ({
    id: r.id,
    runId: r.runId,
    siteName: r.run.site?.name ?? "",
    engine: r.engine,
    kind: r.kind,
    keyword: r.page.keyword,
    title: r.title,
    thumbUrl: r.thumbPath ? publicUrl(r.thumbPath) : r.imagePath ? publicUrl(r.imagePath) : r.sourceImageUrl,
    imageUrl: r.imagePath ? publicUrl(r.imagePath) : r.sourceImageUrl,
  }));
  return { items, nextCursor: rows.length > limit ? slice[slice.length - 1].id : null };
}

/** Счётчики непроверенных по сайтам и прогонам для фильтров. */
export async function moderationCounts(me: CurrentUser) {
  const rows = await prisma.pinRunItem.groupBy({
    by: ["runId", "engine"],
    where: { run: await teamWhere(me), moderation: "NONE", status: "READY" },
    _count: { _all: true },
  });
  const runIds = [...new Set(rows.map((r) => r.runId))];
  const runs = runIds.length ? await prisma.pinRun.findMany({ where: { id: { in: runIds } }, select: { id: true, name: true, siteId: true, status: true, site: { select: { name: true } } } }) : [];
  const byRun = new Map<string, { runId: string; name: string; siteId: string | null; siteName: string; status: string; total: number; byEngine: Record<string, number> }>();
  for (const r of rows) {
    const run = runs.find((x) => x.id === r.runId);
    const e = byRun.get(r.runId) ?? { runId: r.runId, name: run?.name ?? r.runId.slice(0, 8), siteId: run?.siteId ?? null, siteName: run?.site?.name ?? "", status: run?.status ?? "", total: 0, byEngine: {} };
    e.total += r._count._all;
    e.byEngine[r.engine] = (e.byEngine[r.engine] ?? 0) + r._count._all;
    byRun.set(r.runId, e);
  }
  const bySite = new Map<string, { siteId: string; siteName: string; total: number }>();
  for (const e of byRun.values()) {
    const k = e.siteId ?? "-";
    const s = bySite.get(k) ?? { siteId: k, siteName: e.siteName, total: 0 };
    s.total += e.total;
    bySite.set(k, s);
  }
  return { runs: [...byRun.values()], sites: [...bySite.values()], total: [...byRun.values()].reduce((a, b) => a + b.total, 0) };
}

export type Decision = { id: string; moderation: "APPROVED" | "REJECTED" };

/**
 * Пакет решений (≤200). После записи: у прогонов, ждущих модерации, при pending = 0
 * запускается этап texts (если не пошаговый режим).
 */
export async function applyDecisions(me: CurrentUser, decisions: Decision[]): Promise<{ applied: number; continued: string[] }> {
  if (!decisions.length) return { applied: 0, continued: [] };
  const ids = decisions.slice(0, 200).map((d) => d.id);
  const allowed = await prisma.pinRunItem.findMany({ where: { id: { in: ids }, run: await teamWhere(me) }, select: { id: true, runId: true } });
  const ok = new Set(allowed.map((a) => a.id));
  const approve = decisions.filter((d) => ok.has(d.id) && d.moderation === "APPROVED").map((d) => d.id);
  const reject = decisions.filter((d) => ok.has(d.id) && d.moderation === "REJECTED").map((d) => d.id);
  await prisma.$transaction([
    prisma.pinRunItem.updateMany({ where: { id: { in: approve } }, data: { moderation: "APPROVED", rejectReason: null } }),
    prisma.pinRunItem.updateMany({ where: { id: { in: reject } }, data: { moderation: "REJECTED", rejectReason: "manual" } }),
  ]);
  const continued = await continueModeratedRuns([...new Set(allowed.map((a) => a.runId))]);
  return { applied: approve.length + reject.length, continued };
}

/** Прогоны в статусе «Модерация» без непроверенных пинов продолжаются сами. */
export async function continueModeratedRuns(runIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const runId of runIds) {
    const run = await prisma.pinRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== "WAITING_MODERATION") continue;
    const pending = await prisma.pinRunItem.count({ where: { runId, status: "READY", moderation: "NONE" } });
    if (pending > 0) continue;
    await prisma.pinRun.update({ where: { id: runId }, data: { moderatedAt: new Date(), stage: "moderation" } });
    if (run.stepByStep) {
      await prisma.pinRun.update({ where: { id: runId }, data: { status: "STOPPED" } });
      continue;
    }
    try {
      await enqueueJob(runId, "texts");
      out.push(runId);
    } catch (e) {
      if (!(e instanceof JobConflict)) throw e;
    }
  }
  return out;
}

/** Режим «автоодобрение»: всё с картинкой одобряется, без картинки отклоняется. */
export async function autoModerate(runId: string): Promise<{ approved: number; rejected: number }> {
  const a = await prisma.pinRunItem.updateMany({ where: { runId, status: "READY", moderation: "NONE" }, data: { moderation: "APPROVED" } });
  const r = await prisma.pinRunItem.updateMany({ where: { runId, kind: "pin", imagePath: "", status: { in: ["PENDING", "ERROR"] }, moderation: "NONE" }, data: { moderation: "REJECTED", rejectReason: "auto_no_image" } });
  return { approved: a.count, rejected: r.count };
}

export function moderationModeOf(settings: unknown): "required" | "auto" | "sample" {
  return mergeRecipe(settings).schedule.moderationMode;
}

/** Сколько пинов прогона ещё не проверено. */
export async function pendingModeration(runId: string): Promise<number> {
  return prisma.pinRunItem.count({ where: { runId, status: "READY", moderation: "NONE" } });
}
