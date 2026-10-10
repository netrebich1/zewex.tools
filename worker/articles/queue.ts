/**
 * Очередь статей. Статья — сама строка очереди (Article.status/stage/leaseUntil/workerId).
 * Захват атомарный: кандидаты блокируются FOR UPDATE SKIP LOCKED, лимиты сайта по фазам считаются
 * в той же транзакции, затем UPDATE … WHERE status='PENDING' гарантирует одного владельца.
 *
 * Лимиты (перенос auto_photo_enabled / auto_writing_enabled / max_*_concurrent оригинала):
 *  - цепочка «фото» и цепочка «написание» включаются и ограничиваются отдельно на каждом сайте (ArtSite.settings.autostart);
 *  - публикация — свой лимит;
 *  - глобальный потолок одновременных статей — ARTICLES_WORKER_CONCURRENCY (цикл воркера).
 */
import { prisma } from "@/lib/db";
import type { Article } from "@prisma/client";
import { mergeSiteSettings } from "@/lib/articles/types";
import { phaseOf, stagesOfPhase, type StagePhase } from "@/lib/articles/stages";
import { log } from "../log";

export const LEASE_SECONDS = 180;
export const MAX_ATTEMPTS = 5;

type SiteCache = Map<string, { enabled: Record<StagePhase, boolean>; limit: Record<StagePhase, number> }>;

async function siteRules(tx: { artSite: typeof prisma.artSite }, siteId: string, cache: SiteCache) {
  const hit = cache.get(siteId);
  if (hit) return hit;
  const site = await tx.artSite.findUnique({ where: { id: siteId }, select: { settings: true, isActive: true } });
  const s = mergeSiteSettings(site?.settings);
  const r = {
    enabled: { photos: !!site?.isActive && s.autostart.photoEnabled, writing: !!site?.isActive && s.autostart.writingEnabled, publish: !!site?.isActive },
    limit: { photos: Math.max(1, s.autostart.photoLimit), writing: Math.max(1, s.autostart.writingLimit), publish: Math.max(1, s.autostart.publishLimit) },
  };
  cache.set(siteId, r);
  return r;
}

export async function claimArticle(workerId: string): Promise<Article | null> {
  return prisma.$transaction(
    async (tx) => {
      const cand = await tx.$queryRaw<Array<{ id: string; siteId: string; stage: string }>>`
        SELECT id, siteId, stage FROM Article
        WHERE status = 'PENDING' AND (nextRunAt IS NULL OR nextRunAt <= NOW(3))
        ORDER BY priority DESC, createdAt ASC
        LIMIT 60 FOR UPDATE SKIP LOCKED`;
      const cache: SiteCache = new Map();
      // Написание приоритетнее поиска фото (оригинал: priority writing над photo), иначе по порядку очереди.
      cand.sort((a, b) => rank(phaseOf(a.stage)) - rank(phaseOf(b.stage)));
      for (const c of cand) {
        const phase = phaseOf(c.stage);
        const rules = await siteRules(tx, c.siteId, cache);
        if (!rules.enabled[phase]) continue;
        const running = await tx.article.count({ where: { siteId: c.siteId, status: "RUNNING", stage: { in: stagesOfPhase(phase) }, leaseUntil: { gt: new Date() } } });
        if (running >= rules.limit[phase]) continue;
        const r = await tx.$executeRaw`
          UPDATE Article SET status = 'RUNNING', workerId = ${workerId}, leaseUntil = DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND),
                 attempts = attempts + 1, startedAt = COALESCE(startedAt, NOW(3)), error = NULL, errorStage = NULL
          WHERE id = ${c.id} AND status = 'PENDING'`;
        if (r === 1) return tx.article.findUniqueOrThrow({ where: { id: c.id } });
      }
      return null;
    },
    { isolationLevel: "ReadCommitted", timeout: 20_000 },
  );
}

function rank(p: StagePhase): number {
  return p === "publish" ? 0 : p === "writing" ? 1 : 2;
}

/** Продлить аренду; сообщает, что статью просили остановить или её забрал другой воркер. */
export async function renewLease(articleId: string, workerId: string): Promise<{ stopping: boolean; lost: boolean }> {
  const rows = await prisma.$queryRaw<Array<{ workerId: string | null; stopRequested: number | boolean; status: string }>>`SELECT workerId, stopRequested, status FROM Article WHERE id = ${articleId}`;
  const row = rows[0];
  if (!row || row.workerId !== workerId || row.status !== "RUNNING") return { stopping: true, lost: true };
  await prisma.$executeRaw`UPDATE Article SET leaseUntil = DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND) WHERE id = ${articleId} AND workerId = ${workerId}`;
  return { stopping: !!row.stopRequested, lost: false };
}

/** Вернуть в очередь (временный сбой или мягкая остановка воркера). */
export async function releaseArticle(articleId: string, delayMs = 0, note?: string) {
  await prisma.article.update({ where: { id: articleId }, data: { status: "PENDING", workerId: null, leaseUntil: null, nextRunAt: new Date(Date.now() + delayMs), note: note ?? undefined } });
}

/** Статьи, чей воркер умер: lease истёк, статус всё ещё RUNNING. */
export async function requeueStaleArticles(): Promise<number> {
  const stale = await prisma.article.findMany({ where: { status: "RUNNING", leaseUntil: { lt: new Date() } }, select: { id: true, attempts: true, stage: true, stopRequested: true } });
  let n = 0;
  for (const a of stale) {
    if (a.stopRequested) {
      await prisma.article.update({ where: { id: a.id }, data: { status: "STOPPED", workerId: null, leaseUntil: null, stopRequested: false } });
      continue;
    }
    if (a.attempts >= MAX_ATTEMPTS) {
      await prisma.article.update({ where: { id: a.id }, data: { status: "FAILED", workerId: null, leaseUntil: null, error: `Воркер несколько раз прерывался на этапе «${a.stage}»`, errorStage: a.stage } });
      log.warn(`article ${a.id} given up after ${a.attempts} attempts`);
    } else {
      await prisma.article.update({ where: { id: a.id }, data: { status: "PENDING", workerId: null, leaseUntil: null, nextRunAt: new Date() } });
      n++;
    }
  }
  if (n) log.info(`articles: requeued ${n} stale`);
  return n;
}

/** На старте воркера: статьи предыдущего процесса этого хоста — сразу в очередь. */
export async function requeueOrphanArticles(hostPrefix: string): Promise<number> {
  const r = await prisma.$executeRaw`
    UPDATE Article SET status = 'PENDING', workerId = NULL, leaseUntil = NULL, nextRunAt = NOW(3)
    WHERE status = 'RUNNING' AND workerId LIKE ${hostPrefix + "-%"}`;
  if (r) log.info(`articles: requeued ${r} orphaned`);
  return r;
}
