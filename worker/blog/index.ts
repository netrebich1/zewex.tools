/**
 * Цикл очереди инфо-статей (сервис «Pin Blog Article»). Живёт в том же процессе воркера, что очереди пинов и статей.
 * Одновременно ведётся не больше BLOG_WORKER_CONCURRENCY постов; лимиты сайтов и общий потолок — в claimPost.
 */
import { resyncBlogSheets } from "@/lib/blog/sheets";
import { prisma } from "@/lib/db";
import { claimPost, requeueOrphanPosts, requeueStalePosts } from "./queue";
import { processPost } from "./runner";
import { log } from "../log";

const CONCURRENCY = Number(process.env.BLOG_WORKER_CONCURRENCY || 4);
const IDLE_MS = 3_000;

const inflight = new Set<Promise<void>>();

export function blogInflight(): Set<Promise<void>> {
  return inflight;
}

export async function blogLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    if (inflight.size >= CONCURRENCY) {
      await Promise.race(inflight);
      continue;
    }
    let post = null;
    try {
      post = await claimPost(workerId);
    } catch (e) {
      log.warn("blog: claim failed", e);
      await sleep(5_000);
      continue;
    }
    if (!post) {
      await sleep(IDLE_MS);
      continue;
    }
    const p = processPost(post, workerId, shouldStop)
      .catch((e) => log.error(`blog: processPost crashed for ${post!.id}`, e))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }
}

let sheetsTimer: ReturnType<typeof setInterval> | null = null;

export async function blogStartup(hostPrefix: string): Promise<void> {
  // Досылка отчёта в Google Таблицы (опубликованные статьи, у которых запись не прошла) — раз в 5 минут
  if (!sheetsTimer) sheetsTimer = setInterval(() => resyncBlogSheets(10).then((r) => { if (r.tried) log.info(`blog sheets resync: ${r.ok}/${r.tried}`); }).catch((e) => log.warn("blog resyncBlogSheets failed", e)), 5 * 60_000);
  await prisma.blogSettings.upsert({ where: { id: "main" }, update: { workerCap: CONCURRENCY }, create: { id: "main", workerCap: CONCURRENCY } }).catch((e) => log.warn("blog: save workerCap failed", e));
  await requeueOrphanPosts(hostPrefix).catch((e) => log.warn("blog: requeue orphans failed", e));
  await requeueStalePosts().catch((e) => log.warn("blog: requeue stale failed", e));
}

export { requeueStalePosts };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
