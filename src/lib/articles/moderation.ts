/**
 * Модерация статей: единственная точка изменения фото статьи (человеком, позже — ИИ-модерацией)
 * и решений по готовой статье. Порт `photo-review-action/index.ts` оригинала (claim/release/remove/reorder/add/
 * topup/approve/mark_insufficient) + модерация готовой статьи (ModerationPage) + повтор публикации (PublicationsPage).
 *
 * Правила:
 *  - статус меняется только CAS-обновлением (`updateMany` с ожидаемым статусом) — гонка с воркером/другим
 *    модератором даёт ошибку `stale` (оригинал: 200 {stale:true});
 *  - каждое действие пишет `ArtModerationEvent` (статистика сотрудников, undo);
 *  - закрепление продлевается каждым действием и пингом открытой страницы (`extendClaim`), снимается при уходе;
 *  - захват `aiRunId` действует только пока запуск ИИ идёт (`liveAiRunIds`) — завершённый запуск статьи не прячет;
 *  - исключённое фото остаётся в `ArtPhoto` с `excluded=true` до одобрения (для «Отменить»), удаляется при одобрении.
 */
import { createHash, randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { Prisma, type ArtStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { safeFetch } from "@/lib/pins/fetch";
import { articleWhere, canAccessArticle } from "./access";
import { firstWritingStage } from "./stages";
import { statusLabel } from "./labels";
import { absPath, exists, makeThumb, photoRel, photoThumbRel, publicUrl, removePath, toWpJpeg, writeFileAtomic } from "./storage";
import { CLAIM_TTL_MIN, MIN_PHOTOS, type ArticleCursor, type ArticleFacts } from "./types";

/** Ошибка модерации с HTTP-кодом; `stale` — статья уже не в ожидаемом статусе (ожидаемая гонка, не поломка). */
export class ModerationError extends Error {
  constructor(message: string, public readonly status = 400, public readonly stale = false) {
    super(message);
    this.name = "ModerationError";
  }
}

/**
 * Системный актор ИИ-модерации (src/lib/articles/aiModeration.ts): действует без проверки доступа,
 * события пишутся с byAi=true, в полях «кто» — userId (оригинал: acting_user_id = photo_review_claimed_by || created_by).
 */
export type AiActor = { byAi: true; userId: string | null };
/** Кто меняет фото статьи: сотрудник (CurrentUser) или ИИ-модерация (AiActor). */
export type Actor = CurrentUser | AiActor;

export const isAi = (a: Actor): a is AiActor => "byAi" in a && a.byAi === true;
export const actorId = (a: Actor): string | null => (isAi(a) ? a.userId : a.id);
export const aiActor = (userId: string | null): AiActor => ({ byAi: true, userId });

/** Окно, в котором «Пропустить» убирает статью из конвейера этого сотрудника (сессия). */
const SKIP_WINDOW_MS = 12 * 60 * 60 * 1000;
const PHOTO_EDIT_STATUSES: ArtStatus[] = ["PHOTO_REVIEW", "REVIEW_PENDING", "NEEDS_REWORK"];
const REVIEW_STATUSES: ArtStatus[] = ["REVIEW_PENDING", "NEEDS_REWORK"];

const staleBefore = () => new Date(Date.now() - CLAIM_TTL_MIN * 60_000);

async function event(articleId: string, actor: Actor, action: string, payload?: unknown) {
  await prisma.artModerationEvent
    .create({ data: { articleId, userId: actorId(actor), byAi: isAi(actor), action, payload: payload === undefined ? undefined : (payload as Prisma.InputJsonValue) } })
    .catch(() => {});
}

/** Ошибка модерации в журнал (оригинал: pipeline_errors source=photo_moderation, stage 14). */
async function logError(a: { teamId: string; siteId: string; id: string }, message: string) {
  const signature = `moderation: ${message.toLowerCase().replace(/https?:\/\/\S+/g, "<url>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\d+/g, "<n>").replace(/\s+/g, " ").trim().slice(0, 160)}`;
  await prisma.artError.create({ data: { teamId: a.teamId, siteId: a.siteId, articleId: a.id, stage: "moderation", message: message.slice(0, 4000), signature } }).catch(() => {});
}

async function load(me: Actor, id: string) {
  if (!isAi(me) && !(await canAccessArticle(me, id))) throw new ModerationError("Нет доступа к статье", 403);
  const a = await prisma.article.findUnique({ where: { id }, include: { site: { select: { id: true, name: true, teamId: true, accessId: true, wpCategories: true } } } });
  if (!a) throw new ModerationError("Статья не найдена", 404);
  return a;
}

function expectStatus(a: { status: ArtStatus }, allowed: ArtStatus[]) {
  if (!allowed.includes(a.status)) throw new ModerationError(`Статья уже не на модерации (статус: ${statusLabel(a.status)})`, 409, true);
}

/* ───────────────────────── Закрепление и конвейер ───────────────────────── */

/** Идущие запуски ИИ-модерации: только они держат статьи (Article.aiRunId завершённого запуска — пустой захват). */
export async function liveAiRunIds(): Promise<string[]> {
  const rows = await prisma.artAiModerationRun.findMany({ where: { status: "running" }, select: { id: true } });
  return rows.map((r) => r.id);
}

async function aiRunAlive(runId: string): Promise<boolean> {
  const run = await prisma.artAiModerationRun.findUnique({ where: { id: runId }, select: { status: true } });
  return run?.status === "running";
}

/** Условие «статью не держит идущий запуск ИИ» (для where статей). */
export function notHeldByAi(live: string[]): Prisma.ArticleWhereInput {
  return live.length ? { OR: [{ aiRunId: null }, { aiRunId: { notIn: live } }] } : {};
}

export type ClaimResult = { claimed: true } | { claimed: false; by: string };

/** Закрепить статью за модератором на CLAIM_TTL_MIN минут, если она свободна, своя или закрепление протухло (оригинал :75-91). */
export async function claimArticle(me: CurrentUser, id: string, expect: ArtStatus[] = ["PHOTO_REVIEW"]): Promise<ClaimResult> {
  const a = await load(me, id);
  expectStatus(a, expect);
  const stale = staleBefore();
  // Статью держит запуск ИИ-модерации (Article.aiRunId) — сотрудникам она недоступна до решения ИИ.
  // Захват завершённого/остановленного запуска пустой (тест-режим, autoApply=false, сбой) — снимаем его и работаем.
  if (a.aiRunId) {
    if (await aiRunAlive(a.aiRunId)) return { claimed: false, by: "ИИ-модерация (идёт проверка)" };
    await prisma.article.updateMany({ where: { id, aiRunId: a.aiRunId }, data: { aiRunId: null } });
  }
  const mine = a.claimedById === me.id;
  const free = !a.claimedById || !a.claimedAt || a.claimedAt < stale;
  if (!mine && !free) {
    const u = a.claimedById ? await prisma.user.findUnique({ where: { id: a.claimedById }, select: { name: true } }) : null;
    return { claimed: false, by: u?.name || "другой сотрудник" };
  }
  const r = await prisma.article.updateMany({
    where: { id, status: { in: expect }, OR: [{ claimedById: null }, { claimedById: me.id }, { claimedAt: { lt: stale } }] },
    data: { claimedById: me.id, claimedAt: new Date() },
  });
  if (!r.count) return { claimed: false, by: "другой сотрудник" };
  if (!mine) await event(id, me, "claim");
  return { claimed: true };
}

/** Продлить своё закрепление: любое действие модератора и пинг открытой страницы (раз в минуту). */
export async function extendClaim(me: CurrentUser, id: string): Promise<void> {
  await prisma.article.updateMany({ where: { id, claimedById: me.id }, data: { claimedAt: new Date() } });
}

/** Снять своё закрепление (оригинал: release). */
export async function releaseClaim(me: CurrentUser, id: string): Promise<void> {
  await prisma.article.updateMany({ where: { id, claimedById: me.id }, data: { claimedById: null, claimedAt: null } });
}

/** Пропустить: снять закрепление и записать skip — статья уходит в конец очереди этого сотрудника на сессию. */
export async function skipArticle(me: CurrentUser, id: string): Promise<void> {
  if (!(await canAccessArticle(me, id))) throw new ModerationError("Нет доступа к статье", 403);
  await releaseClaim(me, id);
  await event(id, me, "skip");
}

/**
 * Следующая свободная статья: нужный статус, видимая мне, не закреплённая другим (или закрепление протухло),
 * не пропущенная мной за сессию. Сразу закрепляется. Если остались только пропущенные — берём их (второй круг).
 */
export async function nextForReview(me: CurrentUser, opts: { siteId?: string; statuses?: ArtStatus[]; exclude?: string[] } = {}): Promise<string | null> {
  const statuses = opts.statuses ?? ["PHOTO_REVIEW"];
  const where = await articleWhere(me);
  const stale = staleBefore();
  const live = await liveAiRunIds();
  const skips = await prisma.artModerationEvent.findMany({ where: { userId: me.id, action: "skip", createdAt: { gte: new Date(Date.now() - SKIP_WINDOW_MS) } }, select: { articleId: true } });
  const skipped = new Set(skips.map((s) => s.articleId));
  const exclude = new Set(opts.exclude ?? []);
  const base: Prisma.ArticleWhereInput = {
    ...where,
    status: { in: statuses },
    ...(opts.siteId ? { siteId: opts.siteId } : {}),
    AND: [
      // Захваченные идущим запуском ИИ-модерации статьи людям не раздаём; захват завершённого запуска не считается.
      notHeldByAi(live),
      { OR: [{ claimedById: null }, { claimedById: me.id }, { claimedAt: { lt: stale } }] },
    ],
  };
  for (const pass of [0, 1]) {
    const notIn = pass === 0 ? [...exclude, ...skipped] : [...exclude];
    const rows = await prisma.article.findMany({ where: { ...base, ...(notIn.length ? { id: { notIn } } : {}) }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }], take: 50, select: { id: true } });
    for (const r of rows) {
      const c = await claimArticle(me, r.id, statuses).catch(() => null);
      if (c?.claimed) return r.id;
    }
    if (pass === 0 && !skipped.size) break;
  }
  return null;
}

/** Кто сейчас держит статьи в модерации (живые закрепления). */
export async function activeClaims(me: CurrentUser): Promise<Array<{ articleId: string; keyword: string; siteName: string; userId: string; userName: string; status: ArtStatus }>> {
  const rows = await prisma.article.findMany({
    where: { ...(await articleWhere(me)), status: { in: PHOTO_EDIT_STATUSES }, claimedById: { not: null }, claimedAt: { gte: staleBefore() } },
    select: { id: true, keyword: true, status: true, claimedById: true, site: { select: { name: true } } },
    take: 50,
  });
  const ids = [...new Set(rows.map((r) => r.claimedById!).filter(Boolean))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return rows.map((r) => ({ articleId: r.id, keyword: r.keyword, siteName: r.site.name, userId: r.claimedById!, userName: users.find((u) => u.id === r.claimedById)?.name ?? "—", status: r.status }));
}

/**
 * Сколько статей ждёт по сайтам в данных статусах (табы сайтов). Статьи на проверке у идущего запуска ИИ не считаются:
 * цифра совпадает с тем, что конвейер может выдать людям (закреплённые коллегами считаются — они видны в списке с замком).
 */
export async function waitingCounts(me: CurrentUser, statuses: ArtStatus[]): Promise<{ total: number; sites: Array<{ siteId: string; siteName: string; count: number }> }> {
  const live = await liveAiRunIds();
  const rows = await prisma.article.groupBy({ by: ["siteId"], where: { ...(await articleWhere(me)), status: { in: statuses }, ...notHeldByAi(live) }, _count: { _all: true } });
  const ids = rows.map((r) => r.siteId);
  const sites = ids.length ? await prisma.artSite.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sortOrder: true } }) : [];
  const list = rows
    .map((r) => ({ siteId: r.siteId, siteName: sites.find((s) => s.id === r.siteId)?.name ?? "—", count: r._count._all, order: sites.find((s) => s.id === r.siteId)?.sortOrder ?? 0 }))
    .sort((a, b) => a.order - b.order || a.siteName.localeCompare(b.siteName, "ru"));
  return { total: list.reduce((a, b) => a + b.count, 0), sites: list.map((s) => ({ siteId: s.siteId, siteName: s.siteName, count: s.count })) };
}

/* ───────────────────────── Очередь модерации фото списком ───────────────────────── */

/** Группы очереди: от ИИ (ИИ проверил и отдал людям / предложил в тесте), новые (ИИ не смотрел), мало фото. */
export type PhotoQueueGroup = "ai" | "new" | "low";

export type PhotoQueueItem = {
  id: string;
  keyword: string;
  keywordRu: string;
  siteId: string;
  siteName: string;
  status: ArtStatus;
  group: PhotoQueueGroup;
  /** С какого момента ждёт (решение ИИ или конец последнего этапа воркера), ISO */
  waitingSince: string;
  photos: number;
  norm: number;
  claimedByName: string | null;
  claimedMine: boolean;
  /** Кратко, что сказал ИИ (причины «людям», «предложение теста», «ошибка проверки») */
  aiNote: string | null;
  aiConfidence: number | null;
  /** «Мало фото»: причина и кто поставил */
  lowReason: string | null;
  lowByAi: boolean;
};

export type PhotoQueue = {
  items: PhotoQueueItem[];
  counts: { ai: number; new: number; low: number; aiBusy: number; claimedByOthers: number };
};

const QUEUE_STATUSES: ArtStatus[] = ["PHOTO_REVIEW", "INSUFFICIENT_PHOTOS", "WAITING_FOR_PHOTOS"];
/** Решения ИИ, которые показываем людям (superseded — заменено перепроверкой, processing — ещё идёт). */
const AI_SHOWN_STATUSES = ["sent_to_human", "proposed", "applying", "applied", "excluded", "failed"];

/** Короткая подпись решения ИИ для списка и шапки. */
function aiNoteOf(r: { status: string; decision: string | null; confidence: number | null; review: unknown; error: string | null }, runMode: string): string {
  const reasons = (((r.review ?? {}) as { humanReasons?: unknown }).humanReasons ?? []) as unknown[];
  const why = Array.isArray(reasons) ? reasons.map(String).filter(Boolean).join("; ") : "";
  if (r.status === "failed") return `ИИ не смог проверить${r.error ? `: ${r.error}` : ""}`;
  if (r.status === "excluded") return "ИИ: отдано людям без правок";
  if (r.status === "proposed" || r.status === "applying") {
    const d = r.decision === "approve" ? "одобрить" : r.decision === "insufficient" ? "мало фото" : "людям";
    return `Предложение ИИ${runMode === "test" ? " (тест)" : ""}, правки не применены: ${d}${why ? ` — ${why}` : ""}`;
  }
  if (r.decision === "approve") return `ИИ за одобрение, но не уверен${why ? `: ${why}` : ""}`;
  return why ? `Отдано людям: ${why}` : "Отдано людям";
}

/**
 * Очередь модерации фото для списка: PHOTO_REVIEW (группы «От ИИ» / «Новые») и «Мало фото»
 * (INSUFFICIENT_PHOTOS / WAITING_FOR_PHOTOS). Ничего не закрепляет. Статьи на проверке у идущего запуска ИИ
 * в список не входят, только в счётчик aiBusy.
 */
export async function photoQueue(me: CurrentUser, opts: { siteId?: string } = {}): Promise<PhotoQueue> {
  const live = await liveAiRunIds();
  const rows = await prisma.article.findMany({
    where: { ...(await articleWhere(me)), status: { in: QUEUE_STATUSES }, ...(opts.siteId ? { siteId: opts.siteId } : {}) },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: 500,
    select: {
      id: true, keyword: true, keywordRu: true, facts: true, siteId: true, status: true, photoCount: true, createdAt: true,
      claimedById: true, claimedAt: true, aiRunId: true, insufficientReason: true, insufficientByAi: true,
      site: { select: { name: true } },
      _count: { select: { photos: { where: { excluded: false } } } },
    },
  });
  const liveSet = new Set(live);
  const busy = rows.filter((r) => r.status === "PHOTO_REVIEW" && r.aiRunId && liveSet.has(r.aiRunId));
  const list = rows.filter((r) => !busy.includes(r));
  const ids = list.map((r) => r.id);
  const results = ids.length
    ? await prisma.artAiModerationResult.findMany({
        where: { articleId: { in: ids }, status: { in: AI_SHOWN_STATUSES } },
        orderBy: { createdAt: "desc" },
        select: { articleId: true, status: true, decision: true, confidence: true, review: true, error: true, updatedAt: true, run: { select: { mode: true } } },
      })
    : [];
  const logs = ids.length ? await prisma.artStageLog.groupBy({ by: ["articleId"], where: { articleId: { in: ids } }, _max: { finishedAt: true } }) : [];
  const lastResult = new Map<string, (typeof results)[number]>();
  for (const r of results) if (!lastResult.has(r.articleId)) lastResult.set(r.articleId, r);
  const lastLog = new Map(logs.map((l) => [l.articleId, l._max.finishedAt]));
  const stale = staleBefore().getTime();
  const claimers = [...new Set(list.map((r) => r.claimedById).filter((x): x is string => !!x && x !== me.id))];
  const users = claimers.length ? await prisma.user.findMany({ where: { id: { in: claimers } }, select: { id: true, name: true } }) : [];

  const items: PhotoQueueItem[] = list.map((r) => {
    const res = lastResult.get(r.id);
    const low = r.status !== "PHOTO_REVIEW";
    const fromAi = !low && !!res && res.status !== "failed";
    const fresh = !!r.claimedById && !!r.claimedAt && r.claimedAt.getTime() > stale;
    const since = (fromAi && res ? res.updatedAt : null) ?? lastLog.get(r.id) ?? r.createdAt;
    return {
      id: r.id,
      keyword: r.keyword,
      keywordRu: r.keywordRu || ((r.facts as ArticleFacts | null)?.keywordRu ?? ""),
      siteId: r.siteId,
      siteName: r.site.name,
      status: r.status,
      group: low ? "low" : fromAi ? "ai" : "new",
      waitingSince: since.toISOString(),
      photos: r._count.photos,
      norm: r.photoCount,
      claimedByName: fresh ? (r.claimedById === me.id ? "вы" : users.find((u) => u.id === r.claimedById)?.name ?? "другой сотрудник") : null,
      claimedMine: fresh && r.claimedById === me.id,
      aiNote: res ? aiNoteOf(res, res.run.mode) : null,
      aiConfidence: res?.confidence ?? null,
      lowReason: low ? r.insufficientReason || (r.status === "WAITING_FOR_PHOTOS" ? "Воркер не набрал нужного числа фото" : null) : null,
      lowByAi: low && r.insufficientByAi,
    };
  });
  // «От ИИ» — сначала самые давние решения; остальные — в порядке конвейера (приоритет, возраст).
  const ai = items.filter((i) => i.group === "ai").sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
  const ordered = [...ai, ...items.filter((i) => i.group !== "ai")];
  const counts = {
    ai: ai.length,
    new: items.filter((i) => i.group === "new").length,
    low: items.filter((i) => i.group === "low").length,
    aiBusy: busy.length,
    claimedByOthers: items.filter((i) => i.group !== "low" && i.claimedByName && !i.claimedMine).length,
  };
  return { items: ordered, counts };
}

/** Почему конвейер ничего не выдал: сколько статей у идущего запуска ИИ и у коллег (для пустого состояния). */
export async function queueBlockers(me: CurrentUser, siteId?: string): Promise<{ aiBusy: number; claimedByOthers: number }> {
  const live = await liveAiRunIds();
  const base: Prisma.ArticleWhereInput = { ...(await articleWhere(me)), status: "PHOTO_REVIEW", ...(siteId ? { siteId } : {}) };
  const [aiBusy, claimedByOthers] = await Promise.all([
    live.length ? prisma.article.count({ where: { ...base, aiRunId: { in: live } } }) : Promise.resolve(0),
    prisma.article.count({ where: { ...base, ...notHeldByAi(live), claimedById: { not: me.id }, claimedAt: { gte: staleBefore() } } }),
  ]);
  return { aiBusy, claimedByOthers };
}

/* ───────────────────────── Состояние фото для сетки ───────────────────────── */

export type ModPhoto = {
  id: string;
  position: number;
  candidateId: string | null;
  thumbUrl: string;
  imageUrl: string;
  width: number | null;
  height: number | null;
  sourceDomain: string;
  sourcePageUrl: string;
  aiScore: number | null;
  hasDescription: boolean;
  excluded: boolean;
  excludedByAi: boolean;
  altText: string;
};

export type ModCandidate = {
  id: string;
  thumbUrl: string;
  imageUrl: string;
  width: number | null;
  height: number | null;
  domain: string;
  pageUrl: string;
  aiScore: number | null;
  beautyRank: number | null;
  virality: number | null;
  trend: number | null;
  trendReason: string;
  /** Причина отклонения ИИ или заметка оценки */
  reason: string;
  status: string;
  hasDescription: boolean;
};

export type PhotoModerationState = {
  article: {
    id: string;
    keyword: string;
    keywordRu: string;
    siteId: string;
    siteName: string;
    status: ArtStatus;
    stage: string;
    format: string;
    photoCount: number;
    note: string | null;
    error: string | null;
    trend: { in: string[]; out: string[] } | null;
    claimedById: string | null;
  };
  photos: ModPhoto[];
  reserve: ModCandidate[];
  rejected: ModCandidate[];
  counts: { active: number; excluded: number; reserve: number; rejected: number; needMin: number; canApprove: boolean; missing: number };
  /** Последнее решение ИИ-модерации по статье (не заменённое перепроверкой); null — ИИ статью не смотрел. */
  ai: ModAiContext | null;
};

/** Решение ИИ для шапки и пометок в сетке модерации фото. */
export type ModAiContext = {
  resultId: string;
  status: string;
  decision: string | null;
  confidence: number | null;
  /** Подпись для шапки: «Отдано людям: …», «Предложение ИИ (тест)…» */
  note: string;
  reasons: string[];
  summary: string;
  /** Норма фото, которую видел ИИ (план статьи) */
  norm: number;
  removedCount: number;
  addedCount: number;
  /** Правки ИИ внесены в статью (sent_to_human/applied); false — только предложение (тест, autoApply выкл.) */
  applied: boolean;
  /** photoId → причина: снятые ИИ (applied) или предложенные к снятию (не applied) */
  removed: Record<string, string>;
  /** photoId → причина: кадры, которые ИИ добавил из резерва и которые сейчас в статье */
  added: Record<string, string>;
  /** candidateId → причина: предложено добавить (только пока правки не применены) */
  proposedAdds: Record<string, string>;
  /** Есть что откатить кнопкой «Отменить правки ИИ» */
  canUndo: boolean;
  at: string;
};

type AiResultRow = {
  id: string; status: string; decision: string | null; confidence: number | null; summary: string | null; error: string | null;
  review: unknown; removed: unknown; added: unknown; originalIds: unknown; updatedAt: Date; run: { mode: string };
};

async function latestAiResult(articleId: string): Promise<AiResultRow | null> {
  return prisma.artAiModerationResult.findFirst({
    where: { articleId, status: { in: AI_SHOWN_STATUSES } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, decision: true, confidence: true, summary: true, error: true, review: true, removed: true, added: true, originalIds: true, updatedAt: true, run: { select: { mode: true } } },
  });
}

const jsonArr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Коды причин снятия ИИ (aiModerationRules.REMOVE_REASONS) → по-русски для сотрудника. */
const AI_REASON_RU: Record<string, string> = {
  off_topic: "не по теме",
  wrong_detail: "не та деталь из ключа",
  ai_fake: "похоже на ИИ-картинку",
  watermark_logo: "водяной знак / логотип / текст",
  collage_text: "коллаж или скриншот",
  catalogue: "карточка магазина",
  wrong_audience: "не та аудитория",
  duplicate: "дубль",
  weak_pin: "слабый пин",
};

/** «collage_text: » → «коллаж или скриншот»; «off_topic: другой фасон» → «не по теме: другой фасон». */
function reasonRu(raw: string): string {
  const t = raw.trim();
  const m = /^([a-z_]+)\s*:?\s*(.*)$/.exec(t);
  if (m && AI_REASON_RU[m[1]]) return m[2] ? `${AI_REASON_RU[m[1]]}: ${m[2]}` : AI_REASON_RU[m[1]];
  return t.replace(/:\s*$/, "");
}

/** Что ИИ сделал с фото статьи: снятые (с причинами из решения или событий), добавленные из резерва, исходный порядок. */
async function aiEditsOf(articleId: string, res: AiResultRow, photos: Array<{ id: string; candidateId: string | null; excluded: boolean; excludedByAi: boolean }>) {
  const original = new Set(jsonArr<string>(res.originalIds).map(String));
  const removedReason = new Map(jsonArr<{ photoId: string; reason?: string }>(res.removed).map((r) => [String(r.photoId), String(r.reason ?? "")]));
  const addedReason = new Map(jsonArr<{ candidateId: string; reason?: string | null }>(res.added).map((r) => [String(r.candidateId), String(r.reason ?? "")]));
  // Причина снятия ИИ без строки в решении (старые решения) — из события exclude с byAi.
  const missing = photos.filter((p) => p.excluded && p.excludedByAi && !removedReason.has(p.id)).map((p) => p.id);
  if (missing.length) {
    const evs = await prisma.artModerationEvent.findMany({ where: { articleId, byAi: true, action: "exclude" }, select: { payload: true } });
    for (const e of evs) {
      const pl = (e.payload ?? {}) as { photoId?: string; reason?: string | null };
      if (pl.photoId && missing.includes(pl.photoId)) removedReason.set(pl.photoId, String(pl.reason ?? ""));
    }
  }
  const aiRemoved = photos.filter((p) => p.excluded && p.excludedByAi);
  const aiAdded = photos.filter((p) => !original.has(p.id) && !!p.candidateId && addedReason.has(p.candidateId));
  return { original, removedReason, addedReason, aiRemoved, aiAdded };
}

async function aiContext(articleId: string, photos: Array<{ id: string; candidateId: string | null; excluded: boolean; excludedByAi: boolean }>): Promise<ModAiContext | null> {
  const res = await latestAiResult(articleId);
  if (!res) return null;
  const review = (res.review ?? {}) as { humanReasons?: unknown; needed?: unknown };
  const reasons = jsonArr<unknown>(review.humanReasons).map(String).filter(Boolean);
  const applied = res.status === "sent_to_human" || res.status === "applied";
  const e = await aiEditsOf(articleId, res, photos);
  const removed: Record<string, string> = {};
  if (applied) for (const p of e.aiRemoved) removed[p.id] = reasonRu(e.removedReason.get(p.id) || "") || "снято ИИ";
  else for (const [id, why] of e.removedReason) if (photos.some((p) => p.id === id && !p.excluded)) removed[id] = reasonRu(why) || "ИИ предлагает убрать";
  const added: Record<string, string> = {};
  if (applied) for (const p of e.aiAdded) added[p.id] = e.addedReason.get(p.candidateId!) || "";
  const proposedAdds: Record<string, string> = {};
  if (!applied) for (const [id, why] of e.addedReason) proposedAdds[id] = why;
  return {
    resultId: res.id,
    status: res.status,
    decision: res.decision,
    confidence: res.confidence,
    note: aiNoteOf(res, res.run.mode),
    reasons,
    summary: res.summary ?? "",
    norm: typeof review.needed === "number" ? review.needed : 0,
    removedCount: jsonArr(res.removed).length,
    addedCount: jsonArr(res.added).length,
    applied,
    removed,
    added,
    proposedAdds,
    canUndo: applied && (e.aiRemoved.length > 0 || e.aiAdded.length > 0),
    at: res.updatedAt.toISOString(),
  };
}

function trendFromFacts(facts: unknown): { in: string[]; out: string[] } | null {
  const f = (facts ?? {}) as ArticleFacts;
  const tb = (f.trendBrief ?? {}) as Record<string, unknown>;
  const src = (tb.ru as Record<string, unknown> | undefined) ?? (tb.trend_brief_ru as Record<string, unknown> | undefined) ?? tb;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const inn = arr(src.in ?? src.trending ?? src.modno);
  const out = arr(src.out ?? src.dated ?? src.ustarelo);
  return inn.length || out.length ? { in: inn, out } : null;
}

function candView(c: { id: string; url: string; pageUrl: string; domain: string; thumbUrl: string; path: string; thumbPath: string; width: number | null; height: number | null; aiScore: number | null; beautyRank: number | null; aiBreakdown: unknown; rejectReason: string | null; status: string; aiDescription: string | null; aiFacts: unknown }): ModCandidate {
  const b = (c.aiBreakdown ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: c.id,
    // Миниатюры — только с нашего сервера; внешняя — лишь когда файла нет (кандидат найден, но не скачан).
    thumbUrl: c.thumbPath ? publicUrl(c.thumbPath) : c.thumbUrl || c.url,
    imageUrl: c.path ? publicUrl(c.path) : c.url,
    width: c.width,
    height: c.height,
    domain: c.domain,
    pageUrl: c.pageUrl,
    aiScore: c.aiScore,
    beautyRank: c.beautyRank,
    virality: num(b.virality),
    trend: num(b.trend),
    trendReason: typeof b.trend_reason === "string" ? b.trend_reason : "",
    reason: c.rejectReason || (typeof b.reason === "string" ? b.reason : "") || (typeof b.beauty_note === "string" ? b.beauty_note : ""),
    status: c.status,
    hasDescription: !!(c.aiDescription || c.aiFacts),
  };
}

/** Полное состояние фото статьи для сетки модерации (и вкладки «Фото» карточки). */
export async function photoState(me: Actor, articleId: string): Promise<PhotoModerationState> {
  const a = await load(me, articleId);
  const [photos, cands] = await Promise.all([
    prisma.artPhoto.findMany({ where: { articleId }, orderBy: { position: "asc" } }),
    prisma.artPhotoCandidate.findMany({
      where: { articleId, OR: [{ status: { in: ["reserve", "keep"] } }, { status: "rejected", rejectStage: "rate" }] },
      orderBy: [{ beautyRank: "asc" }, { aiScore: "desc" }],
    }),
  ]);
  const used = new Set(photos.map((p) => p.candidateId).filter(Boolean));
  const usedSha = new Set(photos.map((p) => p.sha256).filter(Boolean));
  const free = cands.filter((c) => !used.has(c.id) && !(c.sha256 && usedSha.has(c.sha256)));
  const reserve = free.filter((c) => c.status !== "rejected").map(candView);
  const rejected = free.filter((c) => c.status === "rejected").map(candView);
  const active = photos.filter((p) => !p.excluded).length;
  const needMin = Math.min(MIN_PHOTOS, Math.max(1, a.photoCount));
  return {
    article: {
      id: a.id,
      keyword: a.keyword,
      keywordRu: a.keywordRu || ((a.facts as ArticleFacts | null)?.keywordRu ?? ""),
      siteId: a.siteId,
      siteName: a.site.name,
      status: a.status,
      stage: a.stage,
      format: a.format,
      photoCount: a.photoCount,
      note: a.note,
      error: a.error,
      trend: trendFromFacts(a.facts),
      claimedById: a.claimedById,
    },
    photos: photos.map((p) => ({
      id: p.id,
      position: p.position,
      candidateId: p.candidateId,
      thumbUrl: p.thumbPath ? publicUrl(p.thumbPath) : p.path ? publicUrl(p.path) : p.publicUrl || p.sourceUrl,
      imageUrl: p.path ? publicUrl(p.path) : p.publicUrl || p.sourceUrl,
      width: p.width,
      height: p.height,
      sourceDomain: p.sourceDomain,
      sourcePageUrl: p.sourcePageUrl,
      aiScore: p.aiScore,
      hasDescription: !!(p.description || p.facts),
      excluded: p.excluded,
      excludedByAi: p.excludedByAi,
      altText: p.altText,
    })),
    reserve,
    rejected,
    counts: { active, excluded: photos.length - active, reserve: reserve.length, rejected: rejected.length, needMin, canApprove: active >= needMin, missing: Math.max(0, needMin - active) },
    ai: a.status === "PHOTO_REVIEW" ? await aiContext(articleId, photos) : null,
  };
}

/**
 * «Отменить правки ИИ»: вернуть снятые ИИ кадры, убрать добавленные ИИ из резерва и восстановить порядок до решения ИИ
 * (кадры, добавленные людьми после ИИ, остаются в конце). Только PHOTO_REVIEW, статью не держит другой модератор.
 * Работает через restorePhoto/removePhoto/reorderPhotos (их события тоже пишутся) + итоговое событие ai_undo.
 */
export async function undoAiEdits(me: CurrentUser, articleId: string): Promise<{ restored: number; removed: number; message: string }> {
  const a = await load(me, articleId);
  expectStatus(a, ["PHOTO_REVIEW"]);
  if (a.aiRunId && (await aiRunAlive(a.aiRunId))) throw new ModerationError("Статью сейчас проверяет ИИ — дождитесь решения", 409);
  if (a.claimedById && a.claimedById !== me.id && a.claimedAt && a.claimedAt >= staleBefore()) {
    const u = await prisma.user.findUnique({ where: { id: a.claimedById }, select: { name: true } });
    throw new ModerationError(`Статью сейчас модерирует ${u?.name || "другой сотрудник"}`, 409);
  }
  const res = await latestAiResult(articleId);
  if (!res) throw new ModerationError("ИИ эту статью не проверял — отменять нечего", 400);
  if (res.status !== "sent_to_human" && res.status !== "applied") throw new ModerationError("Правки ИИ к статье не применялись (только предложение) — отменять нечего", 400);
  const photos = await prisma.artPhoto.findMany({ where: { articleId }, orderBy: { position: "asc" }, select: { id: true, candidateId: true, excluded: true, excludedByAi: true } });
  const e = await aiEditsOf(articleId, res, photos);
  if (!e.aiRemoved.length && !e.aiAdded.length) throw new ModerationError("Правок ИИ в статье уже нет", 400);
  for (const p of e.aiRemoved) await restorePhoto(me, articleId, p.id);
  for (const p of e.aiAdded) await removePhoto(me, articleId, p.id);
  const left = new Set(photos.map((p) => p.id));
  const order = [...e.original].filter((id) => left.has(id));
  if (order.length) await reorderPhotos(me, articleId, order);
  await extendClaim(me, articleId);
  await event(articleId, me, "ai_undo", { resultId: res.id, restored: e.aiRemoved.length, removed: e.aiAdded.length });
  return { restored: e.aiRemoved.length, removed: e.aiAdded.length, message: `Правки ИИ отменены: возвращено ${e.aiRemoved.length}, убрано ${e.aiAdded.length}, порядок как до проверки` };
}

/* ───────────────────────── Действия с фото ───────────────────────── */

async function photoOf(articleId: string, photoId: string) {
  const p = await prisma.artPhoto.findFirst({ where: { id: photoId, articleId } });
  if (!p) throw new ModerationError("Фото не найдено", 404);
  return p;
}

/** Исключить фото (остаётся в базе до одобрения — для «Отменить»). reason: "outdated" = «Устарело» (оригинал: remove reason=dated). */
export async function excludePhoto(me: Actor, articleId: string, photoId: string, reason?: string): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, PHOTO_EDIT_STATUSES);
  await photoOf(articleId, photoId);
  await prisma.artPhoto.update({ where: { id: photoId }, data: { excluded: true, excludedById: actorId(me), excludedByAi: isAi(me) } });
  await event(articleId, me, "exclude", { photoId, reason: reason ?? null });
}

/** «Устарело»: исключение с причиной — отдельная статистика (оригинал: событие remove_dated). */
export async function markOutdated(me: Actor, articleId: string, photoId: string): Promise<void> {
  await excludePhoto(me, articleId, photoId, "outdated");
}

export async function restorePhoto(me: Actor, articleId: string, photoId: string): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, PHOTO_EDIT_STATUSES);
  await photoOf(articleId, photoId);
  await prisma.artPhoto.update({ where: { id: photoId }, data: { excluded: false, excludedById: null, excludedByAi: false } });
  await event(articleId, me, "restore", { photoId });
}

/** Перенумеровать позиции 1..N в текущем порядке (оригинал: RPC renumber_article_photos без порядка). */
async function renumber(articleId: string) {
  const photos = await prisma.artPhoto.findMany({ where: { articleId }, orderBy: { position: "asc" }, select: { id: true, position: true } });
  const updates = photos.flatMap((p, i) => (p.position === i + 1 ? [] : [prisma.artPhoto.update({ where: { id: p.id }, data: { position: i + 1 } })]));
  if (updates.length) await prisma.$transaction(updates);
}

/**
 * Новый порядок фото: переданные id — в начале, остальные — в конце в прежнем порядке.
 * Если секции уже написаны (REVIEW_PENDING), они едут вместе с фото и перенумеровываются
 * заголовки вида «N. …» (оригинал: reorder-article-sections/index.ts).
 */
export async function reorderPhotos(me: Actor, articleId: string, orderedIds: string[]): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, PHOTO_EDIT_STATUSES);
  const photos = await prisma.artPhoto.findMany({ where: { articleId }, orderBy: { position: "asc" }, select: { id: true, excluded: true } });
  const known = new Set(photos.map((p) => p.id));
  const order = [...new Set(orderedIds.filter((id) => known.has(id)))];
  for (const p of photos) if (!order.includes(p.id)) order.push(p.id);
  const sections = await prisma.artSection.findMany({ where: { articleId, photoId: { not: null } }, select: { id: true, photoId: true, position: true, heading: true } });
  await prisma.$transaction(async (tx) => {
    // Уникальный индекс (articleId, position) не даёт менять секции местами — сначала уводим в отрицательные.
    for (const s of sections) await tx.artSection.update({ where: { id: s.id }, data: { position: -(Math.abs(s.position) || 1) } });
    let visible = 0;
    for (let i = 0; i < order.length; i++) {
      const pos = i + 1;
      await tx.artPhoto.update({ where: { id: order[i] }, data: { position: pos } });
      const sec = sections.find((s) => s.photoId === order[i]);
      if (!sec) continue;
      const patch: { position: number; heading?: string } = { position: pos };
      if (!photos.find((p) => p.id === order[i])?.excluded) {
        visible++;
        const raw = sec.heading || "";
        if (/^\s*\d+\s*[.)\-–]\s*/.test(raw)) patch.heading = `${visible}. ${raw.replace(/^\s*\d+\s*[.)\-–]\s*/, "").trim()}`;
      }
      await tx.artSection.update({ where: { id: sec.id }, data: patch });
    }
  });
  await event(articleId, me, "reorder", { order });
}

const DOWNLOAD_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Mozilla/5.0 (compatible; ZewexBot/1.0)",
];

/** Скачать картинку кандидата заново (оригинал :138-173: адреса × UA, Referer страницы, ≤12 с на попытку, 45 с всего, ≥2000 байт). */
async function downloadCandidate(c: { url: string; thumbUrl: string; pageUrl: string }): Promise<Buffer | null> {
  const urls = [...new Set([c.url, c.thumbUrl].filter(Boolean))];
  const deadline = Date.now() + 45_000;
  for (const u of urls) {
    for (const ua of DOWNLOAD_UAS) {
      const left = deadline - Date.now();
      if (left < 3_000) return null;
      try {
        const headers: Record<string, string> = { "User-Agent": ua, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" };
        if (c.pageUrl && !u.includes("gstatic")) headers.Referer = c.pageUrl;
        const r = await safeFetch(u, { timeoutMs: Math.min(12_000, left), headers, maxBytes: 25 * 1024 * 1024 });
        if (!r.ok) continue;
        const ct = (r.headers.get("content-type") || "").split(";")[0].trim();
        if (!ct.startsWith("image/")) continue;
        if (r.body.length < 2000) continue;
        return r.body;
      } catch {
        /* следующий адрес */
      }
    }
  }
  return null;
}

export type AddResult = { ok: true; photoId: string; already?: boolean; message?: string };

/**
 * Добавить кандидата из резерва в конец статьи (оригинал :115-211). Кандидат — reserve/keep или отклонённый
 * на ИИ-оценке (технические фильтры он прошёл; оригинал проверял tech_status=ok). Дубли по sha256/phash
 * запрещены; если дубль — исключённое фото статьи, оно просто возвращается.
 */
export async function addFromReserve(me: Actor, articleId: string, candidateId: string): Promise<AddResult> {
  const a = await load(me, articleId);
  expectStatus(a, PHOTO_EDIT_STATUSES);
  const c = await prisma.artPhotoCandidate.findFirst({ where: { id: candidateId, articleId } });
  if (!c) throw new ModerationError("Фото из резерва не найдено", 404);
  if (!(["reserve", "keep", "selected"].includes(c.status) || (c.status === "rejected" && c.rejectStage === "rate"))) {
    throw new ModerationError("Фото не прошло технические фильтры — его нельзя добавить", 400);
  }
  const photos = await prisma.artPhoto.findMany({ where: { articleId }, select: { id: true, candidateId: true, sha256: true, phash: true, excluded: true, position: true } });
  const dup = photos.find((p) => p.candidateId === c.id || (c.sha256 && p.sha256 === c.sha256) || (c.phash && p.phash === c.phash));
  if (dup) {
    if (dup.excluded) {
      await restorePhoto(me, articleId, dup.id);
      return { ok: true, photoId: dup.id, already: true, message: "Это фото уже было в статье — возвращено" };
    }
    return { ok: true, photoId: dup.id, already: true, message: "Это фото (или его копия) уже есть в статье" };
  }

  // Файл: оригинал кандидата, если ещё не удалён после отбора; иначе скачиваем заново.
  let bytes: Buffer | null = null;
  if (c.path && (await exists(c.path))) bytes = await readFile(absPath(c.path));
  if (!bytes) bytes = await downloadCandidate(c);
  if (!bytes) {
    await logError(a, `Модерация фото (add): не удалось скачать фото с источника ${c.domain || ""}`);
    throw new ModerationError("Не удалось скачать фото с источника — выберите другое", 400);
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  const jpeg = await toWpJpeg(bytes);
  const photoId = randomUUID();
  const rel = photoRel(articleId, photoId);
  const thumbRel = photoThumbRel(articleId, photoId);
  await writeFileAtomic(rel, jpeg.bytes);
  await writeFileAtomic(thumbRel, await makeThumb(jpeg.bytes));
  const position = photos.reduce((m, p) => Math.max(m, p.position), 0) + 1;
  try {
    await prisma.artPhoto.create({
      data: {
        id: photoId,
        articleId,
        candidateId: c.id,
        position,
        path: rel,
        thumbPath: thumbRel,
        publicUrl: publicUrl(rel),
        sourceUrl: c.url,
        sourcePageUrl: c.pageUrl,
        sourceDomain: c.domain,
        width: jpeg.width,
        height: jpeg.height,
        sha256: c.sha256 || sha,
        phash: c.phash,
        altText: (c.title || "").slice(0, 500),
        fileName: `${photoId}.jpg`,
        facts: (c.aiFacts ?? undefined) as Prisma.InputJsonValue | undefined,
        description: c.aiDescription,
        aiScore: c.aiScore,
      },
    });
  } catch (e) {
    await removePath(rel).catch(() => {});
    await removePath(thumbRel).catch(() => {});
    throw e;
  }
  await prisma.artPhotoCandidate.update({ where: { id: c.id }, data: { status: "selected" } });
  await event(articleId, me, "add", { photoId, candidateId: c.id });
  return { ok: true, photoId };
}

/** Убрать фото совсем (отмена «добавить»): файлы удаляются, кандидат возвращается в резерв. */
export async function removePhoto(me: Actor, articleId: string, photoId: string): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, PHOTO_EDIT_STATUSES);
  const p = await photoOf(articleId, photoId);
  await prisma.artPhoto.delete({ where: { id: photoId } });
  if (p.candidateId) await prisma.artPhotoCandidate.updateMany({ where: { id: p.candidateId, status: "selected" }, data: { status: "reserve" } });
  if (p.path) await removePath(p.path).catch(() => {});
  if (p.thumbPath) await removePath(p.thumbPath).catch(() => {});
  await renumber(articleId);
  await event(articleId, me, "remove", { photoId, candidateId: p.candidateId });
}

/* ───────────────────────── Решения по статье на модерации фото ───────────────────────── */

/**
 * Одобрить фото и отправить писать текст (оригинал :229-270). Разрешено, если активных фото ≥ MIN_PHOTOS
 * или ≥ плана статьи. Исключённые удаляются (кандидат остаётся в резерве), позиции 1..N, старые секции/план
 * удаляются (текст больше не соответствует фото), отпечатки фото перезаписываются, статья → PENDING с первого
 * этапа цепочки «написание».
 */
export async function approvePhotos(me: Actor, articleId: string): Promise<{ photos: number }> {
  const a = await load(me, articleId);
  expectStatus(a, ["PHOTO_REVIEW"]);
  const photos = await prisma.artPhoto.findMany({ where: { articleId }, orderBy: { position: "asc" } });
  const active = photos.filter((p) => !p.excluded);
  const excluded = photos.filter((p) => p.excluded);
  const needMin = Math.min(MIN_PHOTOS, Math.max(1, a.photoCount));
  if (active.length < needMin) {
    throw new ModerationError(`Нужно ещё ${needMin - active.length} фото: в статье ${active.length}, нужно не меньше ${needMin} (минимум ${MIN_PHOTOS} или план статьи ${a.photoCount}). Добавьте из резерва или нажмите «Добрать фото».`, 400);
  }
  if (excluded.length) {
    await prisma.artPhoto.deleteMany({ where: { id: { in: excluded.map((p) => p.id) } } });
    const candIds = excluded.map((p) => p.candidateId).filter((x): x is string => !!x);
    if (candIds.length) await prisma.artPhotoCandidate.updateMany({ where: { id: { in: candIds }, status: "selected" }, data: { status: "reserve" } });
    for (const p of excluded) {
      if (p.path) await removePath(p.path).catch(() => {});
      if (p.thumbPath) await removePath(p.thumbPath).catch(() => {});
    }
  }
  await prisma.$transaction(active.map((p, i) => prisma.artPhoto.update({ where: { id: p.id }, data: { position: i + 1 } })));
  await prisma.artSection.deleteMany({ where: { articleId } });

  // Отпечатки использованных фото — чтобы другие сайты их не повторяли (оригинал :251-259).
  await prisma.artPhotoFingerprint.deleteMany({ where: { articleId } });
  const fps = active.filter((p) => p.sha256 || p.phash).map((p) => ({ teamId: a.teamId, siteId: a.siteId, articleId, sha256: p.sha256, phash: p.phash, sourceUrl: p.sourceUrl }));
  if (fps.length) await prisma.artPhotoFingerprint.createMany({ data: fps });

  const cursor = { ...((a.cursor ?? {}) as ArticleCursor) };
  delete cursor.topup;
  cursor.photoReviewApproved = true;
  const r = await prisma.article.updateMany({
    where: { id: articleId, status: "PHOTO_REVIEW" },
    data: {
      status: "PENDING",
      stage: firstWritingStage(a.format),
      attempts: 0,
      error: null,
      errorStage: null,
      nextRunAt: null,
      plan: Prisma.DbNull,
      introHtml: null,
      outroHtml: null,
      html: null,
      cursor: cursor as object,
      moderatedById: actorId(me),
      moderatedAt: new Date(),
      claimedById: null,
      claimedAt: null,
      aiRunId: null,
    },
  });
  if (!r.count) throw new ModerationError("Статью уже забрал воркер или другой модератор", 409, true);
  await event(articleId, me, "approve", { photos: active.length, removed: excluded.length });
  return { photos: active.length };
}

/** «Добрать фото»: статья уходит в поиск с меткой добора и вернётся на модерацию с пополненным резервом (оригинал :213-227). */
export async function requestTopup(me: Actor, articleId: string, reason = ""): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, ["PHOTO_REVIEW", "INSUFFICIENT_PHOTOS", "WAITING_FOR_PHOTOS"]);
  const active = await prisma.artPhoto.count({ where: { articleId, excluded: false } });
  const topup = { from: "moderation", needed: Math.max(1, a.photoCount - active), reason: reason.slice(0, 500) };
  const cursor: ArticleCursor = { ...((a.cursor ?? {}) as ArticleCursor), topup };
  const r = await prisma.article.updateMany({
    where: { id: articleId, status: a.status },
    data: {
      status: "PENDING",
      stage: "search",
      attempts: 0,
      error: null,
      errorStage: null,
      nextRunAt: null,
      cursor: cursor as object,
      insufficientReason: null,
      insufficientById: null,
      claimedById: null,
      claimedAt: null,
      aiRunId: null,
      moderatedById: null,
      moderatedAt: null,
    },
  });
  if (!r.count) throw new ModerationError("Статья уже сменила статус", 409, true);
  await event(articleId, me, "topup", { reason, needed: topup.needed });
}

/** «Мало фото»: статья не пишется, уходит в отдельный список с причиной (оригинал :64-73). */
export async function markInsufficient(me: Actor, articleId: string, reason: string): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, ["PHOTO_REVIEW"]);
  const r = await prisma.article.updateMany({
    where: { id: articleId, status: "PHOTO_REVIEW" },
    data: { status: "INSUFFICIENT_PHOTOS", insufficientReason: reason.trim().slice(0, 500) || null, insufficientById: actorId(me), insufficientByAi: isAi(me), claimedById: null, claimedAt: null, aiRunId: null },
  });
  if (!r.count) throw new ModerationError("Статья уже сменила статус", 409, true);
  await event(articleId, me, "insufficient", { reason });
}

/** Вернуть статью из «Мало фото» (или «Не хватило фото») на модерацию фото. */
export async function returnToReview(me: Actor, articleId: string): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, ["INSUFFICIENT_PHOTOS", "WAITING_FOR_PHOTOS"]);
  const r = await prisma.article.updateMany({ where: { id: articleId, status: a.status }, data: { status: "PHOTO_REVIEW", insufficientReason: null, insufficientById: null, insufficientByAi: false, error: null, claimedById: null, claimedAt: null } });
  if (!r.count) throw new ModerationError("Статья уже сменила статус", 409, true);
  await event(articleId, me, "return_review");
}

/** Закрыть статью из «Мало фото» (вкладка ИИ-модерации «Закрыть»): INSUFFICIENT_PHOTOS/WAITING_FOR_PHOTOS → STOPPED, фото и резерв остаются. */
export async function closeArticle(me: Actor, articleId: string): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, ["INSUFFICIENT_PHOTOS", "WAITING_FOR_PHOTOS"]);
  const r = await prisma.article.updateMany({ where: { id: articleId, status: a.status }, data: { status: "STOPPED", finishedAt: new Date(), claimedById: null, claimedAt: null, aiRunId: null } });
  if (!r.count) throw new ModerationError("Статья уже сменила статус", 409, true);
  await event(articleId, me, "close");
}

/* ───────────────────────── Модерация готовой статьи ───────────────────────── */

export type ReviewSection = { id: string; position: number; photoId: string | null; heading: string; html: string; wordCount: number; status: string };

export type ArticleReviewState = PhotoModerationState & {
  meta: { h1: string; metaTitle: string; metaDescription: string; slug: string; wpCategoryId: number | null; publishMode: string };
  sections: ReviewSection[];
  intro: string;
  outro: string;
  categories: Array<{ id: number; name: string }>;
  priority: number;
};

export async function reviewState(me: CurrentUser, articleId: string): Promise<ArticleReviewState> {
  const [base, a, sections] = await Promise.all([
    photoState(me, articleId),
    prisma.article.findUnique({ where: { id: articleId }, select: { h1: true, metaTitle: true, metaDescription: true, slug: true, wpCategoryId: true, publishMode: true, introHtml: true, outroHtml: true, priority: true, site: { select: { wpCategories: true } } } }),
    prisma.artSection.findMany({ where: { articleId }, orderBy: { position: "asc" } }),
  ]);
  if (!a) throw new ModerationError("Статья не найдена", 404);
  const cats = Array.isArray(a.site.wpCategories) ? (a.site.wpCategories as Array<{ id: number; name: string }>) : [];
  return {
    ...base,
    meta: { h1: a.h1, metaTitle: a.metaTitle, metaDescription: a.metaDescription, slug: a.slug, wpCategoryId: a.wpCategoryId, publishMode: a.publishMode },
    sections: sections.map((s) => ({ id: s.id, position: s.position, photoId: s.photoId, heading: s.heading, html: s.html ?? "", wordCount: s.wordCount, status: s.status })),
    intro: a.introHtml ?? sections.find((s) => s.position === 0)?.html ?? "",
    outro: a.outroHtml ?? sections.find((s) => s.position === 9990)?.html ?? "",
    categories: cats.map((c) => ({ id: Number(c.id), name: String(c.name) })),
    priority: a.priority,
  };
}

/** Правка мета-полей и категории на модерации статьи (сохраняется при переходе, как в оригинале). */
export async function updateReviewFields(me: CurrentUser, articleId: string, f: { h1?: string; metaTitle?: string; metaDescription?: string; slug?: string; wpCategoryId?: number | null }): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, REVIEW_STATUSES);
  const slug = f.slug === undefined ? undefined : f.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200);
  await prisma.article.update({
    where: { id: articleId },
    data: {
      h1: f.h1?.trim().slice(0, 300),
      metaTitle: f.metaTitle?.trim().slice(0, 300),
      metaDescription: f.metaDescription?.trim().slice(0, 500),
      slug,
      wpCategoryId: f.wpCategoryId === undefined ? undefined : f.wpCategoryId,
    },
  });
}

/**
 * Одобрить статью к публикации (REVIEW_PENDING/NEEDS_REWORK → PENDING, stage=publish).
 * Если модератор снял фото — они удаляются вместе со своими секциями, позиции и номера заголовков пересчитываются,
 * и статья идёт через `assemble` (пересборка HTML, оригинал: apply-review-exclusions) с флагом `cursor.reviewApproved`,
 * чтобы раннер не остановил её на повторную модерацию. publishNow — приоритет +10.
 */
export async function approveArticle(me: CurrentUser, articleId: string, opts: { publishNow?: boolean } = {}): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, REVIEW_STATUSES);
  const photos = await prisma.artPhoto.findMany({ where: { articleId }, orderBy: { position: "asc" } });
  const excluded = photos.filter((p) => p.excluded);
  let stage = "publish";
  if (excluded.length) {
    const ids = excluded.map((p) => p.id);
    await prisma.artSection.deleteMany({ where: { articleId, photoId: { in: ids } } });
    await prisma.artPhoto.deleteMany({ where: { id: { in: ids } } });
    const candIds = excluded.map((p) => p.candidateId).filter((x): x is string => !!x);
    if (candIds.length) await prisma.artPhotoCandidate.updateMany({ where: { id: { in: candIds }, status: "selected" }, data: { status: "reserve" } });
    for (const p of excluded) {
      if (p.path) await removePath(p.path).catch(() => {});
      if (p.thumbPath) await removePath(p.thumbPath).catch(() => {});
    }
    const left = photos.filter((p) => !p.excluded);
    const sections = await prisma.artSection.findMany({ where: { articleId, photoId: { not: null } } });
    await prisma.$transaction(async (tx) => {
      for (const s of sections) await tx.artSection.update({ where: { id: s.id }, data: { position: -(Math.abs(s.position) || 1) } });
      for (let i = 0; i < left.length; i++) {
        await tx.artPhoto.update({ where: { id: left[i].id }, data: { position: i + 1 } });
        const sec = sections.find((s) => s.photoId === left[i].id);
        if (!sec) continue;
        const raw = sec.heading || "";
        const heading = /^\s*\d+\s*[.)\-–]\s*/.test(raw) ? `${i + 1}. ${raw.replace(/^\s*\d+\s*[.)\-–]\s*/, "").trim()}` : undefined;
        await tx.artSection.update({ where: { id: sec.id }, data: { position: i + 1, heading } });
      }
    });
    stage = "assemble";
  }
  const cursor = { ...((a.cursor ?? {}) as ArticleCursor), reviewApproved: true };
  const r = await prisma.article.updateMany({
    where: { id: articleId, status: { in: REVIEW_STATUSES } },
    data: {
      status: "PENDING",
      stage,
      attempts: 0,
      publishAttempts: 0,
      error: null,
      errorStage: null,
      nextRunAt: null,
      cursor: cursor as object,
      priority: opts.publishNow ? a.priority + 10 : a.priority,
      reviewedById: me.id,
      reviewedAt: new Date(),
      claimedById: null,
      claimedAt: null,
    },
  });
  if (!r.count) throw new ModerationError("Статья уже сменила статус", 409, true);
  await event(articleId, me, "review_approve", { publishNow: !!opts.publishNow, removed: excluded.length });
}

export const REWORK_REASONS = ["мало фото", "слабый текст", "не по теме", "ошибки в фактах", "другое"] as const;

/** В доработку: статья останавливается с замечанием (оригинал: needs_rework + moderation_flag_reason). */
export async function reworkArticle(me: CurrentUser, articleId: string, reason: string): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, ["REVIEW_PENDING"]);
  const note = reason.trim().slice(0, 1000) || "в доработку";
  const r = await prisma.article.updateMany({ where: { id: articleId, status: "REVIEW_PENDING" }, data: { status: "NEEDS_REWORK", note, reviewedById: me.id, reviewedAt: new Date(), claimedById: null, claimedAt: null } });
  if (!r.count) throw new ModerationError("Статья уже сменила статус", 409, true);
  await event(articleId, me, "review_rework", { reason: note });
}

/* ───────────────────────── Публикация ───────────────────────── */

/** Повторить публикацию (PUBLISH_ERROR → PENDING, stage=publish, попытки обнуляются). */
export async function retryPublish(me: CurrentUser, articleId: string): Promise<void> {
  const a = await load(me, articleId);
  expectStatus(a, ["PUBLISH_ERROR"]);
  const r = await prisma.article.updateMany({ where: { id: articleId, status: "PUBLISH_ERROR" }, data: { status: "PENDING", stage: "publish", publishAttempts: 0, attempts: 0, error: null, errorStage: null, nextRunAt: null } });
  if (!r.count) throw new ModerationError("Статья уже сменила статус", 409, true);
  await event(articleId, me, "publish_retry");
}

/** Повторить все ошибки публикации (по сайту или все видимые). */
export async function retryAllPublishErrors(me: CurrentUser, siteId?: string): Promise<number> {
  const rows = await prisma.article.findMany({ where: { ...(await articleWhere(me)), status: "PUBLISH_ERROR", ...(siteId ? { siteId } : {}) }, select: { id: true } });
  let n = 0;
  for (const r of rows) {
    try {
      await retryPublish(me, r.id);
      n++;
    } catch {
      /* статья уже ушла */
    }
  }
  return n;
}
