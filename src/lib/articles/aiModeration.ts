/**
 * ИИ-модерация фото (режим 2 оригинала, шаг 140 «ИИ публикация статей»).
 * Порт `supabase/functions/ai-photo-moderate/index.ts`: запуск по сайту, проверка mix3 (дешёвая vision-модель
 * «тема/подлинность» + средняя «мнение редактора» параллельно, второй запрос средней только при реальном споре),
 * вердикт из фактов, применение решения через те же функции, что и ручная модерация (`./moderation.ts`, актор ИИ).
 *
 * Отличия от оригинала (по 08-plan §3 и README правил):
 *  - нет лимита времени функции: никаких chain/waitUntil/дедлайнов 100 с — воркер (`worker/articles/aiModeration.ts`)
 *    ведёт запуск сам; этот модуль — чистая логика и запросы к базе;
 *  - состав запуска — не массив queue_ids, а `Article.aiRunId = run.id` (захват статьи запуском; оригинал: claim на 30 дней);
 *  - картинки модели отдаются как data-URL из наших миниатюр (`thumbPath`, sharp ≤512 px), а не через images.weserv.nl;
 *  - эталонов (photo_reference_set) нет — блок QUALITY BAR не формируется;
 *  - режимы mix2/legacy не перенесены — только mix3 (значение `ArtAiModerationRun.model` по умолчанию);
 *  - в режиме «людям» снятые ИИ фото не удаляются, а помечаются `ArtPhoto.excluded/excludedByAi` — модератор видит
 *    пометки ✕ и может вернуть кадр («Отменить»); при одобрении человеком они удаляются как обычно;
 *  - ключи ИИ — через `aiChat` (слот vision) от имени пользователя, запустившего проверку (авто — владелец сайта).
 *
 * mix3.3 (аудит круга 2, docs/articles-migration/audit-2026-10-14/ai-moderation-fixes-v3.md): третий дешёвый проход
 * «крупно» (водяные знаки и признаки ИИ на увеличенных половинах кадра), фотореалистичный ИИ в `ai_fake`, аудитория —
 * только главный герой, спор видит уже убранные фото и перепроверяет оставленные «по аналогии».
 *
 * mix3.4 (аудит круга 3, docs/articles-migration/audit-2026-10-14/ai-moderation-fixes-v4.md): без перепроверки
 * «по аналогии», резерв в основных проходах — 10 кандидатов (ещё 10 отдельным маленьким вызовом, только если норма
 * не набирается), «крупно» по резерву — только для выбранных добавлений и 2 запасных, в «крупно» нет вопроса про ИИ.
 * passCosts = [lite, flash, спор, смысл ключа, крупно (статья + резерв), досылка резерва (lite + flash)].
 */
import { readFile } from "fs/promises";
import sharp from "sharp";
import { Prisma, type ArtStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { seesTeamCosts } from "@/lib/permissions";
import { AiError } from "@/lib/pins/ai/errors";
import { parseJsonLenient } from "@/lib/pins/ai/json";
import { artSiteWhere, canAccessArtSite } from "./access";
import { aiChat, articleCost, imagePart, type AiCtx, type ContentPart } from "./ai";
import { ageRule, audienceRule, genderRule } from "./photo/audience";
import { resolveTrendBrief, trendBriefText } from "./photo/vision";
import { absPath, publicUrl } from "./storage";
import { loadArtSettings } from "./automation";
import { addFromReserve, aiActor, approvePhotos, closeArticle, excludePhoto, markInsufficient, ModerationError, reorderPhotos, requestTopup, returnToReview, type AiActor } from "./moderation";
import { CLAIM_TTL_MIN, MIN_PHOTOS, mergeSiteSettings, SLOTS, type ArticleFacts, type ArticleRecipeSnapshot } from "./types";
import { classifyArticlePhotos, completeVisual, judgementsOf, KEYWORD_VISUAL_SYSTEM, KEYWORD_VISUAL_VERSION, keywordVisualRule, knownVisual, literalVisual, mergeDetailFlags, orderFinal, parseDetailFlags, parseDispute, parseKeywordVisual, pickAdds, removalsNeedConfirm, reserveZoomTargets, resolveDisputes, scoreOf, verdictFrom, type DetailFlags, type DisputeAnswer, type Judgements, type PickResult } from "./aiModerationRules";

/* ───────────────────────── Константы (оригинал: ai-photo-moderate/index.ts:13-18, 248, 270) ───────────────────────── */

/** Модели mix3: дешёвая lite для проверки темы, flash — «мнение редактора» и споры (оригинал :13, :485). */
export const AI_MOD_MODELS = { lite: "openrouter:google/gemini-2.5-flash-lite", flash: "openrouter:google/gemini-3-flash-preview" } as const;
/** Режим «Авто»: увереннее — применяем сразу, иначе людям (оригинал :16). */
export const AUTO_CONFIDENCE = 75;
/** Резерв для модели: ≤25 одобренных оценкой + ≤15 отклонённых без жёстких причин (оригинал :17). */
export const RESERVE_KEEP = 25;
export const RESERVE_REJECT = 15;
/** Предел добавлений за проверку; фактический предел — 60 фото в статье (`overNormCap` в ./aiModerationRules.ts). */
export const MAX_ADDS = 40;
/** Причины отклонения, с которыми кандидат не предлагается резервом (оригинал :18 + водяные знаки/логотипы). */
export const HARD_REJECT = /фигур|комплекц|body type|slim|ai[- ]?generat|render|cgi|illustrat|cartoon|drawing|audience|gender|\bmen\b|male|child|kid|off[- ]?topic|не по теме|аудитор|мужск|детск|watermark|logo|водян|логотип/i;
/** Зависшая обработка (упавший воркер) возвращается в пул (оригинал :270). */
export const STALE_PROCESSING_MS = 6 * 60_000;
/** Применение без heartbeat дольше 3 мин → снова proposed (оригинал watchdog :50-56). */
export const STALE_APPLYING_MS = 3 * 60_000;
/** «Запуск от» > 1: неполная пачка всё равно уходит, если самая старая статья ждёт дольше (оригинал :81). При «Запуск от» = 1 не ждём. */
export const AUTO_WAIT_MS = 30 * 60_000;
/** Миниатюра для модели: ≤512 px по длинной стороне (бриф; оригинал — weserv 256 px). */
export const AI_THUMB_SIDE = 512;
/**
 * Проход «крупно» (аудит круга 2: мелкие водяные знаки и фотореалистичный ИИ не видны на превью 512 px с detail low):
 * кадр приводится к 1152 px по длинной стороне и режется на две половины с перекрытием (55% каждая), каждая ≤768 px —
 * одна плитка Gemini (~258 токенов), то есть вдвое больше деталей на тот же токен. Только дешёвая модель (lite).
 */
export const AI_DETAIL_SIDE = 1152;
export const AI_DETAIL_PART = 768;
export const AI_DETAIL_SHARE = 0.55;
/**
 * Резерв в основных проходах lite и flash (аудит круга 3: из 15 добавлялось в среднем 3, а резерв — треть всех кадров
 * flash). Если норма не набирается — ещё RESERVE_MORE кандидатов отдельным маленьким вызовом обеих моделей.
 */
export const RESERVE_FIRST = 20;
export const RESERVE_MORE = 10;
/** «Крупно» по резерву: выбранные добавления + столько запасных; не больше RESERVE_ZOOM_ROUNDS вызовов. */
export const RESERVE_ZOOM_SPARE = 2;
export const RESERVE_ZOOM_ROUNDS = 2;
/** Сколько уже убранных обеими моделями фото показываем спору как образец (картинками; текстом — все). */
export const DECIDED_REF_MAX = 2;
/** Параллельность запуска по умолчанию (оригинал PARALLEL=20; у нас дефолт сайта 5 — ключи общие на портал). */
export const DEFAULT_CONCURRENCY = 5;

export type AiRunMode = "auto" | "test";
export type AiRunStatus = "running" | "stopped" | "done" | "failed";
export type AiDecision = "approve" | "human" | "insufficient";
export type AiResultStatus = "processing" | "proposed" | "applying" | "applied" | "sent_to_human" | "excluded" | "failed" | "superseded";
export type AiResolveOp = "approve" | "human" | "insufficient" | "exclude";

/** JSON-поля результата (ArtAiModerationResult.removed/added/finalOrder/review). */
export type AiRemovedItem = { photoId: string; url: string; sourceUrl: string; reason: string };
export type AiAddedItem = { candidateId: string; url: string; sourceUrl: string; src: "keep" | "reject"; reason: string | null };
export type AiFinalItem = { kind: "S" | "R"; id: string; url: string; src?: "keep" | "reject" };
export type AiReviewInfo = {
  humanReasons: string[];
  /** Пометки при одобрении (например, «одобрено автоматически: 22 фото»): не причина отдать людям. */
  notes?: string[];
  modelVerdict: string;
  scores: Record<string, number> | null;
  needed: number;
  minOk: number;
  model: string;
  passes: number;
  flagged: number;
  overturned: Array<{ id: string; why: string }>;
  passCosts: number[];
  v3?: Record<string, unknown>;
  empty?: boolean;
  /** Ручной аудит решения (проверка человеком или Claude): итог и вердикт по каждому фото (ключ — photoId или candidateId). */
  audit?: AiAudit;
};

export type AiAudit = {
  by: string;
  at: string;
  /** 1..10 — насколько верно ИИ отмодерировал статью */
  score: number;
  verdict: string;
  summary: string;
  photos: Record<string, { ok: boolean; note: string }>;
};

export class AiModerationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "AiModerationError";
  }
}

const staleClaimBefore = () => new Date(Date.now() - CLAIM_TTL_MIN * 60_000);

/** Ошибка ИИ-модерации в журнал (оригинал: триггер log_ai_moderation_error → pipeline_errors source=ai_moderation, stage 140). */
async function logAiError(a: { teamId: string; siteId: string; id: string }, message: string) {
  // Служебные тексты оригинал отсеивал (schema.sql:534-552) — у нас они в summary, не в error, поэтому сюда не попадают.
  const signature = `ai_moderation: ${message.toLowerCase().replace(/https?:\/\/\S+/g, "<url>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\d+/g, "<n>").replace(/\s+/g, " ").trim().slice(0, 160)}`;
  await prisma.artError.create({ data: { teamId: a.teamId, siteId: a.siteId, articleId: a.id, stage: "ai_moderation", message: message.slice(0, 4000), signature } }).catch(() => {});
}

/* ───────────────────────── Кто уже решён (оригинал undecided :936-950) ───────────────────────── */

/**
 * Убирает статьи, у которых уже есть решение ИИ (в любом запуске) или 2 оплаченные неудачи — повтор не оплачиваем.
 * Аудит: оригинал считал решённой и запись `superseded`, из-за чего «Перепроверить» всегда пропускал статью;
 * у нас superseded не считается решением.
 */
export async function undecidedArticleIds(ids: string[]): Promise<string[]> {
  if (!ids.length) return ids;
  const done = new Set<string>();
  const fails = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 300) {
    const rows = await prisma.artAiModerationResult.findMany({
      where: { articleId: { in: ids.slice(i, i + 300) } },
      select: { articleId: true, decision: true, status: true, costUsd: true },
    });
    for (const r of rows) {
      if (r.decision && ["approve", "human", "insufficient"].includes(r.decision) && r.status !== "processing" && r.status !== "superseded") done.add(r.articleId);
      if (r.status === "failed" && r.costUsd > 0) fails.set(r.articleId, (fails.get(r.articleId) ?? 0) + 1);
    }
  }
  return ids.filter((id) => !done.has(id) && (fails.get(id) ?? 0) < 2);
}

/** Свободные статьи сайта на модерации фото: не захвачены запуском ИИ, не закреплены сотрудником (или закрепление протухло). */
async function freePhotoReviewIds(siteId: string, only?: string[]): Promise<Array<{ id: string; updatedAt: Date }>> {
  return prisma.article.findMany({
    where: {
      siteId,
      status: "PHOTO_REVIEW",
      aiRunId: null,
      ...(only?.length ? { id: { in: only } } : {}),
      OR: [{ claimedById: null }, { claimedAt: null }, { claimedAt: { lt: staleClaimBefore() } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, updatedAt: true },
    take: 5000,
  });
}

/** Создать запуск и захватить статьи (Article.aiRunId). Возвращает id запуска и сколько статей реально захвачено. */
async function createRun(p: { teamId: string; siteId: string; mode: AiRunMode; source: "auto" | "manual"; concurrency: number; startedById: string | null; articleIds: string[] }): Promise<{ runId: string; count: number }> {
  const run = await prisma.artAiModerationRun.create({
    data: { teamId: p.teamId, siteId: p.siteId, mode: p.mode, model: "mix3", concurrency: Math.max(1, Math.min(50, p.concurrency || DEFAULT_CONCURRENCY)), status: "running", source: p.source, total: p.articleIds.length, startedById: p.startedById, heartbeatAt: new Date() },
  });
  // Закрепляем за запуском, чтобы сотрудники не взяли эти статьи параллельно (оригинал :138-140, FAR_CLAIM).
  const r = await prisma.article.updateMany({ where: { id: { in: p.articleIds }, status: "PHOTO_REVIEW", aiRunId: null }, data: { aiRunId: run.id } });
  if (r.count !== p.articleIds.length) await prisma.artAiModerationRun.update({ where: { id: run.id }, data: { total: r.count } });
  if (r.count === 0) {
    await prisma.artAiModerationRun.update({ where: { id: run.id }, data: { status: "done", finishedAt: new Date(), error: "Статьи уже заняты" } });
  }
  return { runId: run.id, count: r.count };
}

/* ───────────────────────── Действия пользователя ───────────────────────── */

async function siteForUser(me: CurrentUser, siteId: string) {
  const site = await prisma.artSite.findUnique({ where: { id: siteId }, select: { id: true, teamId: true, accessId: true, createdById: true, settings: true, name: true } });
  if (!site || !(await canAccessArtSite(me, site))) throw new AiModerationError("Нет доступа к сайту", 403);
  return site;
}

/**
 * Запуск по кнопке (оригинал action=start :113-143): `limit` ≤ 5000 свободных PHOTO_REVIEW без прежнего решения ИИ,
 * `articleIds` — ограничить выбор конкретными статьями. Режим test — только предложения; auto — применение по уверенности.
 */
export async function startAiRun(me: CurrentUser, p: { siteId: string; limit?: number; mode?: AiRunMode; articleIds?: string[] }): Promise<{ runId: string; count: number }> {
  const site = await siteForUser(me, p.siteId);
  const limit = Math.max(1, Math.min(5000, Number(p.limit) || 10));
  const mode: AiRunMode = p.mode === "test" ? "test" : "auto";
  const settings = await loadArtSettings();
  if (!settings.aiModMaster) throw new AiModerationError("ИИ-проверка фото выключена мастер-выключателем на экране «Автозапуск»", 409);
  const free = await freePhotoReviewIds(site.id, p.articleIds?.slice(0, 5000));
  const ids = (await undecidedArticleIds(free.map((f) => f.id))).slice(0, limit);
  if (!ids.length) throw new AiModerationError("Нет свободных статей на модерации фото на этом сайте (или все уже проверены ИИ)", 200);
  const conc = mergeSiteSettings(site.settings).aiModeration.concurrency || DEFAULT_CONCURRENCY;
  return createRun({ teamId: site.teamId, siteId: site.id, mode, source: "manual", concurrency: conc, startedById: me.id, articleIds: ids });
}

/** Снять захват с необработанных статей запуска (оригинал releaseUnprocessed :262-268). */
export async function releaseUnprocessed(runId: string): Promise<number> {
  const r = await prisma.article.updateMany({ where: { aiRunId: runId, aiResults: { none: { runId } } }, data: { aiRunId: null } });
  return r.count;
}

/**
 * Снять захват со всех статей завершённого/остановленного запуска. Без этого статьи с решением `proposed`
 * (режим «Тест» или autoApply=false) и `failed` оставались у ИИ навсегда: людям не выдавались, но были в счётчиках.
 * Статьи, которые ещё проверяются (processing/applying свежее STALE_PROCESSING_MS), не трогаем — их отпустит
 * следующий проход `releaseFinishedHolds`.
 */
export async function releaseRunHolds(runId: string, now = new Date()): Promise<number> {
  const r = await prisma.article.updateMany({
    where: {
      aiRunId: runId,
      NOT: { aiResults: { some: { runId, status: { in: ["processing", "applying"] }, updatedAt: { gte: new Date(now.getTime() - STALE_PROCESSING_MS) } } } },
    },
    data: { aiRunId: null },
  });
  return r.count;
}

/** Самолечение (каждый проход автозапуска): статьи, которые держат уже не идущие запуски, отпускаются людям. */
export async function releaseFinishedHolds(): Promise<number> {
  const held = await prisma.article.findMany({ where: { aiRunId: { not: null } }, distinct: ["aiRunId"], select: { aiRunId: true }, take: 500 });
  const ids = held.map((h) => h.aiRunId!).filter(Boolean);
  if (!ids.length) return 0;
  // Только запуски в конечном статусе: завершённый запуск не возвращается в running, гонки с createRun нет.
  const dead = await prisma.artAiModerationRun.findMany({ where: { id: { in: ids }, status: { in: ["done", "stopped", "failed"] } }, select: { id: true } });
  let n = 0;
  for (const d of dead) n += await releaseRunHolds(d.id);
  // Статьи с захватом на удалённый запуск (каскад удаляет результаты, но не Article.aiRunId).
  const known = new Set((await prisma.artAiModerationRun.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id));
  const orphan = ids.filter((id) => !known.has(id));
  if (orphan.length) n += (await prisma.article.updateMany({ where: { aiRunId: { in: orphan } }, data: { aiRunId: null } })).count;
  return n;
}

/** Остановить запуск (оригинал action=stop :166-172): статус stopped, захваты с ещё не проверенных статей снимаются. */
export async function stopAiRun(me: CurrentUser, runId: string): Promise<void> {
  const run = await prisma.artAiModerationRun.findUnique({ where: { id: runId }, include: { site: { select: { teamId: true, accessId: true } } } });
  if (!run || !(await canAccessArtSite(me, run.site))) throw new AiModerationError("Запуск не найден", 404);
  if (run.status !== "running") throw new AiModerationError("Запуск уже завершён", 409);
  await prisma.artAiModerationRun.update({ where: { id: runId }, data: { status: "stopped", finishedAt: new Date() } });
  await releaseUnprocessed(runId);
  // Проверенные, но не применённые (proposed/failed) — тоже людям: решение остаётся на экране «ИИ-модерация».
  await releaseRunHolds(runId);
}

/**
 * Решение человека по предложению (оригинал action=resolve :174-190): CAS proposed → applying, затем применение.
 * Долго (скачивание фото из резерва) — вызывать из API-маршрута, лимита времени у нас нет.
 */
export async function resolveResult(me: CurrentUser, resultId: string, op: AiResolveOp): Promise<{ status: AiResultStatus; error: string | null }> {
  const res = await prisma.artAiModerationResult.findUnique({ where: { id: resultId }, include: { run: { include: { site: { select: { teamId: true, accessId: true } } } } } });
  if (!res || !(await canAccessArtSite(me, res.run.site))) throw new AiModerationError("Решение не найдено", 404);
  if (res.status !== "proposed") throw new AiModerationError("Уже обработано", 409);
  // Запуск завершён — статья уже у людей; если её сейчас правит сотрудник, правки ИИ поверх не накатываем.
  const art = await prisma.article.findUnique({ where: { id: res.articleId }, select: { claimedById: true, claimedAt: true } });
  if (art?.claimedById && art.claimedById !== me.id && art.claimedAt && art.claimedAt >= staleClaimBefore()) {
    const u = await prisma.user.findUnique({ where: { id: art.claimedById }, select: { name: true } });
    throw new AiModerationError(`Статью сейчас модерирует ${u?.name || "другой сотрудник"} («Модерация фото») — дождитесь, пока он закончит`, 409);
  }
  const cas = await prisma.artAiModerationResult.updateMany({ where: { id: resultId, status: "proposed" }, data: { status: "applying", resolvedById: me.id } });
  if (!cas.count) throw new AiModerationError("Уже обработано", 409);
  return applyResult(resultId, op, me.id);
}

/**
 * Повторная проверка по текущим правилам (оригинал action=rerun :192-213): старые предложения → superseded,
 * статьи остаются захваченными и переходят в новый запуск (режим — как у исходного запуска первого решения).
 */
export async function rerunArticles(me: CurrentUser, resultIds: string[]): Promise<{ runId: string; count: number }> {
  const ids = [...new Set(resultIds.map(String))].slice(0, 50);
  let siteId = "";
  let teamId = "";
  let mode: AiRunMode = "auto";
  let conc = DEFAULT_CONCURRENCY;
  const articleIds: string[] = [];
  for (const rid of ids) {
    const res = await prisma.artAiModerationResult.findUnique({ where: { id: rid }, include: { run: { include: { site: { select: { id: true, teamId: true, accessId: true, settings: true } } } }, article: { select: { id: true, status: true, aiRunId: true } } } });
    if (!res || res.status !== "proposed" || !(await canAccessArtSite(me, res.run.site))) continue;
    if (res.article.status !== "PHOTO_REVIEW") continue;
    if (siteId && siteId !== res.run.siteId) continue;
    siteId = res.run.siteId;
    teamId = res.run.teamId;
    mode = res.run.mode === "test" ? "test" : "auto";
    conc = mergeSiteSettings(res.run.site.settings).aiModeration.concurrency || DEFAULT_CONCURRENCY;
    await prisma.artAiModerationResult.update({ where: { id: rid }, data: { status: "superseded", resolvedById: me.id } });
    // Статья держится старым запуском — отпускаем, чтобы новый мог захватить.
    await prisma.article.updateMany({ where: { id: res.articleId, aiRunId: res.runId }, data: { aiRunId: null } });
    articleIds.push(res.articleId);
  }
  if (!articleIds.length) throw new AiModerationError("Нет статей для повторной проверки", 200);
  return createRun({ teamId, siteId, mode, source: "manual", concurrency: conc, startedById: me.id, articleIds });
}

/** Из списка «Мало фото»: добор / вернуть на модерацию / закрыть (оригинал action=insufficient_action :215-239 + «Закрыть» по брифу). */
export async function insufficientAction(me: CurrentUser, articleId: string, op: "topup" | "return" | "close"): Promise<void> {
  if (op === "topup") return requestTopup(me, articleId, "ИИ-модерация: добор из списка «Мало фото»");
  if (op === "return") return returnToReview(me, articleId);
  return closeArticle(me, articleId);
}

/* ───────────────────────── Автозапуск (оригинал watchdog :59-103, 04 §2.3) ───────────────────────── */

export type AiAutostartResult = { started: number; attached: number; skipped: string[] };

/**
 * Каждые 20 с из воркера: для сайтов с aiModeration.enabled (и включённым мастером) — свободные PHOTO_REVIEW без решения ИИ.
 * Владелец: «если включён режим модерации ИИ фото, фотки должны модерироваться ИИ» — поэтому без пачек по 20 и 30 минут ожидания:
 *  - у сайта уже идёт авто-запуск → новые статьи ДОБАВЛЯЮТСЯ к нему (aiRunId, total += n, concurrency — текущая из настроек),
 *    запуск течёт непрерывно; воркер берёт их следующим проходом (claimNextForRun), а finishRunIfIdle не завершит запуск,
 *    пока у него есть непроверенные статьи;
 *  - запуска нет → новый, как только ждёт ≥ batchFrom («Запуск от», по умолчанию 1); при batchFrom > 1 неполная пачка
 *    всё равно уходит через 30 мин ожидания самой старой статьи;
 *  - backlogThreshold > 0: не проверяем впрок, пока в публикации столько статей и больше (0 — не ждать).
 * Ручные запуски (кнопка) не мешают: авто-запуск сайта идёт рядом с ними.
 * Возраст ожидания — по `updatedAt` статьи (момент входа в PHOTO_REVIEW; закрепления сотрудников его сдвигают — допустимо).
 */
export async function aiAutostartTick(now = new Date()): Promise<AiAutostartResult> {
  const out: AiAutostartResult = { started: 0, attached: 0, skipped: [] };
  await releaseFinishedHolds().catch(() => 0);
  const settings = await loadArtSettings();
  if (!settings.aiModMaster) return out;
  const sites = await prisma.artSite.findMany({ where: { isActive: true }, select: { id: true, name: true, teamId: true, createdById: true, settings: true } });
  const enabled = sites.filter((s) => mergeSiteSettings(s.settings).aiModeration.enabled);
  if (!enabled.length) return out;
  const autoRuns = await prisma.artAiModerationRun.findMany({
    where: { status: "running", source: "auto", mode: "auto", siteId: { in: enabled.map((s) => s.id) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, siteId: true },
  });
  const runOf = new Map<string, string>();
  for (const r of autoRuns) if (!runOf.has(r.siteId)) runOf.set(r.siteId, r.id);
  for (const site of enabled) {
    const cfg = mergeSiteSettings(site.settings).aiModeration;
    const free = await freePhotoReviewIds(site.id);
    if (!free.length) continue;
    // Статьи, по которым ИИ уже решил (отдал людям и т.п.), не берём — иначе они занимают запуск впустую (оригинал :76-77).
    const ids0 = await undecidedArticleIds(free.map((f) => f.id));
    if (!ids0.length) continue;
    // Не модерируем впрок: если у сайта копится очередь на публикацию — ждём, пока она разойдётся (оригинал :85-89).
    if (cfg.backlogThreshold > 0) {
      const backlog = await prisma.article.count({ where: { siteId: site.id, status: { in: ["PUBLISH_QUEUED", "PUBLISHING", "REVIEW_PENDING"] satisfies ArtStatus[] } } });
      if (backlog >= cfg.backlogThreshold) { out.skipped.push(`${site.name}: бэклог публикации ${backlog} ≥ ${cfg.backlogThreshold}`); continue; }
    }
    const conc = cfg.concurrency || DEFAULT_CONCURRENCY;
    const runId = runOf.get(site.id);
    if (runId) {
      const n = await attachToRun(runId, ids0, conc);
      if (n > 0) out.attached += n;
      continue;
    }
    const batch = Math.max(1, Math.min(200, cfg.batchFrom || 1));
    if (ids0.length < batch) {
      const set0 = new Set(ids0);
      const waitCut = now.getTime() - AUTO_WAIT_MS;
      const oldWaiting = free.some((f) => set0.has(f.id) && f.updatedAt.getTime() < waitCut);
      if (!oldWaiting) { out.skipped.push(`${site.name}: ждёт ${ids0.length}/${batch} для запуска`); continue; }
    }
    // Берём всех ждущих сразу: параллельность ограничивает concurrency запуска, а не размер пачки.
    const r = await createRun({ teamId: site.teamId, siteId: site.id, mode: "auto", source: "auto", concurrency: conc, startedById: site.createdById, articleIds: ids0 });
    if (r.count > 0) out.started++;
  }
  return out;
}

/**
 * Добавить свободные статьи к идущему запуску. Если запуск успел завершиться между выбором и захватом —
 * захват снимается (статьи снова свободны и уйдут в следующий запуск). Парная защита — в finishRunIfIdle.
 */
async function attachToRun(runId: string, articleIds: string[], concurrency: number): Promise<number> {
  const r = await prisma.article.updateMany({ where: { id: { in: articleIds }, status: "PHOTO_REVIEW", aiRunId: null }, data: { aiRunId: runId } });
  if (!r.count) return 0;
  const upd = await prisma.artAiModerationRun.updateMany({
    where: { id: runId, status: "running" },
    data: { total: { increment: r.count }, concurrency: Math.max(1, Math.min(50, concurrency)), heartbeatAt: new Date() },
  });
  if (!upd.count) {
    await releaseUnprocessed(runId);
    return 0;
  }
  return r.count;
}

/* ───────────────────────── Служебные операции запуска (вызывает воркер) ───────────────────────── */

export const RUN_INCLUDE = { site: { select: { id: true, name: true, teamId: true, nicheCode: true, createdById: true, settings: true } } } satisfies Prisma.ArtAiModerationRunInclude;
/** Запуск с данными сайта (ниша, владелец для ключей, настройки autoApply/concurrency). */
export type AiRunRecord = Prisma.ArtAiModerationRunGetPayload<{ include: typeof RUN_INCLUDE }>;

export async function runningRuns(): Promise<AiRunRecord[]> {
  return prisma.artAiModerationRun.findMany({ where: { status: "running" }, include: RUN_INCLUDE, orderBy: { createdAt: "asc" } });
}

export async function heartbeatRun(runId: string): Promise<void> {
  await prisma.artAiModerationRun.updateMany({ where: { id: runId, status: "running" }, data: { heartbeatAt: new Date() } });
}

/**
 * Сторож (оригинал watchdog :50-56 и :300-301): зависшие processing удаляются (статья снова свободна для пула), applying → proposed.
 * Срок считаем по `updatedAt`: reviewArticle «трогает» строку между проходами моделей, чтобы долгая (до 2×150 с + спор)
 * проверка не была снята и оплачена дважды (оригинал считал по created_at с тем же риском).
 */
export async function watchdogRun(runId: string, now = new Date()): Promise<{ droppedProcessing: number; revertedApplying: number }> {
  const [d, a] = await Promise.all([
    prisma.artAiModerationResult.deleteMany({ where: { runId, status: "processing", updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } } }),
    prisma.artAiModerationResult.updateMany({ where: { runId, status: "applying", updatedAt: { lt: new Date(now.getTime() - STALE_APPLYING_MS) } }, data: { status: "proposed" } }),
  ]);
  return { droppedProcessing: d.count, revertedApplying: a.count };
}

/**
 * Взять следующие статьи запуска атомарно: вставка результата со статусом processing; уникальный индекс (runId, articleId)
 * не даёт двум воркерам взять одну статью (оригинал :302-312). `skip` — статьи, которые этот процесс уже ведёт.
 */
export async function claimNextForRun(runId: string, n: number, skip: Iterable<string> = []): Promise<string[]> {
  const skipArr = [...skip];
  const rows = await prisma.article.findMany({
    where: { aiRunId: runId, aiResults: { none: { runId } }, ...(skipArr.length ? { id: { notIn: skipArr } } : {}) },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, n) + 5,
    select: { id: true },
  });
  const got: string[] = [];
  for (const r of rows) {
    if (got.length >= n) break;
    try {
      await prisma.artAiModerationResult.create({ data: { runId, articleId: r.id, status: "processing" } });
      got.push(r.id);
    } catch {
      /* статью взял другой воркер */
    }
  }
  return got;
}

/** Пересчитать processed/applied/costUsd запуска (оригинал refreshRun :272-278). */
export async function refreshRun(runId: string): Promise<{ processed: number; applied: number; costUsd: number; busy: number; proposed: number }> {
  const rows = await prisma.artAiModerationResult.findMany({ where: { runId }, select: { status: true, costUsd: true } });
  const list = rows.filter((r) => r.status !== "processing");
  const costUsd = list.reduce((s, r) => s + (r.costUsd || 0), 0);
  const applied = rows.filter((r) => r.status === "applied").length;
  const busy = rows.filter((r) => r.status === "processing" || r.status === "applying").length;
  const proposed = rows.filter((r) => r.status === "proposed").length;
  await prisma.artAiModerationRun.updateMany({ where: { id: runId }, data: { processed: list.length, applied, costUsd } });
  return { processed: list.length, applied, costUsd, busy, proposed };
}

/** Применять ли предложения автоматически: режим auto и autoApply сайта (бриф: autoApply=false → оставлять proposed). */
export function runAutoApplies(run: AiRunRecord): boolean {
  return run.mode === "auto" && mergeSiteSettings(run.site.settings).aiModeration.autoApply;
}

/** Запуск завершён, когда нет непроверенных статей и нет processing/applying (и proposed — для авто с применением) (оригинал :313-318). */
export async function finishRunIfIdle(run: AiRunRecord): Promise<boolean> {
  const unprocessed = await prisma.article.count({ where: { aiRunId: run.id, aiResults: { none: { runId: run.id } } } });
  const c = await refreshRun(run.id);
  const waitingAuto = runAutoApplies(run) ? c.proposed : 0;
  if (unprocessed > 0 || c.busy > 0 || waitingAuto > 0) return false;
  const r = await prisma.artAiModerationRun.updateMany({ where: { id: run.id, status: "running" }, data: { status: "done", finishedAt: new Date() } });
  // Автозапуск мог добавить статьи между подсчётом и завершением — отпускаем их, следующий проход заберёт в новый запуск.
  if (r.count > 0) {
    const released = await releaseUnprocessed(run.id);
    if (released) await prisma.artAiModerationRun.update({ where: { id: run.id }, data: { total: { decrement: released } } }).catch(() => {});
    // Тест-режим и autoApply=false: предложения (proposed) и неудачи остаются на экране «ИИ-модерация»,
    // но статьи больше не держатся запуском — сотрудники видят их в «Модерации фото» (группа «От ИИ»).
    await releaseRunHolds(run.id);
  }
  return r.count > 0;
}

/** Операция для авто-применения (оригинал :292-293): confidence < 75 → human, иначе decision (approve|insufficient), прочее → human. */
export function autoOpFor(res: { confidence: number | null; decision: string | null }): AiResolveOp {
  const confident = (res.confidence ?? 0) >= AUTO_CONFIDENCE;
  if (!confident) return "human";
  return res.decision === "approve" ? "approve" : res.decision === "insufficient" ? "insufficient" : "human";
}

/** Авто-применение одного предложения с CAS proposed → applying (оригинал :286-297). false — взял другой воркер. */
export async function autoApplyProposed(run: AiRunRecord, resultId: string): Promise<boolean> {
  const cas = await prisma.artAiModerationResult.updateMany({ where: { id: resultId, runId: run.id, status: "proposed" }, data: { status: "applying" } });
  if (!cas.count) return false;
  const res = await prisma.artAiModerationResult.findUnique({ where: { id: resultId }, select: { confidence: true, decision: true } });
  if (!res) return false;
  await applyResult(resultId, autoOpFor(res), run.startedById ?? run.site.createdById);
  return true;
}

/* ───────────────────────── Применение решения (оригинал resolve :646-702) ───────────────────────── */

async function releaseHold(articleId: string, runId: string) {
  await prisma.article.updateMany({ where: { id: articleId, aiRunId: runId }, data: { aiRunId: null } });
}

/** Пул из n параллельных задач (оригинал runPool :952-957). */
export async function runPool<T>(items: T[], n: number, fn: (x: T) => Promise<unknown>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const x = items[i++];
      await fn(x);
    }
  }));
}

/**
 * op: approve — применить правки и одобрить (статья уходит писать текст); human — применить правки (снятые кадры
 * помечены ✕ ИИ, добавленные — в статье) и отдать людям; insufficient — «Мало фото» с причиной «ИИ: …»;
 * exclude — без правок, людям. Результат должен быть в статусе applying (CAS делает вызывающий).
 * Все изменения фото — через ./moderation.ts с актором ИИ (события byAi=true, userId — кто запустил).
 */
export async function applyResult(resultId: string, op: AiResolveOp, userId: string | null): Promise<{ status: AiResultStatus; error: string | null }> {
  const res = await prisma.artAiModerationResult.findUnique({ where: { id: resultId }, include: { article: { select: { id: true, status: true, teamId: true, siteId: true, photoCount: true } } } });
  if (!res) return { status: "failed", error: "решение не найдено" };
  const actor: AiActor = aiActor(userId);
  const a = res.article;
  const finish = async (status: AiResultStatus, error: string | null = null, summaryPatch?: string) => {
    await prisma.artAiModerationResult.update({ where: { id: resultId }, data: { status, error, resolvedById: userId ?? undefined, ...(summaryPatch !== undefined ? { summary: summaryPatch } : {}) } });
    if (error) await logAiError({ teamId: a.teamId, siteId: a.siteId, id: a.id }, `ИИ-модерация (${op}): ${error}`);
    return { status, error };
  };
  if (a.status !== "PHOTO_REVIEW") {
    await releaseHold(a.id, res.runId);
    return finish("failed", `статья уже в статусе ${a.status}`);
  }
  const release = () => releaseHold(a.id, res.runId);
  try {
    if (op === "exclude") {
      await release();
      return finish("excluded");
    }
    if (op === "insufficient") {
      await markInsufficient(actor, a.id, `ИИ: ${res.summary || "мало подходящих фото"}`.slice(0, 500));
      return finish("applied");
    }
    if (op !== "approve" && op !== "human") return finish("failed", "неизвестное действие");

    // 1) убрать, 2) добавить, 3) порядок (оригинал :663-683). Добавления — параллельно по 5, причины отказов — в summary.
    const removed = (res.removed ?? []) as AiRemovedItem[];
    const added = (res.added ?? []) as AiAddedItem[];
    const finalOrder = (res.finalOrder ?? []) as AiFinalItem[];
    for (const r of removed) await excludePhoto(actor, a.id, r.photoId, r.reason).catch(() => {});
    const newId = new Map<string, string>();
    const failedAdds: string[] = [];
    const failReasons = new Map<string, number>();
    await runPool(added, 5, async (x) => {
      try {
        const j = await addFromReserve(actor, a.id, x.candidateId);
        newId.set(x.candidateId, j.photoId);
      } catch (e) {
        failedAdds.push(x.candidateId);
        const why = (e instanceof Error ? e.message : String(e)).slice(0, 60);
        failReasons.set(why, (failReasons.get(why) ?? 0) + 1);
      }
    });
    const order = finalOrder.map((f) => (f.kind === "S" ? f.id : newId.get(f.id))).filter((x): x is string => !!x);
    if (order.length) await reorderPhotos(actor, a.id, order);
    let summary: string | undefined;
    if (failedAdds.length) {
      // Информация, а не ошибка: в журнал ошибок не пишем (оригинал :684-688).
      const why = [...failReasons].map(([k, v]) => `${k} ×${v}`).join("; ");
      summary = `${String(res.summary || "").slice(0, 450)} | Не добавлено из резерва: ${failedAdds.length} (${why})`.slice(0, 700);
    }
    if (op === "approve") {
      const active = await prisma.artPhoto.count({ where: { articleId: a.id, excluded: false } });
      const minOk = Math.min(MIN_PHOTOS, Math.max(1, a.photoCount));
      if (active < minOk) {
        await release();
        return finish("sent_to_human", `после правок ${active} фото — отдано людям`, summary);
      }
      await approvePhotos(actor, a.id);
      return finish("applied", null, summary);
    }
    await release();
    return finish("sent_to_human", null, summary);
  } catch (e) {
    await release();
    const msg = e instanceof ModerationError || e instanceof Error ? e.message : String(e);
    return finish("failed", msg.slice(0, 300));
  }
}

/* ───────────────────────── Жёсткие правила темы (оригинал focusRules :336-370, дословно) ───────────────────────── */

// оригинал: ai-photo-moderate/index.ts:337
export function focusRules(keyword: string, niche?: string | null, motif?: string | null): string {
  const k = String(keyword || "").toLowerCase();
  const out: string[] = [];
  const g = genderRule(keyword, niche);
  if (g.allow !== "any" && !/interior|decor|home|garden|outdoor/i.test(String(niche || ""))) out.push(g.rule);
  const age = /interior|decor|home|garden|outdoor/i.test(String(niche || "")) ? "" : ageRule(keyword, niche);
  if (age) out.push(age.replace("Reject any photo", "FLAG any photo"));
  const aud = audienceRule(keyword, niche);
  if (aud) out.push(aud.rule.replace("Reject the photo", "FLAG the photo").replace("→ reject, do not guess", "→ FLAG it"));
  // Аудит круга 2 (mary jane: убраны 2 женских стрит-стайла из-за мужчины на фоне): аудиторию судим только по главному герою.
  if (g.allow !== "any" || age || aud) out.push(`AUDIENCE: judge gender/age/body only of the MAIN subject (the person wearing or showing the item). Passers-by, people in the background or a companion next to the subject are never a reason to flag.`);
  const m = String(motif || "").trim();
  if (m && !/^(none|n\/a|unknown|null|-)$/i.test(m)) out.push(`MOTIF (hard): the design must visibly contain "${m}" (painted/printed/shaped). FLAG photos where the motif is absent or only hinted by colour.`);
  out.push(`DETAILS (hard): every concrete detail named in the keyword (motif, colour, shape, length, material, room, feature, audience, age, body type) must be visible in the photo. FLAG photos that contradict or miss such a named detail. Generic words (ideas, trends, 2027, cute, aesthetic) are not details.`);
  const isHair = /hair|braid|updo|\bbun|ponytail|bob\b|pixie|bangs|curls|haircut|wolf cut|shag/.test(k);
  if (isHair) {
    out.push(`SUBJECT = the HAIRSTYLE. Judge only the hair. A bride, a dress, a bouquet, a wedding scene, a back view or a full-length shot is FINE as long as the hairstyle is clearly visible. Never flag a photo for "shows a bride / full-length / dress, not the hairstyle" when the hair is visible. Flag only if the hair is too small/hidden to see the style, or the style contradicts the keyword (e.g. short haircut for a long-hair topic).`);
  }
  // оригинал :353-364
  const body: Array<[RegExp, string, string]> = [
    [/plus[- ]?size|curvy|\bcurves?\b|full[- ]figured|chubby|\bthick\b(?! (?:wavy |curly |straight |long |short )?hair)|midsize|mid-size|apple shape|big belly|bbw|xl\b/, "a visibly plus-size / curvy woman (full hips, bust, tummy, fuller arms)", "slim, thin, athletic or standard sample-size models"],
    [/petite|short women|short girls/, "a visibly petite / short woman", "tall or long-legged runway models"],
    [/\btall women|tall girls/, "a visibly tall woman", "petite women"],
    [/pregnan|maternity|bump/, "a visibly pregnant woman", "non-pregnant models"],
    [/over 40|over 50|over 60|older women|mature/, "a visibly mature woman of the stated age", "young models in their 20s"],
  ];
  for (const [re, must, reject] of body) {
    if (!re.test(k)) continue;
    if (isHair) out.push(`BODY TYPE: the topic is for ${must}. Hair photos are often head-and-shoulders — FLAG only when the visible face/neck/shoulders clearly show ${reject}; a close-up alone is NOT a reason to flag.`);
    else out.push(`BODY TYPE (hard): every photo MUST show ${must}. FLAG any photo with ${reject} — even if the outfit is nice. Judge the body itself, not the clothing size label. If unsure the body matches, FLAG it.`);
  }
  if (/dress|outfit|look|wear|style/.test(k) && !/wedding|bride|bridal|prom|gala|evening|formal|ball|cocktail/.test(k)) {
    out.push(`OCCASION (hard): the keyword does not ask for wedding, bridal, prom or evening wear. FLAG wedding gowns, bridal dresses, ball gowns, prom/sequinned floor-length evening gowns.`);
  }
  // Аудит круга 2 (mary jane: сверх нормы добавлен кадр одних ног без образа): в статье про образы нужен образ.
  if (/outfits?\b|\blooks?\b/.test(k)) out.push(`OUTFIT: the keyword asks for outfits — a photo should show a styled look on a person. A tight close-up of only the item (just shoes on feet, a jacket on a hanger, a flat product shot) is at best "weak_pin" with a score below 60.`);
  if (/wedding guest|guest of wedding/.test(k) && !/nail|manicure|makeup/.test(k)) out.push(`OCCASION (hard): this is WEDDING GUEST wear — FLAG bridal gowns, white wedding dresses and veils.`);
  return out.length ? out.join("\n") + "\n" : "";
}

/* ───────────────────────── Промты mix3 (оригинал :705-706, 831-934, дословно) ───────────────────────── */

// оригинал: ai-photo-moderate/index.ts:706 + аудит 2026-10-14: водяные знаки/логотипы, дубль = и тот же человек/фотосессия
export const V2_REASONS = `"ok" | "off_topic" (different item/style/occasion) | "wrong_detail" (contradicts or misses a detail NAMED in the keyword or in KEYWORD MEANING) | "ai_fake" (AI-generated or illustrated image — obvious renders AND photorealistic AI: too-perfect poreless skin or nails, plastic/airbrushed look, impossible symmetry, melted or fused fingers/nails/jewellery, wrong finger count, inconsistent reflections or shadows, warped background, gibberish lettering, generic glossy "AI stock" look; flag it even without one obvious artifact when several signs add up) | "watermark_logo" (visible watermark, @handle/username, site or brand logo, caption or text overlay on the photo, brand advertising shot) | "collage_text" (collage, screenshot, text-heavy graphic) | "catalogue" (retail product card; white background alone is fine) | "wrong_audience" (the MAIN subject — the person wearing/showing the item — is the wrong gender/age/body type/ethnicity required by keyword; people in the background, passers-by, a partner or friend next to the subject are NOT a reason) | "duplicate" (near-copy of another photo, OR the same person in the same photoshoot / same outfit set as another photo, OR the 3rd+ photo of the same person/celebrity — mark only the extra one, never both, and give dup_of with the other photo id) | "weak_pin" (on-topic but clearly unattractive)`;

// оригинал: ai-photo-moderate/index.ts:506-507 — неизменная часть общих правил; «MUST show» ключа и жёсткие правила темы
// (focusRules + keywordVisualRule) зависят от статьи и идут в конце промта.
const COMMON_STATIC = `IMPORTANT: you see small compressed PREVIEWS (up to 512px). Every photo already passed technical resolution filters — the original size is next to each label. NEVER flag "low resolution", "blurry" or "pixelated" unless obvious out-of-focus at preview scale.
Flag a photo ONLY for a concrete, visible fact. When in doubt, do NOT flag. Returning no flags is a perfectly good answer. All "why" texts in Russian, max 8 words.`;

/**
 * Промт модерации = `system` (неизменный для всех статей: персона, общие правила, список причин, JSON) + `lead` — первый
 * текст user с тем, что зависит от статьи (ключ, жёсткие правила темы, тренд, норма фото). Волна 3 п.3: так системное
 * сообщение можно кэшировать (`aiChat.cacheSystem`; сегодня эти промты короче минимума кэша ≈1024 токена, поэтому
 * экономии пока нет — но и вреда нет). Раньше всё было одним системным текстом с ключом в первой строке; смысл тот же.
 */
export type ModPrompt = { system: string; lead: string };
const articleLead = (keyword: string, focus: string) => {
  const f = focus.trim();
  return `ARTICLE KEYWORD: "${keyword}".` + (f ? `\nRules for this article:\n${f}` : "");
};

/** Сборщики промтов — для стенда кэша промта (scripts), в коде сервиса не использовать. */
export const MODERATION_PROMPTS = { sysTopic: (k: string, f: string) => sysTopic(k, f), sysOpinion: (k: string, n: number, m: number, t: string, f: string) => sysOpinion(k, n, m, t, f), sysDispute: (k: string, f: string) => sysDispute(k, f) };

// оригинал: ai-photo-moderate/index.ts:845-848 (sysA mix3 — дешёвая: тема/подлинность по S и R)
const sysTopic = (keyword: string, focus: string): ModPrompt => ({
  system: `You check ONLY topic relevance and authenticity of photos for a Pinterest article (the article keyword and its rules come first in the user message).
${COMMON_STATIC}
For EVERY S and R photo return a reason from: ${V2_REASONS}, and for R photos a pin score 0-100. Give dup_of for duplicates.
Return ONLY JSON: {"photos":[{"id":"S1","reason":"ok"},{"id":"R2","reason":"ok","score":70}]}`,
  lead: articleLead(keyword, focus),
});

// оригинал: ai-photo-moderate/index.ts:849-854 (sysM mix3 — средняя: собственное мнение по каждому фото).
// Аудит: фраза «A slightly weaker but on-topic photo is valuable» давала 80–95 почти всем — заменена шкалой оценок.
const sysOpinion = (keyword: string, needed: number, minOk: number, trend: string, focus: string): ModPrompt => ({
  system: `You are a senior Pinterest editor judging photos for a Pinterest article (the article keyword, its rules and the photo count come first in the user message). Form your OWN opinion for EVERY photo, S and R.
${COMMON_STATIC}
Remove only for a concrete reason.
"Dated", nail length or shape are NOT reasons unless the keyword or trend notes explicitly require something else.
SCORE must be calibrated, use the whole range: 90-100 = exceptional, would be a top pin (rare, at most 1-2 per set); 75-89 = good; 60-74 = ordinary/acceptable; 40-59 = weak; below 40 = should not be used. A typical set averages about 70-75, not 90. Score the photo itself, not the topic.
For EVERY photo return reason from: ${V2_REASONS}, pin score 0-100, dup_of for duplicates (R may duplicate S or another R).
For an R photo that is not a duplicate but looks nearly the same as another photo (same plain colour and design, same kind of look) give "like" with that photo id.
Return ONLY JSON: {"photos":[{"id":"S1","reason":"ok","score":74},{"id":"R3","reason":"duplicate","score":70,"dup_of":"S2"},{"id":"R4","reason":"ok","score":82,"like":"S5"}],"summary":"2 sentences in Russian"}`,
  lead: `${articleLead(keyword, focus)}\n${trend ? trend + "\n" : ""}The article needs ${needed} photos (minimum ${minOk}).`,
});

// оригинал: ai-photo-moderate/index.ts:885-887 (sysF mix3 — средняя: только спорные фото)
// Аудит круга 2: спор видит уже убранные фото (образец). Круг 3: перепроверка оставленных «по аналогии» убрана (0 изменений
// за круг); оставить фото с отметкой ai_fake — только назвав признак настоящей съёмки; вывеска на фоне — не водяной знак.
const sysDispute = (keyword: string, focus: string): ModPrompt => ({
  system: `You are the final editor for a Pinterest article (the article keyword and its rules come first in the user message). ${COMMON_STATIC}
For every photo under review decide KEEP or DROP. Drop only for: off_topic, wrong_detail, ai_fake, watermark_logo, collage_text, catalogue, wrong_audience, duplicate, or a truly weak pin. Two checkers disagreed on each photo — judge it yourself, do not just follow either.
"ai_fake" includes photorealistic AI images (see the reason list): if you see such signs, drop. Keep a photo the editor flagged as ai_fake ONLY if you can point to a concrete sign of a real photo (visible skin pores and texture, a random everyday background, natural flaws and asymmetry); a pretty, retouched or bokeh portrait is not such a sign.
A "zoom check" note means a zoomed crop showed text — the crop is shown next to the photo; verify it yourself. Only text or a logo stamped ON the image (watermark, @handle, domain, signature, caption) is watermark_logo; shop signs, storefronts, salon or neon signs in the background, brand print on clothing or bags are NOT.
Photos marked [removal needs confirmation] are dropped unless you keep them. Photos marked [reference] are shown only for duplicate comparison — do not list them.
Photos marked [already removed] were removed by both checkers — do not list them; they are precedent: decide similar photos the SAME way.
Return ONLY JSON: {"keep":["S3"],"drop":[{"id":"S7","why":"..."}]}`,
  lead: articleLead(keyword, focus),
});

// Проход «крупно» (дешёвая модель): только водяные знаки/подписи на увеличенных половинах кадра.
// Круг 3: вопрос про ИИ не сработал ни разу — убран; вывески магазинов на фоне давали ложные находки — явный запрет.
// Ключ статьи — первой строкой блока крупных кадров (detailBlocks), система неизменна.
const sysDetail = (): ModPrompt => ({ lead: "", system: `You inspect ZOOMED crops of photos for a Pinterest article (the article keyword is given with the crops). Each photo id is shown as two crops: part 1 (top or left half) and part 2 (bottom or right half).
Report ONLY watermarks stamped ON the image: an overlaid watermark, @handle/username, website or domain, creator/salon logo, signature, caption or text overlay added on top of the photo — often small, semi-transparent, in a corner or along an edge, sometimes written across the nails or hand. Put the exact text you read in "text"; for a logo without readable text describe it in 2-4 words.
NEVER report text that is a physical part of the scene: shop signs, storefronts, salon or neon signs, posters in the background, brand names on bags, clothing, shoes or products, labels, book covers.
Give "part" (1 or 2) where you saw it. When unsure, do not report: most photos are clean and an empty list is the usual answer.
Return ONLY JSON: {"photos":[{"id":"S3","flag":"watermark","text":"@nickname","part":2}]}` });

/* ───────────────────────── Проверка статьи (оригинал reviewArticle :372-633 + mixV3 :831-934) ───────────────────────── */

type ModelOut = { out: Record<string, unknown>; cost: number; model: string };

/** Миниатюра для модели из наших файлов: thumbPath (webp) или path; null — файлов нет. */
async function loadThumbPart(files: { thumbPath: string; path: string }): Promise<ContentPart | null> {
  for (const rel of [files.thumbPath, files.path]) {
    if (!rel) continue;
    try {
      const buf = await readFile(absPath(rel));
      if (!buf.length) continue;
      const out = await sharp(buf).rotate().resize({ width: AI_THUMB_SIDE, height: AI_THUMB_SIDE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
      return imagePart(out, "image/jpeg", "low");
    } catch {
      /* следующий файл */
    }
  }
  return null;
}

/**
 * Две увеличенные половины кадра для прохода «крупно»: сначала оригинал (path), затем миниатюра. Портрет режется
 * на верх/низ, альбом — на лево/право, с перекрытием, чтобы подпись на стыке попала целиком хотя бы в одну половину.
 */
async function loadDetailParts(files: { thumbPath: string; path: string }): Promise<[ContentPart, ContentPart] | null> {
  for (const rel of [files.path, files.thumbPath]) {
    if (!rel) continue;
    try {
      const buf = await readFile(absPath(rel));
      if (!buf.length) continue;
      const { data, info } = await sharp(buf).rotate().resize({ width: AI_DETAIL_SIDE, height: AI_DETAIL_SIDE, fit: "inside", withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
      const w = info.width, h = info.height;
      if (!w || !h) continue;
      const tall = h >= w;
      const len = Math.max(1, Math.round((tall ? h : w) * AI_DETAIL_SHARE));
      const boxes = tall
        ? [{ left: 0, top: 0, width: w, height: len }, { left: 0, top: h - len, width: w, height: len }]
        : [{ left: 0, top: 0, width: len, height: h }, { left: w - len, top: 0, width: len, height: h }];
      const parts = await Promise.all(boxes.map(async (b) => {
        const out = await sharp(data).extract(b).resize({ width: AI_DETAIL_PART, height: AI_DETAIL_PART, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        return imagePart(out, "image/jpeg", "low");
      }));
      return [parts[0], parts[1]];
    } catch {
      /* следующий файл */
    }
  }
  return null;
}

/**
 * Текст модели пишется до наших проверок: убираем фразы про удаления, которых не было (аудит круга 2: «удалены фото
 * с ИИ-генерацией» в pleated, «с водяными знаками» в micro french при нуле таких удалений).
 */
function cleanModelSummary(text: string, removedReasons: string[]): string {
  const has = (re: RegExp) => removedReasons.some((r) => re.test(r));
  const drop: RegExp[] = [];
  if (!removedReasons.length) drop.push(/удал|исключ|убран/i);
  if (!has(/^ai_fake/)) drop.push(/ИИ|сгенерир|генерац|нейросет/i);
  if (!has(/^watermark_logo/)) drop.push(/водян|логотип|подпис|надпис/i);
  if (!has(/^duplicate/)) drop.push(/дубл|повтор/i);
  return text.split(/(?<=[.!?])\s+/).filter((x) => x && !drop.some((re) => re.test(x) && /удал|исключ|убран|убрал/i.test(x))).join(" ").trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Один вызов модели с повтором упавшей попытки (оригинал callModel :483-504: 2 попытки, maxTokens 12000/3000,
 * таймаут 150/60 с, temperature 0.1, JSON). Стоимость всех попыток суммируется в `spent` — неудачные тоже оплачены.
 * Ошибки класса fatal_run (нет ключа/кредитов) не повторяем.
 */
async function callModel(ctx: AiCtx, spent: { usd: number }, prompt: ModPrompt, parts: ContentPart[], pass: string, big: boolean): Promise<ModelOut> {
  let lastErr = "";
  // Зависящее от статьи — первым текстом user, системное сообщение общее для всех статей (кэш провайдера).
  const user: ContentPart[] = prompt.lead ? [{ type: "text", text: prompt.lead }, ...parts] : parts;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await aiChat(ctx, { slot: SLOTS.vision, model: big ? AI_MOD_MODELS.flash : AI_MOD_MODELS.lite, system: prompt.system, user, json: true, temperature: 0.1, maxTokens: big ? 12000 : 3000, timeoutMs: big ? 150_000 : 60_000, cacheSystem: true });
      spent.usd += r.costUsd ?? 0;
      const out = (r.json ?? parseJsonLenient(r.text)) as Record<string, unknown> | null;
      if (!out || typeof out !== "object") { lastErr = `${pass}: ИИ вернул непонятный ответ`; continue; }
      return { out, cost: r.costUsd ?? 0, model: r.model ?? (big ? AI_MOD_MODELS.flash : AI_MOD_MODELS.lite) };
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw new Error(`${pass}: ${e.message}`);
      lastErr = `${pass}: ${e instanceof Error ? e.message : String(e)}`;
      if (attempt === 0) await sleep(2_000);
    }
  }
  throw new Error(lastErr || `${pass}: модель не ответила`);
}

/**
 * Смысл ключа для правила «MUST show» (аудит: milk bath без цветов, обычная чёлка вместо baby bangs).
 * Порядок: словарь известных трендов (бесплатно) → кэш `Article.facts.keywordVisual` для того же ключа →
 * одно дешёвое обращение text_fast (~$0.0001) с записью в кэш. Стоимость любого обращения учитывается в `spent`.
 * mix3.4 (аудит круга 3: «white sneakers» получил пустое определение): ответ модели (и кэш) проходит `completeVisual` —
 * пустое для ключа со значимыми словами заменяется буквальными словами ключа, потерянные цвет/форма/материал дописываются;
 * при сбое модели — тоже буквальные слова. В кэше — сырой ответ модели, поэтому версия кэша не меняется.
 */
async function keywordVisual(ctx: AiCtx, spent: { usd: number }, articleId: string, keyword: string, facts: ArticleFacts | null): Promise<{ text: string; source: "dict" | "cache" | "model" | "none"; cost: number }> {
  const known = knownVisual(keyword);
  if (known) return { text: known, source: "dict", cost: 0 };
  if (!keyword.trim()) return { text: "", source: "none", cost: 0 };
  const cached = (facts as (ArticleFacts & { keywordVisual?: { keyword?: string; text?: string } }) | null)?.keywordVisual;
  // Кэш прежней версии (v1 сужал ключ) не используем — определение спрашиваем заново.
  if (cached && cached.keyword === keyword && typeof cached.text === "string" && (cached as { v?: number }).v === KEYWORD_VISUAL_VERSION) return { text: completeVisual(keyword, cached.text), source: "cache", cost: 0 };
  let cost = 0;
  try {
    const r = await aiChat(ctx, { slot: SLOTS.textFast, system: KEYWORD_VISUAL_SYSTEM, user: `Keyword: "${keyword}"`, json: true, temperature: 0.1, maxTokens: 300, timeoutMs: 30_000 });
    cost = r.costUsd ?? 0;
    spent.usd += cost;
    const text = parseKeywordVisual(r.json ?? parseJsonLenient(r.text));
    // Кэш пишем в свежие facts (не затираем то, что могли дописать этапы), пустое определение тоже кэшируем.
    const fresh = await prisma.article.findUnique({ where: { id: articleId }, select: { facts: true } });
    const base = fresh?.facts && typeof fresh.facts === "object" && !Array.isArray(fresh.facts) ? (fresh.facts as Record<string, unknown>) : {};
    await prisma.article.update({ where: { id: articleId }, data: { facts: { ...base, keywordVisual: { keyword, text, v: KEYWORD_VISUAL_VERSION, at: new Date().toISOString() } } as Prisma.InputJsonValue } }).catch(() => {});
    return { text: completeVisual(keyword, text), source: "model", cost };
  } catch {
    return { text: literalVisual(keyword), source: "none", cost };
  }
}

type CurrentPhoto = { id: string; thumbPath: string; path: string; publicUrl: string; sourceUrl: string; width: number | null; height: number | null };
type ReservePhoto = { id: string; thumbPath: string; path: string; url: string; thumbUrl: string; width: number | null; height: number | null; src: "keep" | "reject" };

/**
 * Проверка одной статьи запуска: читает фото и резерв, зовёт модели (mix3), считает вердикт по фактам (оригинал :601-621)
 * и записывает результат (processing → proposed | excluded | failed). Бросает исключение при сбое моделей — вызывающий
 * (воркер) пишет failed со стоимостью `spent`. Возвращает статус результата.
 */
export async function reviewArticle(run: AiRunRecord, articleId: string): Promise<AiResultStatus> {
  const where = { runId_articleId: { runId: run.id, articleId } };
  const a = await prisma.article.findUnique({ where: { id: articleId }, select: { id: true, teamId: true, siteId: true, status: true, keyword: true, focusKeyword: true, photoCount: true, facts: true, recipe: true } });
  const save = async (data: Prisma.ArtAiModerationResultUncheckedUpdateInput) => {
    await prisma.artAiModerationResult.update({ where, data });
  };
  if (!a || a.status !== "PHOTO_REVIEW") {
    // Штатный пропуск (оригинал писал failed «статус …», триггер отсеивал из журнала) — у нас excluded без ошибки.
    if (a) await releaseHold(a.id, run.id);
    await save({ status: "excluded", summary: `Статья уже в статусе ${a?.status ?? "—"} — проверка не нужна`, costUsd: 0 });
    return "excluded";
  }
  // Не платим дважды: статья уже получила решение ИИ в другом запуске или 2 оплаченные неудачи (оригинал :390-400).
  const prior = await prisma.artAiModerationResult.findMany({ where: { articleId, runId: { not: run.id } }, select: { decision: true, status: true, costUsd: true }, take: 20 });
  const decided = prior.some((p) => p.decision && ["approve", "human", "insufficient"].includes(p.decision) && p.status !== "processing" && p.status !== "superseded");
  const paidFails = prior.filter((p) => p.status === "failed" && p.costUsd > 0).length;
  if (decided || paidFails >= 2) {
    await releaseHold(a.id, run.id);
    await save({ status: "excluded", summary: decided ? "Уже проверена ИИ ранее — повтор не оплачиваем" : "2 неудачные попытки — отдано людям", costUsd: 0 });
    return "excluded";
  }

  const needed = a.photoCount || MIN_PHOTOS;
  const minOk = Math.min(needed, MIN_PHOTOS); // статью публикуем, если осталось 15+ хороших фото (оригинал :402-403)
  const recipe = (a.recipe ?? {}) as Partial<ArticleRecipeSnapshot>;
  const niche = recipe.nicheCode ?? run.site.nicheCode ?? null;
  const facts = (a.facts ?? null) as ArticleFacts | null;
  const motif = typeof facts?.keywordAttributes?.keyword_nail_art === "string" ? (facts.keywordAttributes.keyword_nail_art as string) : null;

  const [photos, cands] = await Promise.all([
    prisma.artPhoto.findMany({ where: { articleId, excluded: false }, orderBy: { position: "asc" }, select: { id: true, thumbPath: true, path: true, publicUrl: true, sourceUrl: true, width: true, height: true, candidateId: true, sha256: true } }),
    prisma.artPhotoCandidate.findMany({
      where: { articleId, OR: [{ status: { in: ["reserve", "keep"] } }, { status: "rejected", rejectStage: "rate" }] },
      orderBy: [{ aiScore: "desc" }],
      take: 400,
      select: { id: true, thumbPath: true, path: true, url: true, thumbUrl: true, width: true, height: true, status: true, rejectReason: true, sha256: true },
    }),
  ]);
  const current: CurrentPhoto[] = photos.map((p) => ({ id: p.id, thumbPath: p.thumbPath, path: p.path, publicUrl: p.thumbPath ? publicUrl(p.thumbPath) : p.publicUrl || p.sourceUrl, sourceUrl: p.sourceUrl, width: p.width, height: p.height }));

  // Статья попала на модерацию без единого фото — не платим ИИ, сразу «Мало фото» (оригинал :426-431).
  if (!current.length) {
    await save({ status: "proposed", decision: "insufficient", confidence: 100, photosBefore: 0, photosAfter: 0, costUsd: 0, originalIds: [], removed: [], added: [], finalOrder: [], summary: "В статье нет ни одного фото — нужен добор фото.", review: { empty: true } as unknown as Prisma.InputJsonValue });
    return "proposed";
  }

  // Резерв: ≤25 одобренных оценкой + ≤15 отклонённых без жёстких причин (оригинал :432-437); mix3.4 берёт первые
  // RESERVE_FIRST (оригинал mixV3 :833 — 15), следующие — только при недоборе нормы.
  const usedCand = new Set(photos.map((p) => p.candidateId).filter(Boolean));
  const usedSha = new Set(photos.map((p) => p.sha256).filter(Boolean));
  const pool = cands.filter((c) => !usedCand.has(c.id) && !(c.sha256 && usedSha.has(c.sha256)));
  const toReserve = (c: (typeof pool)[number], src: "keep" | "reject"): ReservePhoto => ({ id: c.id, thumbPath: c.thumbPath, path: c.path, url: c.thumbPath ? publicUrl(c.thumbPath) : c.thumbUrl || c.url, thumbUrl: c.thumbUrl, width: c.width, height: c.height, src });
  const reserveAll = [
    ...pool.filter((c) => c.status !== "rejected").slice(0, RESERVE_KEEP).map((c) => toReserve(c, "keep")),
    ...pool.filter((c) => c.status === "rejected" && !HARD_REJECT.test(String(c.rejectReason || ""))).slice(0, RESERVE_REJECT).map((c) => toReserve(c, "reject")),
  ];
  const keyword = String(a.keyword || a.focusKeyword || "");
  const trend = trendBriefText(resolveTrendBrief(facts, niche, keyword));

  // Битые картинки роняют весь запрос к модели — заранее читаем миниатюры (оригинал :447-459 проверял превью).
  const curParts = await Promise.all(current.map((p) => loadThumbPart(p)));
  // Резерв читается порциями: первые RESERVE_FIRST — в основные проходы, следующие — только при недоборе нормы.
  // Битая миниатюра пропускается и заменяется следующим кандидатом; номера R1..Rn стабильны (индекс в `reserve`).
  const reserve: ReservePhoto[] = [];
  const reserveParts: ContentPart[] = [];
  let reserveCursor = 0;
  const loadReserve = async (n: number): Promise<number> => {
    const before = reserve.length;
    while (reserve.length - before < n && reserveCursor < reserveAll.length) {
      const chunk = reserveAll.slice(reserveCursor, reserveCursor + n - (reserve.length - before));
      reserveCursor += chunk.length;
      const parts = await Promise.all(chunk.map((c) => loadThumbPart(c)));
      chunk.forEach((c, i) => { const part = parts[i]; if (part) { reserve.push(c); reserveParts.push(part); } });
    }
    return reserve.length - before;
  };
  await loadReserve(RESERVE_FIRST);
  // Проход «крупно»: две увеличенные половины кадра — для всех фото статьи и только для выбранных кандидатов резерва.
  const detailParts = new Map<string, [ContentPart, ContentPart] | null>();
  const fileOf = (id: string): { thumbPath: string; path: string } | null => {
    const m = /^([SR])(\d+)$/.exec(id);
    if (!m) return null;
    return (m[1] === "S" ? current : reserve)[Number(m[2]) - 1] ?? null;
  };
  const loadDetail = async (ids: string[]) => {
    await Promise.all(ids.filter((id) => !detailParts.has(id)).map(async (id) => {
      const f = fileOf(id);
      detailParts.set(id, f ? await loadDetailParts(f) : null);
    }));
  };
  const detailOf = (id: string) => detailParts.get(id) ?? null;
  const detailBlocks = (ids: string[]): ContentPart[] => {
    const b: ContentPart[] = [{ type: "text", text: `ARTICLE KEYWORD: "${keyword}". Zoomed crops, two per photo:` }];
    for (const id of ids) {
      const d = detailOf(id);
      if (d) b.push({ type: "text", text: `${id} part 1` }, d[0], { type: "text", text: `${id} part 2` }, d[1]);
    }
    return b;
  };
  const sIds = current.map((_, i) => `S${i + 1}`);
  await loadDetail(sIds);

  const ctx: AiCtx = { userId: run.startedById ?? run.site.createdById ?? "", teamId: run.teamId, articleId, siteId: run.siteId };
  if (!ctx.userId) throw new Error("У запуска нет пользователя для ключей ИИ: укажите владельца сайта");
  const spent = { usd: 0 };
  try {
    const sz = (x: { width: number | null; height: number | null }) => (x.width && x.height ? ` (original ${x.width}x${x.height}px)` : "");
    // Смысл ключа («MUST show») — в правила обеих моделей и спора (аудит: не тот вариант ключа).
    const kv = await keywordVisual(ctx, spent, articleId, keyword, facts);
    const focus = focusRules(keyword, niche, motif) + keywordVisualRule(keyword, kv.text);
    let calls = 0;

    // оригинал :836-843
    const sBlocks: ContentPart[] = [{ type: "text", text: `ARTICLE KEYWORD: "${keyword}". Article photos S1..S${current.length}:` }];
    current.forEach((p, i) => {
      const part = curParts[i];
      if (!part) { sBlocks.push({ type: "text", text: `S${i + 1}: preview unavailable — answer "ok"` }); return; }
      sBlocks.push({ type: "text", text: `S${i + 1}${sz(p)}` });
      sBlocks.push(part);
    });
    const rBlocks: ContentPart[] = reserve.length ? [{ type: "text", text: `RESERVE candidates R1..R${reserve.length} (not in the article yet):` }] : [];
    reserve.forEach((c, i) => { rBlocks.push({ type: "text", text: `R${i + 1}${sz(c)}` }); rBlocks.push(reserveParts[i]); });
    // Эталонов (QUALITY BAR) нет — см. шапку файла.

    const dBlocks = detailBlocks(sIds);

    // оригинал :855-858 + проход «крупно» по фото статьи параллельно; его сбой не роняет проверку (тогда без третьего сигнала).
    let detailError: string | null = null;
    const noDetail: ModelOut = { out: { photos: [] }, cost: 0, model: AI_MOD_MODELS.lite };
    const [pa, pm, pd] = await Promise.all([
      callModel(ctx, spent, sysTopic(keyword, focus), [...sBlocks, ...rBlocks], "v3 тема (lite)", false),
      callModel(ctx, spent, sysOpinion(keyword, needed, minOk, trend, focus), [...sBlocks, ...rBlocks], "v3 мнение (flash)", true),
      dBlocks.length > 1
        ? callModel(ctx, spent, sysDetail(), dBlocks, "v3 крупно (lite)", false).catch((e) => { detailError = (e instanceof Error ? e.message : String(e)).slice(0, 200); return noDetail; })
        : Promise.resolve(noDetail),
    ]);
    calls += 2 + (dBlocks.length > 1 && !detailError ? 1 : 0);
    // Отметка «живы» для сторожа (см. watchdogRun): следующий проход может занять ещё до 150 с.
    const touch = () => prisma.artAiModerationResult.updateMany({ where: { runId: run.id, articleId, status: "processing" }, data: { error: null } }).catch(() => {});
    await touch();
    // Находки «крупно» — только по фото статьи (резерв смотрится позже и только выбранный).
    const W: DetailFlags = new Map([...parseDetailFlags(pd.out)].filter(([id]) => id.startsWith("S")));
    // liteOwn — собственный ответ lite (для ничьей по ИИ); A — он же с находками «крупно» (сигнал на стороне дешёвой модели).
    const liteOwn: Judgements = judgementsOf(pa.out);
    let A: Judgements = mergeDetailFlags(liteOwn, W);
    const M = judgementsOf(pm.out);
    const score = (id: string) => scoreOf(M, id);

    // Фото статьи (правила — ./aiModerationRules.ts): обе модели за удаление → убрать; одна против «ок» другой → спор.
    const sv = classifyArticlePhotos(sIds, A, M);
    const confirm = removalsNeedConfirm(sv, current.length);
    const look = [...new Set([...sv.disputed, ...confirm])];
    const decidedDrops = [...sv.drops.keys()].filter((id) => !confirm.includes(id));
    let pf: ModelOut = { out: { keep: [], drop: [] }, cost: 0, model: pm.model };
    let finalUsed = false;
    let dispute: DisputeAnswer = parseDispute(null, true);
    let disputeError: string | null = null;
    // Спор — только когда есть спорные фото (mix3.4: перепроверки оставленных «по аналогии» больше нет).
    if (look.length) {
      finalUsed = true;
      const fb: ContentPart[] = [{ type: "text", text: `ARTICLE KEYWORD: "${keyword}". Photos under review:` }];
      const shown = new Set<string>();
      const pushPhoto = (id: string, label: string) => {
        const m = /^([SR])(\d+)$/.exec(id);
        if (!m || shown.has(id)) return;
        const idx = Number(m[2]) - 1;
        const part = m[1] === "S" ? curParts[idx] : reserveParts[idx];
        if (!part) return;
        shown.add(id);
        fb.push({ type: "text", text: label });
        fb.push(part);
      };
      for (const id of look) {
        const a1 = A.get(id), m1 = M.get(id);
        const w = W.get(id);
        pushPhoto(id, `${id} — check A: ${a1?.reason ?? "ok"} ${a1?.why || ""}; editor: ${m1?.reason ?? "ok"}${m1?.score != null ? ` (score ${m1.score})` : ""} ${m1?.why || ""}${m1?.dupOf || a1?.dupOf ? ` (dup_of ${m1?.dupOf || a1?.dupOf})` : ""}${w ? `; zoom check: ${w.kind} "${w.text}"` : ""}${confirm.includes(id) ? " [removal needs confirmation]" : ""}`);
        // Увеличенная половина, где проход «крупно» нашёл подпись, — рядом с фото.
        const d = w ? detailOf(id) : null;
        if (d) fb.push({ type: "text", text: `${id} zoomed part ${w?.part === 1 ? 2 : 1}` }, d[w?.part === 1 ? 1 : 0]);
      }
      // Образец: уже убранные обеими моделями (последовательность решений), текстом — все, картинками — первые DECIDED_REF_MAX.
      if (decidedDrops.length) {
        fb.push({ type: "text", text: `Already removed by both checkers: ${decidedDrops.map((id) => `${id} (${(sv.drops.get(id) || "").slice(0, 70)})`).join("; ")}` });
        for (const id of decidedDrops.slice(0, DECIDED_REF_MAX)) pushPhoto(id, `${id} [already removed] — ${(sv.drops.get(id) || "").slice(0, 90)}`);
      }
      // Для дублей показываем и «оригинал», иначе спор не может проверить повтор.
      for (const id of look) {
        const ref = M.get(id)?.dupOf || A.get(id)?.dupOf;
        if (ref && !look.includes(ref)) pushPhoto(ref, `${ref} [reference] — the photo ${id} may duplicate`);
      }
      try {
        pf = await callModel(ctx, spent, sysDispute(keyword, focus), fb, "v3 спор (flash)", true);
        dispute = parseDispute(pf.out, true);
        calls++;
      } catch (e) {
        // Спор не ответил: спорные фото оставляем, решение — людям (verdictFrom), стоимость попыток уже в spent.
        disputeError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        dispute = parseDispute(null, false);
      }
    }
    // Сильная отметка «ИИ» основной модели против «keep» спора — ничья, фото убирается (resolveDisputes).
    const res = resolveDisputes(sv, confirm, M, A, dispute, liteOwn);
    const drops = res.drops;

    // Резерв: добор до нормы и сильные кадры сверх неё (до MAX_ARTICLE_PHOTOS), без повторов человека/фотосессии (./aiModerationRules.ts).
    const keptS = sIds.filter((id) => !drops.has(id));
    const rIdsOf = () => reserve.map((_, i) => `R${i + 1}`);
    const pickWith = (rIds: string[]): PickResult => pickAdds({ rIds, keptS, needed, minOk, maxAdds: MAX_ADDS, A, M });
    let pick = pickWith(rIdsOf());

    // Досылка резерва: норма не набирается первыми RESERVE_FIRST — ещё RESERVE_MORE кандидатов маленьким вызовом lite + flash.
    // Фото статьи flash уже оценил, здесь видит только новых кандидатов; lite для проверки дублей видит и оставленные фото.
    let moreCost = 0;
    let moreError: string | null = null;
    const moreIds: string[] = [];
    let moreOut: { lite: Record<string, unknown> | null; flash: Record<string, unknown> | null } | null = null;
    if (keptS.length + pick.adds.length < needed && reserveCursor < reserveAll.length) {
      const from = reserve.length;
      if (await loadReserve(RESERVE_MORE)) {
        for (let i = from; i < reserve.length; i++) moreIds.push(`R${i + 1}`);
        const mb: ContentPart[] = [{ type: "text", text: `More RESERVE candidates ${moreIds[0]}..${moreIds[moreIds.length - 1]} (not in the article yet; article photos were judged earlier — judge ONLY these R photos):` }];
        moreIds.forEach((id, k) => { mb.push({ type: "text", text: `${id}${sz(reserve[from + k])}` }, reserveParts[from + k]); });
        const refs: ContentPart[] = [{ type: "text", text: `ARTICLE KEYWORD: "${keyword}". Article photos kept so far — reference only, to spot duplicates (do not list them):` }];
        for (const id of keptS) {
          const part = curParts[Number(id.slice(1)) - 1];
          if (part) refs.push({ type: "text", text: id }, part);
        }
        const cost0 = spent.usd;
        try {
          const [ma, mm] = await Promise.all([
            callModel(ctx, spent, sysTopic(keyword, focus), [...refs, ...mb], "v3 резерв ещё (lite)", false),
            callModel(ctx, spent, sysOpinion(keyword, needed, minOk, trend, focus), [{ type: "text", text: `ARTICLE KEYWORD: "${keyword}".` }, ...mb], "v3 резерв ещё (flash)", true),
          ]);
          calls += 2;
          moreOut = { lite: ma.out, flash: mm.out };
          const ja = judgementsOf(ma.out), jm = judgementsOf(mm.out);
          const nextA: Judgements = new Map(A);
          for (const id of moreIds) {
            if (ja.has(id)) { liteOwn.set(id, ja.get(id)!); nextA.set(id, ja.get(id)!); }
            if (jm.has(id)) M.set(id, jm.get(id)!);
          }
          A = nextA;
        } catch (e) {
          moreError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        }
        moreCost = spent.usd - cost0;
        await touch();
        pick = pickWith(rIdsOf());
      }
    }

    // «Крупно» по резерву — только выбранные добавления и пара запасных (находка = кандидат не добавляется, берётся следующий).
    const zoomedR = new Set<string>();
    const reserveZoomOut: Array<Record<string, unknown>> = [];
    let reserveZoomCost = 0;
    let reserveZoomError: string | null = null;
    for (let round = 0; round < RESERVE_ZOOM_ROUNDS && !reserveZoomError; round++) {
      const targets = reserveZoomTargets(pick, zoomedR, RESERVE_ZOOM_SPARE);
      if (!targets.length) break;
      await loadDetail(targets);
      for (const id of targets) zoomedR.add(id);
      const zb = detailBlocks(targets);
      if (zb.length <= 1) continue;
      const cost0 = spent.usd;
      try {
        const z = await callModel(ctx, spent, sysDetail(), zb, "v3 крупно резерв (lite)", false);
        calls++;
        reserveZoomOut.push(z.out);
        const wr: DetailFlags = new Map([...parseDetailFlags(z.out)].filter(([id]) => targets.includes(id)));
        for (const [id, f] of wr) W.set(id, f);
        A = mergeDetailFlags(A, wr);
      } catch (e) {
        reserveZoomError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
      reserveZoomCost += spent.usd - cost0;
      pick = pickWith(rIdsOf());
    }
    // После всех раундов добавляем только просмотренных «крупно» (если «крупно» не упал — тогда как раньше, без него).
    if (!reserveZoomError && zoomedR.size && pick.adds.some((x) => !zoomedR.has(x.id))) pick = pickWith(rIdsOf().filter((id) => zoomedR.has(id)));
    const adds = pick.adds;
    const finalIds = orderFinal(keptS, adds, M);

    // оригинал :576-599
    const resolveRef = (id: string): AiFinalItem | null => {
      const m = /^([SR])(\d+)$/i.exec(String(id || "").trim());
      if (!m) return null;
      const n = Number(m[2]) - 1;
      if (m[1].toUpperCase() === "S") { const p = current[n]; return p ? { kind: "S", id: p.id, url: p.publicUrl } : null; }
      const c = reserve[n];
      return c ? { kind: "R", id: c.id, url: c.url, src: c.src } : null;
    };
    const addWhy = new Map<string, string>(adds.map((d) => [d.id, d.why.slice(0, 120)]));
    const seen = new Set<string>();
    const final: Array<AiFinalItem & { why: string | null }> = [];
    for (const key of finalIds) {
      const ref = resolveRef(key);
      if (!ref || seen.has(ref.id)) continue;
      seen.add(ref.id);
      final.push({ ...ref, why: ref.kind === "R" ? addWhy.get(key) || null : null });
    }
    if (!final.length) throw new Error("ИИ не вернул итоговую подборку");
    const removed: AiRemovedItem[] = current.map((p, i) => ({ p, key: `S${i + 1}` })).filter(({ p }) => !seen.has(p.id))
      .map(({ p, key }) => ({ photoId: p.id, url: p.publicUrl, sourceUrl: p.sourceUrl, reason: (drops.get(key) || "не вошло в итог").slice(0, 120) }));
    const added: AiAddedItem[] = final.filter((f) => f.kind === "R").map((f) => {
      const c = reserve.find((r) => r.id === f.id)!;
      return { candidateId: f.id, url: f.url, sourceUrl: c.thumbUrl || "", src: c.src, reason: f.why };
    });

    // Решение и уверенность — из согласия моделей и фактов (оригинал :601-621, правила — verdictFrom).
    const removedReasons = [...drops.values()];
    const vd = verdictFrom({ total: current.length, final: final.length, needed, minOk, agreed: sv.agreed, disputed: sv.disputed.length, flags: sv.flags.length, flashFlags: sv.flashFlags.length, res, removedReasons }, AUTO_CONFIDENCE);
    const decision: AiDecision = vd.decision;
    const confidence = vd.confidence;
    const reasons = vd.reasons;
    const modelVerdict = final.length >= minOk ? "approve" : "insufficient";
    // Индексы 0–4 — как в mix3.3 ([4] теперь «крупно» по статье + по выбранному резерву), [5] — досылка резерва (lite + flash).
    const passCosts = [pa.cost, pm.cost, pf.cost, kv.cost, pd.cost + reserveZoomCost, moreCost];
    const v3Log = {
      version: "mix3.4", lite_topic: pa.out, detail_pass: pd.out, detail_flags: Object.fromEntries(W), detail_error: detailError, flash_opinion: pm.out, final_pass: finalUsed ? pf.out : null, final_used: finalUsed, final_error: disputeError,
      reserve_zoom: [...zoomedR], reserve_zoom_pass: reserveZoomOut, reserve_zoom_error: reserveZoomError,
      reserve_more: moreIds, reserve_more_pass: moreOut, reserve_more_error: moreError,
      disputed: sv.disputed, disputed_by: sv.disputedBy, confirm, auto_kept: sv.autoKept.map((x) => x.id), agreed: sv.agreed, flags: sv.flags, flash_flags: sv.flashFlags,
      kept_after_dispute: res.keptAfterDispute, flash_overturned: res.flashOverturned, dropped_after_dispute: res.droppedAfterDispute, tie_drops: res.tieDrops, agree_share: Math.round(vd.agreeShare * 100) / 100,
      reserve_candidates: pick.candidates, rejected_by_code: pick.rejected, reserve_total: reserve.length,
      adds: adds.map((x) => ({ id: x.id, kind: x.kind, score: score(x.id) })), extra_threshold: pick.extraThreshold, cap: pick.cap,
      keyword_visual: { text: kv.text, source: kv.source, cost: kv.cost },
    };
    const factLine = `Итог: ${final.length} фото из ${current.length} (убрано ${removed.length}, добавлено ${added.length}, норма ${needed}, минимум ${minOk}).${decision === "human" && reasons.length ? " Людям: " + reasons.join(", ") + "." : ""}`;
    // Текст модели пишется до наших проверок — если он описывает удаления, которых нет, не показываем его.
    const modelSum = cleanModelSummary(String((pm.out?.summary as string | undefined) || "").replace(/(Одобрено|Отобраны?|Подборка из|Оставлено|Оставлены?) \d+[^.]*\./gi, "").trim(), removedReasons);
    const summary = removed.length === 0 && /удален|исключен/i.test(modelSum) ? `${factLine} Все фото прошли проверку.` : `${factLine} ${modelSum}`;

    const review: AiReviewInfo = {
      humanReasons: decision === "human" ? reasons : [], notes: decision === "human" ? [] : reasons, modelVerdict, scores: null, needed, minOk,
      model: `mix3: ${pa.model} + ${pm.model}`, passes: calls, flagged: sv.flags.length, overturned: res.overturned, passCosts, v3: v3Log,
    };
    await save({
      status: "proposed", decision, confidence,
      photosBefore: current.length, photosAfter: final.length,
      originalIds: current.map((p) => p.id),
      removed: removed as unknown as Prisma.InputJsonValue,
      added: added as unknown as Prisma.InputJsonValue,
      finalOrder: final.map(({ kind, id, url, src }) => ({ kind, id, url, ...(src ? { src } : {}) })) as unknown as Prisma.InputJsonValue,
      review: review as unknown as Prisma.InputJsonValue,
      summary: summary.slice(0, 700), costUsd: spent.usd, error: null,
    });
    await prisma.article.update({ where: { id: articleId }, data: { costUsd: await articleCost(articleId) } }).catch(() => {});
    return "proposed";
  } catch (e) {
    // Неудача с оплаченными попытками: failed + стоимость (две такие — статью отдаём людям без оплаты, см. undecided).
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await save({ status: "failed", error: msg, costUsd: spent.usd });
    await releaseHold(a.id, run.id);
    await logAiError({ teamId: a.teamId, siteId: a.siteId, id: a.id }, `ИИ-модерация: ${msg}`);
    await prisma.article.update({ where: { id: articleId }, data: { costUsd: await articleCost(articleId) } }).catch(() => {});
    return "failed";
  }
}

/* ───────────────────────── Данные для экрана /pinterest/articles/moderation/ai ───────────────────────── */

export type AiRunRow = { id: string; siteId: string; siteName: string; mode: string; model: string; source: string; status: string; concurrency: number; total: number; processed: number; applied: number; costUsd: number; createdAt: string; finishedAt: string | null; heartbeatAt: string | null; error: string | null; startedBy: string | null };
export type AiResultRow = {
  id: string; runId: string; runMode: string; articleId: string; keyword: string; siteId: string; siteName: string;
  status: string; decision: string | null; confidence: number | null; photosBefore: number; photosAfter: number;
  removed: AiRemovedItem[]; added: AiAddedItem[]; finalOrder: AiFinalItem[];
  review: Partial<AiReviewInfo> | null; summary: string | null; error: string | null; costUsd: number; createdAt: string; updatedAt: string;
  articleStatus: ArtStatus;
};
export type AiSiteRow = { id: string; name: string; waiting: number; untouched: number; running: boolean; settings: { enabled: boolean; batchFrom: number; concurrency: number; backlogThreshold: number; autoApply: boolean } };
export type InsufficientRow = { id: string; keyword: string; siteId: string; siteName: string; status: ArtStatus; photoCount: number; reason: string | null; byAi: boolean; byName: string | null; at: string };
export type AiOverview = { sites: AiSiteRow[]; runs: AiRunRow[]; results: AiResultRow[]; insufficient: InsufficientRow[]; canSeeCosts: boolean; aiModMaster: boolean; at: string };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Всё для экрана ИИ-модерации: сайты с ожидающими, запуски (30), решения (500), список «Мало фото». Только видимые сайты. */
export async function aiRunsOverview(me: CurrentUser, opts: { runsTake?: number; resultsTake?: number } = {}): Promise<AiOverview> {
  const siteWhere = await artSiteWhere(me);
  const sites = await prisma.artSite.findMany({ where: siteWhere, orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, settings: true } });
  const ids = sites.map((s) => s.id);
  const siteIn = { siteId: ids.length ? { in: ids } : "none" };
  const [waiting, untouched, running, runs, results, insuff, settings] = await Promise.all([
    prisma.article.groupBy({ by: ["siteId"], where: { ...siteIn, status: "PHOTO_REVIEW" }, _count: { _all: true } }),
    prisma.article.groupBy({ by: ["siteId"], where: { ...siteIn, status: "PHOTO_REVIEW", aiRunId: null }, _count: { _all: true } }),
    prisma.artAiModerationRun.findMany({ where: { ...siteIn, status: "running" }, select: { siteId: true }, distinct: ["siteId"] }),
    prisma.artAiModerationRun.findMany({ where: siteIn, orderBy: { createdAt: "desc" }, take: opts.runsTake ?? 30 }),
    prisma.artAiModerationResult.findMany({
      where: { run: siteIn },
      orderBy: { createdAt: "desc" },
      take: opts.resultsTake ?? 500,
      include: { run: { select: { mode: true, siteId: true } }, article: { select: { keyword: true, status: true } } },
    }),
    prisma.article.findMany({
      where: { ...siteIn, status: { in: ["INSUFFICIENT_PHOTOS", "WAITING_FOR_PHOTOS"] } },
      orderBy: { updatedAt: "desc" },
      take: 1000,
      select: { id: true, keyword: true, siteId: true, status: true, photoCount: true, insufficientReason: true, insufficientById: true, insufficientByAi: true, updatedAt: true, error: true },
    }),
    loadArtSettings(),
  ]);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const userIds = [...new Set([...runs.map((r) => r.startedById), ...insuff.map((i) => i.insufficientById)].filter((x): x is string => !!x))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));
  // Когда и кем отмечено «Мало фото» — по последнему событию модерации (в Article нет insufficientAt).
  const events = insuff.length ? await prisma.artModerationEvent.findMany({ where: { articleId: { in: insuff.map((i) => i.id) }, action: "insufficient" }, orderBy: { createdAt: "desc" }, select: { articleId: true, createdAt: true, userId: true, byAi: true } }) : [];
  const lastEvent = new Map<string, (typeof events)[number]>();
  for (const e of events) if (!lastEvent.has(e.articleId)) lastEvent.set(e.articleId, e);
  const evUserIds = [...new Set(events.map((e) => e.userId).filter((x): x is string => !!x && !userName.has(x)))];
  if (evUserIds.length) for (const u of await prisma.user.findMany({ where: { id: { in: evUserIds } }, select: { id: true, name: true } })) userName.set(u.id, u.name);

  const runningSet = new Set(running.map((r) => r.siteId));
  const canSeeCosts = seesTeamCosts(me);
  const money = (v: number) => (canSeeCosts ? v : 0);
  return {
    sites: sites.map((s) => ({
      id: s.id, name: s.name,
      waiting: waiting.find((w) => w.siteId === s.id)?._count._all ?? 0,
      untouched: untouched.find((w) => w.siteId === s.id)?._count._all ?? 0,
      running: runningSet.has(s.id),
      settings: mergeSiteSettings(s.settings).aiModeration,
    })),
    runs: runs.map((r) => ({
      id: r.id, siteId: r.siteId, siteName: siteName.get(r.siteId) ?? "—", mode: r.mode, model: r.model, source: r.source, status: r.status, concurrency: r.concurrency,
      total: r.total, processed: r.processed, applied: r.applied, costUsd: money(r.costUsd), createdAt: r.createdAt.toISOString(), finishedAt: iso(r.finishedAt), heartbeatAt: iso(r.heartbeatAt), error: r.error,
      startedBy: r.startedById ? userName.get(r.startedById) ?? null : null,
    })),
    results: results.map((r) => ({
      id: r.id, runId: r.runId, runMode: r.run.mode, articleId: r.articleId, keyword: r.article.keyword, siteId: r.run.siteId, siteName: siteName.get(r.run.siteId) ?? "—",
      status: r.status, decision: r.decision, confidence: r.confidence, photosBefore: r.photosBefore, photosAfter: r.photosAfter,
      removed: (r.removed ?? []) as AiRemovedItem[], added: (r.added ?? []) as AiAddedItem[], finalOrder: (r.finalOrder ?? []) as AiFinalItem[],
      review: (r.review ?? null) as Partial<AiReviewInfo> | null, summary: r.summary, error: r.error, costUsd: money(r.costUsd),
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), articleStatus: r.article.status,
    })),
    insufficient: insuff.map((i) => {
      const ev = lastEvent.get(i.id);
      const byAi = ev ? ev.byAi : i.insufficientByAi;
      const uid = ev ? ev.userId : i.insufficientById;
      return {
        id: i.id, keyword: i.keyword, siteId: i.siteId, siteName: siteName.get(i.siteId) ?? "—", status: i.status, photoCount: i.photoCount,
        reason: i.status === "WAITING_FOR_PHOTOS" ? i.insufficientReason || i.error || "воркер не набрал фото" : i.insufficientReason,
        byAi, byName: byAi ? "ИИ" : uid ? userName.get(uid) ?? null : i.status === "WAITING_FOR_PHOTOS" ? "воркер" : null,
        at: (ev?.createdAt ?? i.updatedAt).toISOString(),
      };
    }),
    canSeeCosts,
    aiModMaster: settings.aiModMaster,
    at: new Date().toISOString(),
  };
}
