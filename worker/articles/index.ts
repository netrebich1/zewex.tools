/**
 * Цикл очереди статей (сервис «Статьи»). Живёт в том же процессе воркера, что очередь пинов и подборов доменов.
 * Одновременно ведётся не больше ARTICLES_WORKER_CONCURRENCY статей; лимиты сайтов по фазам — в claimArticle.
 */
import { prisma } from "@/lib/db";
import { claimArticle, requeueOrphanArticles, requeueStaleArticles } from "./queue";
import { processArticle } from "./runner";
import { log } from "../log";
import { limiterStats } from "@/lib/pins/ai/limiter";
import { brakeStats } from "@/lib/articles/ai";

const CONCURRENCY = Number(process.env.ARTICLES_WORKER_CONCURRENCY || 3);
const IDLE_MS = 3_000;

const inflight = new Set<Promise<void>>();

export function articlesInflight(): Set<Promise<void>> {
  return inflight;
}

/** Раз в минуту — семафоры ключей и автотормоз в журнал: видно, где статьи ждут ИИ (08.11: 45 статей в работе, к ключу 2 вызова). */
function logLimiters(): void {
  const busy = Object.entries(limiterStats()).filter(([, v]) => v.active || v.waiting || v.pausedMs);
  const brakes = brakeStats();
  if (busy.length || Object.keys(brakes).length) log.info(`limiters ${JSON.stringify(Object.fromEntries(busy))} brakes ${JSON.stringify(brakes)} articles ${inflight.size}`);
}

export async function articlesLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  const timer = setInterval(logLimiters, 60_000);
  timer.unref?.();
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
  // Экран «Автозапуск» показывает этот потолок: лимиты сайтов действуют внутри него.
  await prisma.artSettings.upsert({ where: { id: "main" }, update: { workerCap: CONCURRENCY }, create: { id: "main", workerCap: CONCURRENCY } }).catch((e) => log.warn("articles: save workerCap failed", e));
  await requeueOrphanArticles(hostPrefix).catch((e) => log.warn("articles: requeue orphans failed", e));
  await requeueStaleArticles().catch((e) => log.warn("articles: requeue stale failed", e));
}

export { requeueStaleArticles };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
