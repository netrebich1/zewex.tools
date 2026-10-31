/** Журнал этапов и ошибок статей (замена триггеров pipeline_errors оригинала). */
import { prisma } from "@/lib/db";
import { failureSignature, type RetryKind } from "@/lib/articles/errors";

export async function finishLog(id: string, status: "done" | "error" | "skipped", summary?: string | null, error?: string | null, details?: unknown, costUsd?: number) {
  await prisma.artStageLog.updateMany({
    where: { id },
    data: { status, finishedAt: new Date(), summary: summary?.slice(0, 2000), error: error?.slice(0, 4000), details: details === undefined ? undefined : (details as object), costUsd: costUsd ?? undefined },
  });
}

/**
 * Сигнатура ошибки для группировки (оригинал: error_signature — обрезка чисел, id и URL).
 */
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

/**
 * Запись в журнал ошибок. `code` — вид сбоя (malformed, no_credits, rate_limited …): тогда сигнатура строится по нему и
 * короткой причине, и одинаковые сбои разных статей собираются в одну группу независимо от хвоста ответа провайдера.
 */
export async function recordError(e: { teamId: string; siteId?: string | null; articleId?: string | null; stage: string; message: string; code?: string; human?: string }) {
  const signature = e.code ? failureSignature(e.stage, e.code, e.human ?? e.message) : errorSignature(e.stage, e.message);
  await prisma.artError.create({ data: { teamId: e.teamId, siteId: e.siteId ?? null, articleId: e.articleId ?? null, stage: e.stage, message: e.message.slice(0, 4000), signature } }).catch(() => {});
}

/** Пометка повтора в ArtStageLog.details: по ним раннер считает серию повторов этапа. */
export type RetryMark = { kind: RetryKind; n: number; max: number | null; delayMs: number; code?: string };

/** Добавить в details журнала пометку повтора / окончательной ошибки / границы серии, не теряя подробностей этапа. */
export function markDetails(details: unknown, mark: { retry?: RetryMark; final?: boolean; boundary?: boolean }): object {
  if (details && typeof details === "object" && !Array.isArray(details)) return { ...(details as object), ...mark };
  return details === undefined || details === null ? mark : { ...mark, data: details };
}

export type RetryStreak = { counts: Record<RetryKind, number>; firstAt: Record<RetryKind, Date | null> };

/**
 * Серия повторов этапа: пометки `retry` в журнале этого этапа после последней границы — успешного этапа (done),
 * окончательной ошибки (`final`) или остановки/ручного возврата (`boundary`). Попытки, прерванные рестартом воркера
 * (skipped без пометки), не считаются. Ручное «Повторить» после ошибки начинает серию заново.
 */
export async function retryStreak(articleId: string, stage: string, excludeLogId?: string): Promise<RetryStreak> {
  const out: RetryStreak = {
    counts: { transient: 0, malformed: 0, key: 0, planned: 0 },
    firstAt: { transient: null, malformed: null, key: null, planned: null },
  };
  const rows = await prisma.artStageLog.findMany({
    where: { articleId, ...(excludeLogId ? { id: { not: excludeLogId } } : {}) },
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
    out.firstAt[k] = r.startedAt; // идём от новых к старым — последнее присвоение и есть первый сбой серии
  }
  return out;
}
