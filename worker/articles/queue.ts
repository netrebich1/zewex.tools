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
 *  - кандидаты выбираются только из «открытых» пар сайт × фаза (сайт активен, фаза включена, лимит не занят) и не больше
 *    CANDIDATES_PER_STAGE на сайт и этап (оконная функция) — раньше брались 60 старейших PENDING без фильтра, и сотни статей
 *    одного закрытого сайта останавливали очередь всех остальных (аудит 2026-10-14, stability §1.2).
 */
import { prisma } from "@/lib/db";
import { Prisma, type Article } from "@prisma/client";
import { mergeSiteSettings } from "@/lib/articles/types";
import { phaseOf, stagesOfPhase, type StagePhase } from "@/lib/articles/stages";
import { markArticleStatus } from "@/lib/articles/sheets";
import { stageLabel } from "@/lib/articles/stages";
import { recordError } from "./journal";
import { log } from "../log";

export const LEASE_SECONDS = 180;
/**
 * Сколько раз подряд воркер может прерваться на одном этапе статьи (падение процесса, OOM, потеря аренды), прежде чем
 * статья станет ошибкой. Плановые повторы и мягкая остановка воркера попытку возвращают (releaseArticle refund),
 * поэтому деплои и временные сбои этот счётчик не тратят; серия повторов этапа считается по журналу (journal.ts).
 */
export const MAX_ATTEMPTS = 5;

type SiteRules = { enabled: Record<StagePhase, boolean>; limit: Record<StagePhase, number> };
const PHASES: StagePhase[] = ["photos", "writing", "publish"];
/** Сколько кандидатов одного сайта на один этап попадает в окно захвата. */
const CANDIDATES_PER_STAGE = 3;
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

function siteRules(site: { settings: unknown; isActive: boolean }, g: GlobalRules): SiteRules {
  const s = mergeSiteSettings(site.settings);
  return {
    enabled: {
      photos: site.isActive && g.enabled.photos && s.autostart.photoEnabled,
      writing: site.isActive && g.enabled.writing && s.autostart.writingEnabled,
      publish: site.isActive && g.enabled.publish,
    },
    limit: { photos: Math.max(1, s.autostart.photoLimit), writing: Math.max(1, s.autostart.writingLimit), publish: Math.max(1, s.autostart.publishLimit) },
  };
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
  // Дешёвая проверка без транзакции: то же базовое условие, что у выборки кандидатов ниже (надмножество) — пустая очередь не открывает транзакцию.
  const any = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM Article WHERE status = 'PENDING' AND (nextRunAt IS NULL OR nextRunAt <= NOW(3)) LIMIT 1`;
  if (!any.length) return null;
  return prisma.$transaction(
    async (tx) => {
      const g = await globalRules(tx);
      // Снимок бегущих статей с живой арендой: общий потолок, лимиты фаз и round-robin по сайтам считаются по нему.
      const runningRows = await tx.article.groupBy({ by: ["siteId", "stage"], where: { status: "RUNNING", leaseUntil: { gt: new Date() } }, _count: { _all: true } });
      const runningBySite = new Map<string, number>();
      const phaseRunning = new Map<string, number>();
      let runningTotal = 0;
      for (const r of runningRows) {
        const n = r._count._all;
        runningTotal += n;
        runningBySite.set(r.siteId, (runningBySite.get(r.siteId) ?? 0) + n);
        const pk = `${r.siteId}:${phaseOf(r.stage)}`;
        phaseRunning.set(pk, (phaseRunning.get(pk) ?? 0) + n);
      }
      if (g.maxConcurrent > 0 && runningTotal >= g.maxConcurrent) return null;

      // Открытые пары сайт × фаза: сайт активен, фаза включена (сайт и мастер-выключатель), лимит не занят.
      const sites = await tx.artSite.findMany({ where: { isActive: true }, select: { id: true, settings: true, isActive: true } });
      const rulesBySite = new Map<string, SiteRules>();
      const open: Prisma.Sql[] = [];
      for (const site of sites) {
        const rules = siteRules(site, g);
        rulesBySite.set(site.id, rules);
        for (const phase of PHASES) {
          if (!rules.enabled[phase] || (phaseRunning.get(`${site.id}:${phase}`) ?? 0) >= rules.limit[phase]) continue;
          open.push(Prisma.sql`(siteId = ${site.id} AND stage IN (${Prisma.join(stagesOfPhase(phase))}))`);
        }
      }
      if (!open.length) return null;

      // Окно: не больше CANDIDATES_PER_STAGE на сайт и этап, затем общий порядок очереди. Без блокировок —
      // блокируем ниже только выбранные строки; единственного владельца гарантирует UPDATE … WHERE status='PENDING'.
      const picked = await tx.$queryRaw<Cand[]>`
        SELECT id, siteId, stage FROM (
          SELECT id, siteId, stage, priority, createdAt,
                 ROW_NUMBER() OVER (PARTITION BY siteId, stage ORDER BY priority DESC, createdAt ASC) AS rn
          FROM Article
          WHERE status = 'PENDING' AND (nextRunAt IS NULL OR nextRunAt <= NOW(3)) AND (${Prisma.join(open, " OR ")})
        ) t
        WHERE rn <= ${CANDIDATES_PER_STAGE}
        ORDER BY priority DESC, createdAt ASC
        LIMIT 60`;
      if (!picked.length) return null;
      const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM Article WHERE id IN (${Prisma.join(picked.map((c) => c.id))}) AND status = 'PENDING' FOR UPDATE SKIP LOCKED`;
      const locked = new Set(lockedRows.map((r) => r.id));
      const cand = picked.filter((c) => locked.has(c.id));

      for (const c of orderCandidates(cand, runningBySite)) {
        const phase = phaseOf(c.stage);
        const rules = rulesBySite.get(c.siteId);
        if (!rules || !rules.enabled[phase]) continue;
        if ((phaseRunning.get(`${c.siteId}:${phase}`) ?? 0) >= rules.limit[phase]) continue;
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
export async function renewLease(articleId: string, workerId: string, opts: { extend?: boolean } = {}): Promise<{ stopping: boolean; lost: boolean }> {
  const rows = await prisma.$queryRaw<Array<{ workerId: string | null; stopRequested: number | boolean; status: string }>>`SELECT workerId, stopRequested, status FROM Article WHERE id = ${articleId}`;
  const row = rows[0];
  if (!row || row.workerId !== workerId || row.status !== "RUNNING") return { stopping: true, lost: true };
  // extend=false — только проверка остановки и владельца: аренду недавно продлили (троттлинг в tick раннера).
  if (opts.extend !== false) await prisma.$executeRaw`UPDATE Article SET leaseUntil = DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND) WHERE id = ${articleId} AND workerId = ${workerId}`;
  return { stopping: !!row.stopRequested, lost: false };
}

/**
 * Вернуть в очередь (временный сбой, плановый повтор или мягкая остановка воркера).
 * refund — вернуть попытку, потраченную захватом: attempts считает только прерывания воркера.
 * workerId — отпускать, только если статья всё ещё наша (её могли забрать сторож и другой воркер).
 */
export async function releaseArticle(articleId: string, delayMs = 0, note?: string, opts: { refund?: boolean; workerId?: string } = {}) {
  await prisma.article.updateMany({
    where: { id: articleId, status: "RUNNING", ...(opts.workerId ? { workerId: opts.workerId } : {}) },
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

/** Статья прерывалась слишком часто — окончательная ошибка (на публикации — PUBLISH_ERROR) с записью в журнал ошибок. */
async function giveUpInterrupted(a: { id: string; teamId: string; siteId: string; attempts: number; stage: string; sheetRow: number | null }) {
  const status = a.stage === "publish" ? "PUBLISH_ERROR" : "FAILED";
  const error = `Воркер прерывался ${a.attempts} раз подряд на этапе «${stageLabel(a.stage)}» (падение процесса или нехватка памяти). Нажмите «Повторить»; если повторится — сообщите разработчику.`;
  await prisma.article.update({ where: { id: a.id }, data: { status, workerId: null, leaseUntil: null, error, errorStage: a.stage, note: null } });
  await recordError({ teamId: a.teamId, siteId: a.siteId, articleId: a.id, stage: a.stage, message: error, code: "interrupted", human: "воркер прерывался" });
  log.warn(`article ${a.id} given up after ${a.attempts} interruptions`);
  if (a.sheetRow) void markArticleStatus(a.id, "error").catch(() => {});
}

const STALE_SELECT = { id: true, teamId: true, siteId: true, attempts: true, stage: true, stopRequested: true, sheetRow: true } as const;

/** Статьи, чей воркер умер: lease истёк, статус всё ещё RUNNING. */
export async function requeueStaleArticles(): Promise<number> {
  const stale = await prisma.article.findMany({ where: { status: "RUNNING", leaseUntil: { lt: new Date() } }, select: STALE_SELECT });
  let n = 0;
  for (const a of stale) {
    if (a.stopRequested) {
      await prisma.article.update({ where: { id: a.id }, data: { status: "STOPPED", workerId: null, leaseUntil: null, stopRequested: false } });
      continue;
    }
    if (a.attempts >= MAX_ATTEMPTS) {
      await giveUpInterrupted(a);
    } else {
      await prisma.article.update({ where: { id: a.id }, data: { status: "PENDING", workerId: null, leaseUntil: null, nextRunAt: new Date() } });
      n++;
    }
  }
  if (n) log.info(`articles: requeued ${n} stale`);
  return n;
}

/**
 * На старте воркера: статьи предыдущего процесса этого хоста — сразу в очередь. Мягкая остановка их уже отпустила,
 * поэтому здесь только упавшие процессы; статья, на которой процесс падает раз за разом, не крутится вечно.
 */
export async function requeueOrphanArticles(hostPrefix: string): Promise<number> {
  const rows = await prisma.article.findMany({ where: { status: "RUNNING", workerId: { startsWith: `${hostPrefix}-` } }, select: STALE_SELECT });
  let n = 0;
  for (const a of rows) {
    if (a.stopRequested) {
      await prisma.article.update({ where: { id: a.id }, data: { status: "STOPPED", workerId: null, leaseUntil: null, stopRequested: false } });
      continue;
    }
    if (a.attempts >= MAX_ATTEMPTS) {
      await giveUpInterrupted(a);
      continue;
    }
    await prisma.article.update({ where: { id: a.id }, data: { status: "PENDING", workerId: null, leaseUntil: null, nextRunAt: new Date() } });
    n++;
  }
  if (n) log.info(`articles: requeued ${n} orphaned`);
  return n;
}
