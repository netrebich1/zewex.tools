/** Журнал этапов и ошибок статей (замена триггеров pipeline_errors оригинала). */
import { prisma } from "@/lib/db";

export async function finishLog(id: string, status: "done" | "error" | "skipped", summary?: string, error?: string, details?: unknown, costUsd?: number) {
  await prisma.artStageLog.update({
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

export async function recordError(e: { teamId: string; siteId?: string | null; articleId?: string | null; stage: string; message: string }) {
  await prisma.artError.create({ data: { teamId: e.teamId, siteId: e.siteId ?? null, articleId: e.articleId ?? null, stage: e.stage, message: e.message.slice(0, 4000), signature: errorSignature(e.stage, e.message) } }).catch(() => {});
}
