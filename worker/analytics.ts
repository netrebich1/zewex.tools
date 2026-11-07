import { prisma } from "@/lib/db";
import { claimProperty, purgeOldAnalytics, releaseProperty, syncProperty } from "@/lib/analytics/sync";
import { log } from "./log";

/**
 * Трафик сайтов (Google Analytics): воркер забирает сайты с подошедшим nextSyncAt и тянет данные GA4 в базу.
 * Параллельно до GA_SYNC_CONCURRENCY сайтов (работа сетевая); квоты GA считаются на свойство, поэтому разные сайты не мешают друг другу.
 */
const CONCURRENCY = Number(process.env.GA_SYNC_CONCURRENCY || 2);
const IDLE_MS = 5_000;
const inflight = new Set<Promise<void>>();

export function analyticsInflight(): Set<Promise<void>> {
  return inflight;
}

export async function analyticsLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    if (inflight.size >= CONCURRENCY) {
      await Promise.race(inflight);
      continue;
    }
    let prop = null;
    try {
      prop = await claimProperty(workerId);
    } catch (e) {
      log.warn("analytics: claim failed", e);
      await sleep(10_000);
      continue;
    }
    if (!prop) {
      await sleep(IDLE_MS);
      continue;
    }
    const p = (async () => {
      const started = Date.now();
      try {
        const r = await syncProperty(prop);
        const sec = Math.round((Date.now() - started) / 1000);
        if (r.kind === "ok") log.info(`analytics: ${prop.name} synced in ${sec}s (${r.requests} requests${r.done ? "" : ", history loading"})`);
        else log.warn(`analytics: ${prop.name} ${r.kind}: ${r.message}`);
      } catch (e) {
        log.error(`analytics: ${prop.name} crashed`, e);
      } finally {
        await releaseProperty(prop.id);
      }
    })().finally(() => inflight.delete(p));
    inflight.add(p);
  }
}

/** Аренды, оставшиеся от упавшего воркера. */
export async function analyticsRequeueStale(hostPrefix?: string): Promise<void> {
  const r = await prisma.gaProperty.updateMany({
    where: { syncLockedAt: { not: null }, ...(hostPrefix ? { syncLockedBy: { startsWith: hostPrefix } } : { syncLockedAt: { lt: new Date(Date.now() - 15 * 60_000) } }) },
    data: { syncLockedAt: null, syncLockedBy: null },
  });
  if (r.count) log.info(`analytics: released ${r.count} stale lock(s)`);
}

export async function analyticsPurge(): Promise<void> {
  const r = await purgeOldAnalytics();
  if (r.hourly || r.pages || r.dims) log.info(`analytics: purged hourly ${r.hourly}, pages ${r.pages}, dims ${r.dims}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
