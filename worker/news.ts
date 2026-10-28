import { claimRun, failStaleRuns, purgeOld, scheduleDue } from "@/lib/news/runs";
import { runPipeline } from "@/lib/news/pipeline";
import { prisma } from "@/lib/db";
import { log } from "./log";

/**
 * Модуль «Новости» (раздел Discovery): плановые прогоны раз в intervalMin и ручные по кнопке.
 * Прогоны идут по одному: работа сетевая (ленты, Google News с паузами, OpenRouter), процессор почти не нужен.
 */
const IDLE_MS = 5_000;
const inflight = new Set<Promise<void>>();

export function newsInflight(): Set<Promise<void>> {
  return inflight;
}

export async function newsLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  let lastSchedule = 0;
  while (!shouldStop()) {
    try {
      if (Date.now() - lastSchedule > 60_000) {
        lastSchedule = Date.now();
        const n = await scheduleDue();
        if (n) log.info(`news: scheduled ${n} run(s)`);
      }
      const run = await claimRun(workerId);
      if (!run) {
        await sleep(IDLE_MS);
        continue;
      }
      const started = Date.now();
      const p = runPipeline(run.id, shouldStop)
        .catch((e) => log.error(`news: run ${run.id} crashed`, e))
        .finally(() => inflight.delete(p));
      inflight.add(p);
      await p;
      const after = await prisma.newsRun.findUnique({ where: { id: run.id }, select: { status: true, costUsd: true, stats: true } });
      const st = (after?.stats ?? {}) as { fetched?: number; fresh?: number; classified?: number; clustersNew?: number };
      log.info(`news: run ${run.id} (${run.kind}) ${after?.status} in ${Math.round((Date.now() - started) / 1000)}s: fetched ${st.fetched ?? 0}, new ${st.fresh ?? 0}, classified ${st.classified ?? 0}, clusters +${st.clustersNew ?? 0}, $${(after?.costUsd ?? 0).toFixed(4)}`);
    } catch (e) {
      log.warn("news: loop error", e);
      await sleep(10_000);
    }
  }
}

export async function newsStartup(hostPrefix: string): Promise<void> {
  const n = await failStaleRuns(hostPrefix);
  if (n) log.info(`news: ${n} interrupted run(s) closed`);
}

export async function newsDaily(): Promise<void> {
  await failStaleRuns();
  const r = await purgeOld();
  if (r.items || r.vectors || r.trends) log.info(`news: purged ${r.items} items, ${r.vectors} vectors, ${r.trends} trends`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
