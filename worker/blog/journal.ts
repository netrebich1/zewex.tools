/** Журнал этапов и ошибок инфо-статей (копия worker/articles/journal.ts под модели Blog*). */
import { prisma } from "@/lib/db";
import { failureSignature, type RetryKind } from "@/lib/articles/errors";

export async function finishLog(id: string, status: "done" | "error" | "skipped", summary?: string | null, error?: string | null, details?: unknown, costUsd?: number) {
  await prisma.blogStageLog.update({
    where: { id },
    data: { status, finishedAt: new Date(), summary: summary?.slice(0, 2000), error: error?.slice(0, 4000), details: details === undefined ? undefined : (details as object), costUsd: costUsd ?? undefined },
  });
}

export function errorSignature(stage: string, message: string): string {
  const norm = message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${stage}: ${norm}`;
}

export async function recordError(e: { teamId: string; siteId?: string | null; postId?: string | null; stage: string; message: string; code?: string; human?: string }) {
  const signature = e.code ? failureSignature(e.stage, e.code, e.human ?? e.message) : errorSignature(e.stage, e.message);
  await prisma.blogError.create({ data: { teamId: e.teamId, siteId: e.siteId ?? null, postId: e.postId ?? null, stage: e.stage, message: e.message.slice(0, 4000), signature } }).catch(() => {});
}

export type RetryMark = { kind: RetryKind; n: number; max: number | null; delayMs: number; code?: string };

export function markDetails(details: unknown, mark: { retry?: RetryMark; final?: boolean; boundary?: boolean }): object {
  if (details && typeof details === "object" && !Array.isArray(details)) return { ...(details as object), ...mark };
  return details === undefined || details === null ? mark : { ...mark, data: details };
}

export type RetryStreak = { counts: Record<RetryKind, number>; firstAt: Record<RetryKind, Date | null> };

/** Серия повторов этапа по журналу с последней границы (done / final / boundary). */
export async function retryStreak(postId: string, stage: string, excludeLogId?: string): Promise<RetryStreak> {
  const out: RetryStreak = {
    counts: { transient: 0, malformed: 0, key: 0, planned: 0 },
    firstAt: { transient: null, malformed: null, key: null, planned: null },
  };
  const rows = await prisma.blogStageLog.findMany({
    where: { postId, ...(excludeLogId ? { id: { not: excludeLogId } } : {}) },
    orderBy: { startedAt: "desc" },
    take: 500,
    select: { stage: true, status: true, details: true, startedAt: true },
  });
  for (const r of rows) {
    const d = (r.details && typeof r.details === "object" && !Array.isArray(r.details) ? r.details : {}) as { retry?: RetryMark; final?: boolean; boundary?: boolean };
    if (r.status === "done" || d.final || d.boundary) break;
    if (r.stage !== stage || !d.retry?.kind) continue;
    const k = d.retry.kind;
    if (!(k in out.counts)) continue;
    out.counts[k]++;
    out.firstAt[k] = r.startedAt;
  }
  return out;
}
