import { analyzeSite } from "@/lib/competitors/analyze";
import { claimSite, loadState, queueByRules, requeueStale, runSync, syncDue } from "@/lib/competitors/sites";
import { assignThemes } from "@/lib/competitors/themes";
import { log } from "./log";

/**
 * «Анализ конкурентов» (раздел Discovery): раз в сутки сбор новых площадок Collaborator, затем разбор очереди —
 * одна задача = одна площадка (запрос DataForSEO + вызов модели). Работа сетевая, до COMP_WORKER_CONCURRENCY сразу.
 */
const CONCURRENCY = Number(process.env.COMP_WORKER_CONCURRENCY || 3);
const IDLE_MS = 5_000;

const inflight = new Set<Promise<void>>();

export function competitorsInflight(): Set<Promise<void>> {
  return inflight;
}

export async function competitorsLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  let lastCheck = 0;
  while (!shouldStop()) {
    try {
      if (Date.now() - lastCheck > 60_000) {
        lastCheck = Date.now();
        if (await syncDue()) {
          const stats = await runSync(shouldStop);
          if (stats.error) log.warn(`competitors: sync failed: ${stats.error}`);
          else log.info(`competitors: sync ${stats.total} in catalog, ${stats.kept} with GSC, +${stats.fresh} new, queued ${stats.queued}, ${stats.seconds}s`);
        } else {
          // Суточный лимит освобождается в течение дня — добираем очередь по правилам.
          const n = await queueByRules((await loadState()).settings);
          if (n) log.info(`competitors: queued ${n} site(s) by rules`);
          // Разбор не идёт — относим новые кластеры к общим темам (страница «Темы»).
          if (!n && !inflight.size) {
            const t = await assignThemes();
            if (t.error) log.warn(`competitors: themes failed: ${t.error}`);
            else if (t.assigned) log.info(`competitors: themes for ${t.assigned} cluster(s), $${t.costUsd.toFixed(4)}`);
          }
        }
      }
      if (inflight.size >= CONCURRENCY) {
        await Promise.race(inflight);
        continue;
      }
      const site = await claimSite(workerId);
      if (!site) {
        await sleep(IDLE_MS);
        continue;
      }
      const { settings } = await loadState();
      const p = analyzeSite(site.id, settings)
        .catch((e) => log.error(`competitors: site ${site.domain} crashed`, e))
        .finally(() => inflight.delete(p));
      inflight.add(p);
    } catch (e) {
      log.warn("competitors: loop error", e);
      await sleep(10_000);
    }
  }
}

export async function competitorsStartup(hostPrefix: string): Promise<void> {
  const n = await requeueStale(hostPrefix);
  if (n) log.info(`competitors: requeued ${n} interrupted site(s)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
