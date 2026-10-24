/**
 * Очередь инфо-статей. Пост — сама строка очереди (BlogPost.status/stage/leaseUntil/workerId).
 * Захват атомарный: кандидаты блокируются FOR UPDATE SKIP LOCKED, лимит сайта (BlogSiteSettings.concurrency) и общий
 * потолок (BlogSettings.maxConcurrent, мастер-выключатель) считаются в той же транзакции, UPDATE … WHERE status='PENDING'
 * гарантирует одного владельца. Round-robin по сайтам: первый кандидат каждого сайта раньше вторых.
 */
import { prisma } from "@/lib/db";
import { Prisma, type BlogPost } from "@prisma/client";
import { mergeSiteSettings } from "@/lib/blog/types";
import { stageLabel } from "@/lib/blog/stages";
import { recordError } from "./journal";
import { log } from "../log";

export const LEASE_SECONDS = 180;
/** Сколько раз подряд воркер может прерваться на одном этапе поста, прежде чем пост станет ошибкой. */
export const MAX_ATTEMPTS = 5;
const CANDIDATES_PER_SITE = 3;

type Cand = { id: string; siteId: string };

export function orderCandidates(cand: Cand[], runningBySite: Map<string, number>): Cand[] {
  const seen = new Map<string, number>();
  return cand
    .map((c, idx) => {
      const round = seen.get(c.siteId) ?? 0;
      seen.set(c.siteId, round + 1);
      return { c, idx, round, running: runningBySite.get(c.siteId) ?? 0 };
    })
    .sort((a, b) => a.round - b.round || a.running - b.running || a.idx - b.idx)
    .map((x) => x.c);
}

export async function claimPost(workerId: string): Promise<BlogPost | null> {
  // Дешёвая проверка без транзакции: то же базовое условие, что у выборки кандидатов ниже (надмножество) — пустая очередь не открывает транзакцию.
  const any = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM BlogPost WHERE status = 'PENDING' AND (nextRunAt IS NULL OR nextRunAt <= NOW(3)) LIMIT 1`;
  if (!any.length) return null;
  return prisma.$transaction(
    async (tx) => {
      const g = await tx.blogSettings.findUnique({ where: { id: "main" }, select: { master: true, maxConcurrent: true } });
      if (g && !g.master) return null;
      const runningRows = await tx.blogPost.groupBy({ by: ["siteId"], where: { status: "RUNNING", leaseUntil: { gt: new Date() } }, _count: { _all: true } });
      const runningBySite = new Map<string, number>();
      let runningTotal = 0;
      for (const r of runningRows) { runningBySite.set(r.siteId, r._count._all); runningTotal += r._count._all; }
      if ((g?.maxConcurrent ?? 0) > 0 && runningTotal >= (g?.maxConcurrent ?? 0)) return null;

      const sites = await tx.blogSite.findMany({ where: { isActive: true }, select: { id: true, settings: true } });
      const limitBySite = new Map<string, number>();
      const open: string[] = [];
      for (const site of sites) {
        const limit = mergeSiteSettings(site.settings).concurrency;
        limitBySite.set(site.id, limit);
        if ((runningBySite.get(site.id) ?? 0) < limit) open.push(site.id);
      }
      if (!open.length) return null;

      const picked = await tx.$queryRaw<Cand[]>`
        SELECT id, siteId FROM (
          SELECT id, siteId, priority, createdAt,
                 ROW_NUMBER() OVER (PARTITION BY siteId ORDER BY priority DESC, createdAt ASC) AS rn
          FROM BlogPost
          WHERE status = 'PENDING' AND (nextRunAt IS NULL OR nextRunAt <= NOW(3)) AND siteId IN (${Prisma.join(open)})
        ) t
        WHERE rn <= ${CANDIDATES_PER_SITE}
        ORDER BY priority DESC, createdAt ASC
        LIMIT 60`;
      if (!picked.length) return null;
      const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM BlogPost WHERE id IN (${Prisma.join(picked.map((c) => c.id))}) AND status = 'PENDING' FOR UPDATE SKIP LOCKED`;
      const locked = new Set(lockedRows.map((r) => r.id));
      const cand = picked.filter((c) => locked.has(c.id));

      for (const c of orderCandidates(cand, runningBySite)) {
        if ((runningBySite.get(c.siteId) ?? 0) >= (limitBySite.get(c.siteId) ?? 1)) continue;
        const r = await tx.$executeRaw`
          UPDATE BlogPost SET status = 'RUNNING', workerId = ${workerId}, leaseUntil = DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND),
                 attempts = attempts + 1, startedAt = COALESCE(startedAt, NOW(3)), error = NULL, errorStage = NULL
          WHERE id = ${c.id} AND status = 'PENDING'`;
        if (r === 1) return tx.blogPost.findUniqueOrThrow({ where: { id: c.id } });
      }
      return null;
    },
    { isolationLevel: "ReadCommitted", timeout: 20_000 },
  );
}

/** Продлить аренду; сообщает, что пост просили остановить или его забрал другой воркер. */
export async function renewLease(postId: string, workerId: string, opts: { extend?: boolean } = {}): Promise<{ stopping: boolean; lost: boolean }> {
  const rows = await prisma.$queryRaw<Array<{ workerId: string | null; stopRequested: number | boolean; status: string }>>`SELECT workerId, stopRequested, status FROM BlogPost WHERE id = ${postId}`;
  const row = rows[0];
  if (!row || row.workerId !== workerId || row.status !== "RUNNING") return { stopping: true, lost: true };
  // extend=false — только проверка остановки и владельца: аренду недавно продлили (троттлинг в tick раннера).
  if (opts.extend !== false) await prisma.$executeRaw`UPDATE BlogPost SET leaseUntil = DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND) WHERE id = ${postId} AND workerId = ${workerId}`;
  return { stopping: !!row.stopRequested, lost: false };
}

/** Вернуть в очередь (временный сбой, плановый повтор или мягкая остановка воркера). */
export async function releasePost(postId: string, delayMs = 0, note?: string, opts: { refund?: boolean; workerId?: string } = {}) {
  await prisma.blogPost.updateMany({
    where: { id: postId, status: "RUNNING", ...(opts.workerId ? { workerId: opts.workerId } : {}) },
    data: {
      status: "PENDING",
      workerId: null,
      leaseUntil: null,
      nextRunAt: new Date(Date.now() + delayMs),
      ...(note !== undefined ? { note } : {}),
      ...(opts.refund ? { attempts: { decrement: 1 } } : {}),
    },
  });
}

async function giveUpInterrupted(a: { id: string; teamId: string; siteId: string; attempts: number; stage: string }) {
  const status = a.stage === "publish" ? "PUBLISH_ERROR" : "FAILED";
  const error = `Воркер прерывался ${a.attempts} раз подряд на этапе «${stageLabel(a.stage)}» (падение процесса или нехватка памяти). Нажмите «Повторить»; если повторится — сообщите разработчику.`;
  await prisma.blogPost.update({ where: { id: a.id }, data: { status, workerId: null, leaseUntil: null, error, errorStage: a.stage, note: null } });
  await recordError({ teamId: a.teamId, siteId: a.siteId, postId: a.id, stage: a.stage, message: error, code: "interrupted", human: "воркер прерывался" });
  log.warn(`blog post ${a.id} given up after ${a.attempts} interruptions`);
}

const STALE_SELECT = { id: true, teamId: true, siteId: true, attempts: true, stage: true, stopRequested: true } as const;

/** Посты, чей воркер умер: lease истёк, статус всё ещё RUNNING. */
export async function requeueStalePosts(): Promise<number> {
  const stale = await prisma.blogPost.findMany({ where: { status: "RUNNING", leaseUntil: { lt: new Date() } }, select: STALE_SELECT });
  let n = 0;
  for (const a of stale) {
    if (a.stopRequested) {
      await prisma.blogPost.update({ where: { id: a.id }, data: { status: "STOPPED", workerId: null, leaseUntil: null, stopRequested: false } });
      continue;
    }
    if (a.attempts >= MAX_ATTEMPTS) await giveUpInterrupted(a);
    else {
      await prisma.blogPost.update({ where: { id: a.id }, data: { status: "PENDING", workerId: null, leaseUntil: null, nextRunAt: new Date() } });
      n++;
    }
  }
  if (n) log.info(`blog: requeued ${n} stale`);
  return n;
}

/** На старте воркера: посты предыдущего процесса этого хоста — сразу в очередь. */
export async function requeueOrphanPosts(hostPrefix: string): Promise<number> {
  const rows = await prisma.blogPost.findMany({ where: { status: "RUNNING", workerId: { startsWith: `${hostPrefix}-` } }, select: STALE_SELECT });
  let n = 0;
  for (const a of rows) {
    if (a.stopRequested) {
      await prisma.blogPost.update({ where: { id: a.id }, data: { status: "STOPPED", workerId: null, leaseUntil: null, stopRequested: false } });
      continue;
    }
    if (a.attempts >= MAX_ATTEMPTS) { await giveUpInterrupted(a); continue; }
    await prisma.blogPost.update({ where: { id: a.id }, data: { status: "PENDING", workerId: null, leaseUntil: null, nextRunAt: new Date() } });
    n++;
  }
  if (n) log.info(`blog: requeued ${n} orphaned`);
  return n;
}
