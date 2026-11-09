import { prisma } from "@/lib/db";
import { claimDomainRun, failDomainRun, processDomainRun, requeueStaleDomainRuns } from "@/lib/domains/runs";
import { log } from "./log";

/**
 * Очередь подборов доменов (инструмент «Подбор доменов», раздел Gambling).
 * Отдельная от PinJob: один подбор = одна длинная задача (проверка RDAP бренд за брендом).
 * Одновременно выполняется не больше DOMAINS_WORKER_CONCURRENCY подборов.
 */
const CONCURRENCY = Number(process.env.DOMAINS_WORKER_CONCURRENCY || 1);
const IDLE_MS = 3_000;

const inflight = new Set<Promise<void>>();

/** Выполняющиеся подборы: воркер ждёт их при мягкой остановке. */
export function domainsInflight(): Set<Promise<void>> {
  return inflight;
}

async function processOne(run: Awaited<ReturnType<typeof claimDomainRun>> & object, workerId: string, shouldStop: () => boolean): Promise<void> {
  log.info(`domains: run ${run.id} started («${run.name}»)`);
  try {
    await processDomainRun(run, workerId, shouldStop);
    const after = await prisma.domainRun.findUnique({ where: { id: run.id }, select: { status: true, totalChecked: true, totalAvailable: true } });
    log.info(`domains: run ${run.id} ${after?.status} (checked ${after?.totalChecked}, available ${after?.totalAvailable})`);
  } catch (e) {
    log.error(`domains: run ${run.id} failed`, e);
    await failDomainRun(run.id, e instanceof Error ? e.message : String(e)).catch(() => {});
  }
}

/** Цикл очереди подборов; завершается, когда shouldStop() вернёт true. */
export async function domainsLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    if (inflight.size >= CONCURRENCY) {
      await Promise.race(inflight);
      continue;
    }
    let run = null;
    try {
      run = await claimDomainRun(workerId);
    } catch (e) {
      log.warn("domains: claim failed", e);
      await sleep(5_000);
      continue;
    }
    if (!run) {
      await sleep(IDLE_MS);
      continue;
    }
    const p = processOne(run, workerId, shouldStop).finally(() => inflight.delete(p));
    inflight.add(p);
  }
}

export async function domainsRequeueStale(hostPrefix?: string): Promise<void> {
  const n = await requeueStaleDomainRuns(hostPrefix);
  if (n) log.info(`domains: requeued ${n} stale run(s)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
