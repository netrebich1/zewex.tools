/**
 * Очередь статей. Статья — сама строка очереди (Article.status/stage/leaseUntil/workerId).
 * Захват атомарный: кандидаты блокируются FOR UPDATE SKIP LOCKED, лимиты сайта по фазам считаются
 * в той же транзакции, затем UPDATE … WHERE status='PENDING' гарантирует одного владельца.
 *
 * Лимиты (перенос auto_photo_enabled / auto_writing_enabled / max_*_concurrent оригинала, queue-orchestrator:779-805):
 *  - цепочка «фото» и цепочка «написание» включаются и ограничиваются отдельно на каждом сайте (ArtSite.settings.autostart);
 *  - публикация — свой лимит;
 *  - мастер-выключатели ArtSettings (photoMaster/writingMaster/publishMaster) гасят фазу на всех сайтах сразу;
 *  - ArtSettings.maxConcurrent > 0 — потолок RUNNING по всем статьям (оригинал: globalCap); 0 — только ARTICLES_WORKER_CONCURRENCY (цикл воркера);
 *  - round-robin по сайтам: сначала по одному кандидату с каждого сайта (сайты с меньшим числом бегущих статей — раньше),
 *    второй кандидат того же сайта — только когда кандидаты других сайтов исчерпаны (оригинал: «берём по каждому сайту»).
 */
import { prisma } from "@/lib/db";
import type { Article, Prisma } from "@prisma/client";
import { mergeSiteSettings } from "@/lib/articles/types";
import { phaseOf, stagesOfPhase, type StagePhase } from "@/lib/articles/stages";
import { markArticleStatus } from "@/lib/articles/sheets";
import { log } from "../log";

export const LEASE_SECONDS = 180;
export const MAX_ATTEMPTS = 5;

type SiteCache = Map<string, { enabled: Record<StagePhase, boolean>; limit: Record<StagePhase, number> }>;
type Tx = Prisma.TransactionClient;

type GlobalRules = { enabled: Record<StagePhase, boolean>; maxConcurrent: number };

/** Мастер-выключатели и общий потолок (ArtSettings id="main"); нет строки — всё включено, потолка нет. */
async function globalRules(tx: Tx): Promise<GlobalRules> {
  const g = await tx.artSettings.findUnique({ where: { id: "main" }, select: { photoMaster: true, writingMaster: true, publishMaster: true, maxConcurrent: true } });
  return {
    enabled: { photos: g?.photoMaster ?? true, writing: g?.writingMaster ?? true, publish: g?.publishMaster ?? true },
    maxConcurrent: g?.maxConcurrent ?? 0,
  };
}

async function siteRules(tx: Tx, siteId: string, cache: SiteCache, g: GlobalRules) {
  const hit = cache.get(siteId);
  if (hit) return hit;
  const site = await tx.artSite.findUnique({ where: { id: siteId }, select: { settings: true, isActive: true } });
  const s = mergeSiteSettings(site?.settings);
  const r = {
    enabled: {
      photos: !!site?.isActive && g.enabled.photos && s.autostart.photoEnabled,
      writing: !!site?.isActive && g.enabled.writing && s.autostart.writingEnabled,
      publish: !!site?.isActive && g.enabled.publish,
    },
    limit: { photos: Math.max(1, s.autostart.photoLimit), writing: Math.max(1, s.autostart.writingLimit), publish: Math.max(1, s.autostart.publishLimit) },
  };
  cache.set(siteId, r);
  return r;
}

type Cand = { id: string; siteId: string; stage: string };

/**
 * Порядок перебора кандидатов: написание раньше фото (оригинал: priority writing над photo), затем round-robin по сайтам —
 * первый кандидат каждого сайта раньше вторых; сайты с меньшим числом бегущих статей идут раньше; внутри — порядок очереди.
 */
export function orderCandidates(cand: Cand[], runningBySite: Map<string, number>): Cand[] {
  const seen = new Map<string, number>();
  return cand
    .map((c, idx) => {
      const key = `${c.siteId}:${phaseOf(c.stage)}`;
      const round = seen.get(key) ?? 0;
      seen.set(key, round + 1);
      return { c, idx, rank: rank(phaseOf(c.stage)), round, running: runningBySite.get(c.siteId) ?? 0 };
    })
    .sort((a, b) => a.rank - b.rank || a.round - b.round || a.running - b.running || a.idx - b.idx)
    .map((x) => x.c);
}

export async function claimArticle(workerId: string): Promise<Article | null> {
  return prisma.$transaction(
    async (tx) => {
      const cand = await tx.$queryRaw<Cand[]>`
        SELECT id, siteId, stage FROM Article
        WHERE status = 'PENDING' AND (nextRunAt IS NULL OR nextRunAt <= NOW(3))
        ORDER BY priority DESC, createdAt ASC
        LIMIT 60 FOR UPDATE SKIP LOCKED`;
      if (!cand.length) return null;

      const g = await globalRules(tx);
      // Снимок бегущих статей с живой арендой: общий потолок и round-robin по сайтам считаются по нему.
      const runningRows = await tx.article.groupBy({ by: ["siteId"], where: { status: "RUNNING", leaseUntil: { gt: new Date() } }, _count: { _all: true } });
      const runningBySite = new Map(runningRows.map((r) => [r.siteId, r._count._all]));
      const runningTotal = runningRows.reduce((a, r) => a + r._count._all, 0);
      if (g.maxConcurrent > 0 && runningTotal >= g.maxConcurrent) return null;

      const cache: SiteCache = new Map();
      const phaseRunning = new Map<string, number>();
      for (const c of orderCandidates(cand, runningBySite)) {
        const phase = phaseOf(c.stage);
        const rules = await siteRules(tx, c.siteId, cache, g);
        if (!rules.enabled[phase]) continue;
        const pk = `${c.siteId}:${phase}`;
        let running = phaseRunning.get(pk);
        if (running === undefined) {
          running = await tx.article.count({ where: { siteId: c.siteId, status: "RUNNING", stage: { in: stagesOfPhase(phase) }, leaseUntil: { gt: new Date() } } });
          phaseRunning.set(pk, running);
        }
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
  const stale = await prisma.article.findMany({ where: { status: "RUNNING", leaseUntil: { lt: new Date() } }, select: { id: true, attempts: true, stage: true, stopRequested: true, sheetRow: true } });
  let n = 0;
  for (const a of stale) {
    if (a.stopRequested) {
      await prisma.article.update({ where: { id: a.id }, data: { status: "STOPPED", workerId: null, leaseUntil: null, stopRequested: false } });
      continue;
    }
    if (a.attempts >= MAX_ATTEMPTS) {
      await prisma.article.update({ where: { id: a.id }, data: { status: "FAILED", workerId: null, leaseUntil: null, error: `Воркер несколько раз прерывался на этапе «${a.stage}»`, errorStage: a.stage } });
      log.warn(`article ${a.id} given up after ${a.attempts} attempts`);
      if (a.sheetRow) void markArticleStatus(a.id, "error").catch(() => {});
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
