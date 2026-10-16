/**
 * Цикл очереди статей (сервис «Статьи»). Живёт в том же процессе воркера, что очередь пинов и подборов доменов.
 * Одновременно ведётся не больше ARTICLES_WORKER_CONCURRENCY статей; лимиты сайтов по фазам — в claimArticle.
 */
import { claimArticle, requeueOrphanArticles, requeueStaleArticles } from "./queue";
import { processArticle } from "./runner";
import { log } from "../log";

const CONCURRENCY = Number(process.env.ARTICLES_WORKER_CONCURRENCY || 3);
const IDLE_MS = 3_000;

const inflight = new Set<Promise<void>>();

export function articlesInflight(): Set<Promise<void>> {
  return inflight;
}

export async function articlesLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    if (inflight.size >= CONCURRENCY) {
      await Promise.race(inflight);
      continue;
    }
    let article = null;
    try {
      article = await claimArticle(workerId);
    } catch (e) {
      log.warn("articles: claim failed", e);
      await sleep(5_000);
      continue;
    }
    if (!article) {
      await sleep(IDLE_MS);
      continue;
    }
    const p = processArticle(article, workerId, shouldStop)
      .catch((e) => log.error(`articles: processArticle crashed for ${article!.id}`, e))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }
}

export async function articlesStartup(hostPrefix: string): Promise<void> {
  await requeueOrphanArticles(hostPrefix).catch((e) => log.warn("articles: requeue orphans failed", e));
  await requeueStaleArticles().catch((e) => log.warn("articles: requeue stale failed", e));
}

export { requeueStaleArticles };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
