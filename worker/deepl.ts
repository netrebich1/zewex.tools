import { prisma } from "@/lib/db";
import { claimItem, failItem, refreshJobStatus, requeueStaleItems } from "@/lib/deepl/jobs";
import { processItem } from "@/lib/deepl/process";
import { log } from "./log";

/**
 * Очередь DeepL Articler (раздел Discovery): одна задача = одна статья прогона.
 * Статьи разных прогонов и одного прогона идут параллельно — до DEEPL_WORKER_CONCURRENCY одновременно
 * (работа сетевая: DeepL и OpenRouter, процессор почти не нужен). Внутри статьи фрагменты тоже параллельны
 * (DEEPL_CHUNK_CONCURRENCY, DEEPL_EDIT_CHUNK_CONCURRENCY).
 */
const CONCURRENCY = Number(process.env.DEEPL_WORKER_CONCURRENCY || 6);
const IDLE_MS = 2_000;

const inflight = new Set<Promise<void>>();

export function deeplInflight(): Set<Promise<void>> {
  return inflight;
}

async function processOne(item: NonNullable<Awaited<ReturnType<typeof claimItem>>>, workerId: string, shouldStop: () => boolean): Promise<void> {
  const started = Date.now();
  try {
    const outcome = await processItem(item, item.job, workerId, shouldStop);
    if (outcome === "done") {
      const after = await prisma.deeplItem.findUnique({ where: { id: item.id }, select: { status: true } });
      log.info(`deepl: item ${item.id} ${after?.status} in ${Math.round((Date.now() - started) / 1000)}s`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`deepl: item ${item.id} failed`, e);
    await failItem(item.id, msg).catch(() => {});
  }
  await refreshJobStatus(item.jobId).catch((e) => log.warn("deepl: refreshJobStatus failed", e));
}

export async function deeplLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    if (inflight.size >= CONCURRENCY) {
      await Promise.race(inflight);
      continue;
    }
    let item = null;
    try {
      item = await claimItem(workerId);
    } catch (e) {
      log.warn("deepl: claim failed", e);
      await sleep(5_000);
      continue;
    }
    if (!item) {
      await sleep(IDLE_MS);
      continue;
    }
    const p = processOne(item, workerId, shouldStop).finally(() => inflight.delete(p));
    inflight.add(p);
  }
}

export async function deeplRequeueStale(hostPrefix?: string): Promise<void> {
  const n = await requeueStaleItems(hostPrefix);
  if (n) log.info(`deepl: requeued ${n} stale item(s)`);
}

/** Кэш переводов старше 90 дней не нужен: статьи к тому времени давно опубликованы. */
export async function deeplPurgeCache(): Promise<void> {
  const r = await prisma.deeplCache.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60_000) } } });
  if (r.count) log.info(`deepl: purged ${r.count} cached translations`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
