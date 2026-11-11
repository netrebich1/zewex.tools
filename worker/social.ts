import { claimItem, processItem, purgeOldFiles, refreshRunStatus, requeueStaleItems } from "@/lib/social/runs";
import { log } from "./log";

/**
 * Очередь «Соцсетей» (раздел Discovery): одна задача = одна статья прогона (загрузка статьи + один вызов модели
 * на посты всех сетей). Работа сетевая, процессор не нужен — до SOCIAL_WORKER_CONCURRENCY статей одновременно.
 */
const CONCURRENCY = Number(process.env.SOCIAL_WORKER_CONCURRENCY || 4);
const IDLE_MS = 3_000;

const inflight = new Set<Promise<void>>();

export function socialInflight(): Set<Promise<void>> {
  return inflight;
}

async function processOne(item: NonNullable<Awaited<ReturnType<typeof claimItem>>>): Promise<void> {
  try {
    await processItem(item);
  } catch (e) {
    log.error(`social: item ${item.id} crashed`, e);
  }
  await refreshRunStatus(item.runId).catch((e) => log.warn("social: refreshRunStatus failed", e));
}

export async function socialLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    if (inflight.size >= CONCURRENCY) {
      await Promise.race(inflight);
      continue;
    }
    let item = null;
    try {
      item = await claimItem(workerId);
    } catch (e) {
      log.warn("social: claim failed", e);
      await sleep(5_000);
      continue;
    }
    if (!item) {
      await sleep(IDLE_MS);
      continue;
    }
    const p = processOne(item).finally(() => inflight.delete(p));
    inflight.add(p);
  }
}

export async function socialRequeueStale(hostPrefix?: string): Promise<void> {
  const n = await requeueStaleItems(hostPrefix);
  if (n) log.info(`social: requeued ${n} stale item(s)`);
}

export async function socialPurgeFiles(): Promise<void> {
  const n = await purgeOldFiles();
  if (n) log.info(`social: removed photos of ${n} finished run(s)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
