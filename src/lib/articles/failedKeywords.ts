/**
 * «Неудачные ключи» сервиса статей: ключи, по которым не нашли фото, набрали мало, после модерации осталось < 10
 * или модерация убрала много. Список нужен владельцу, чтобы анализировать такие ключи и больше их не запускать.
 *
 * Сборщик отделён от конвейера: он только читает статьи (+ кандидатов, фото, события модерации, решения ИИ-модерации)
 * и пишет строки ArtFailedKeyword. Вызывается воркером (worker/cron.ts): полный проход при старте, затем раз в 10 минут
 * по изменившимся статьям. Идемпотентен: повтор с теми же данными ничего не меняет.
 *
 * Правило «липкое»: раз статья с ключом была неудачной, ключ остаётся в списке, даже если статью потом добрали
 * (её id хранится в articleIds). Владелец может пометить строку «не считать».
 */
import { prisma } from "@/lib/db";
import type { ArtStatus } from "@prisma/client";
import { phaseOf } from "./stages";

/* ───────── Причины ───────── */

export type FailedReason = "no_photos" | "insufficient" | "few_final" | "ai_removed_many";

export const FAILED_REASONS: Array<{ value: FailedReason; label: string; short: string; help: string }> = [
  { value: "no_photos", label: "Фото не нашлись", short: "нет фото", help: "Поиск и отбор не дали ни одного фото в статью — статья ждёт фото (WAITING_FOR_PHOTOS) с пустым отбором." },
  { value: "insufficient", label: "Мало фото", short: "мало фото", help: "Фото набрали меньше нужного: статья ушла в «Мало фото» (воркером, модератором или ИИ) или закрыта оттуда." },
  { value: "few_final", label: "Итог < 10 фото", short: "итог < 10", help: "Статья прошла отбор, но после модерации в ней осталось меньше 10 фото." },
  { value: "ai_removed_many", label: "Модерация убрала много", short: "убрали много", help: "ИИ-модерация (или человек при одобрении) убрала ≥ 30 % фото либо после неё осталось меньше 10." },
];
export const reasonLabel = (r: string): string => FAILED_REASONS.find((x) => x.value === r)?.label ?? r;

/** Порог «мало в итоге» и доля «убрали много». */
export const FEW_FINAL = 10;
export const REMOVED_SHARE = 0.3;
/** Сколько id статей держим в строке (для подсчёта повторов). */
const MAX_IDS = 500;

/** Ключ для уникальности: нижний регистр, одиночные пробелы. Тот же, что сравнивается при запуске. */
export function normalizeKeyword(k: string): string {
  return String(k ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 191);
}

/* ───────── Оценка одной статьи (чистая функция) ───────── */

/** Статусы, в которых отбор фото уже позади (итог фото окончательный или почти). */
const PAST_PHOTO_STATUSES: ArtStatus[] = ["REVIEW_PENDING", "NEEDS_REWORK", "PUBLISH_QUEUED", "PUBLISHING", "COMPLETED", "PUBLISH_ERROR"];
/** Текст ошибки «не хватило фото» у статей, упавших на фото-этапах (см. errorsView.ts). */
const SHORTAGE_RE = /мало фото|не хватил[оа] фото|не набрал|недостаточно фото|WAITING_FOR_PHOTOS/i;

export type ArticleFacts = {
  status: ArtStatus;
  stage: string;
  error: string | null;
  errorStage: string | null;
  photoTarget: number;
  candidatesFound: number;
  passedFilter: number;
  approvedByRating: number;
  selected: number;
  finalPhotos: number;
  /** Было событие «Мало фото» / «Закрыть» из «Мало фото» */
  markedInsufficient: boolean;
  /** Последнее решение ИИ-модерации */
  ai: { decision: string | null; before: number; after: number; removed: number } | null;
  /** Последнее одобрение фото человеком: сколько осталось и сколько убрал */
  human: { photos: number; removed: number } | null;
};

/** Причина неудачи статьи или null. Порядок важен: сначала «не нашли», потом «мало», «итог», «убрали много». */
export function classifyArticle(f: ArticleFacts): FailedReason | null {
  // «Не нашли»: в статье не оказалось ни одного фото (отобранных нет), даже если отдельные кадры прошли оценку
  const empty = f.finalPhotos === 0 && f.selected === 0;
  if (f.status === "WAITING_FOR_PHOTOS") return empty ? "no_photos" : "insufficient";
  if (f.status === "INSUFFICIENT_PHOTOS" || f.markedInsufficient || f.ai?.decision === "insufficient") return f.candidatesFound === 0 ? "no_photos" : "insufficient";
  if (f.status === "FAILED" && phaseOf(f.errorStage ?? f.stage) === "photos" && f.error && SHORTAGE_RE.test(f.error)) return empty ? "no_photos" : "insufficient";
  const pastPhotos = PAST_PHOTO_STATUSES.includes(f.status) || (f.status !== "PHOTO_REVIEW" && phaseOf(f.stage) !== "photos" && f.selected + f.finalPhotos > 0);
  const minFinal = Math.min(FEW_FINAL, f.photoTarget > 0 ? f.photoTarget : FEW_FINAL);
  if (pastPhotos && f.finalPhotos < minFinal) return "few_final";
  // «Убрали много» считается неудачей, только если в итоге осталось меньше FEW_FINAL фото (владелец 2026-10-16:
  // добранные из резерва и опубликованные с нормой статьи — не неудачные ключи).
  if (f.ai && f.ai.before > 0 && f.ai.after < FEW_FINAL && (f.ai.removed / f.ai.before >= REMOVED_SHARE || f.ai.before >= FEW_FINAL)) return "ai_removed_many";
  if (f.human && f.human.photos < FEW_FINAL && f.human.photos + f.human.removed > 0 && f.human.removed / (f.human.photos + f.human.removed) >= REMOVED_SHARE) return "ai_removed_many";
  return null;
}

/* ───────── Сбор фактов пачкой статей ───────── */

const ARTICLE_SELECT = {
  id: true, teamId: true, siteId: true, runId: true, recipeId: true, keyword: true, status: true, stage: true,
  photoCount: true, error: true, errorStage: true, insufficientReason: true, note: true, createdAt: true, updatedAt: true,
  recipeRef: { select: { name: true, nicheCode: true } },
  site: { select: { nicheCode: true } },
} as const;

type ArticleRow = {
  id: string; teamId: string; siteId: string; runId: string | null; recipeId: string | null; keyword: string; status: ArtStatus; stage: string;
  photoCount: number; error: string | null; errorStage: string | null; insufficientReason: string | null; note: string | null; createdAt: Date; updatedAt: Date;
  recipeRef: { name: string; nicheCode: string | null } | null;
  site: { nicheCode: string | null };
};

export type FailedArticle = {
  articleId: string; teamId: string; siteId: string; runId: string | null; recipeId: string | null; recipeName: string; nicheCode: string | null;
  keywordRaw: string; keyword: string; reason: FailedReason; status: ArtStatus; detail: string | null; createdAt: Date; updatedAt: Date;
  counts: { candidatesFound: number; passedFilter: number; approvedByRating: number; selected: number; aiRemoved: number; humanRemoved: number; finalPhotos: number; photoTarget: number };
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

async function evaluateBatch(rows: ArticleRow[]): Promise<FailedArticle[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [cands, photos, events, aiResults] = await Promise.all([
    prisma.artPhotoCandidate.groupBy({ by: ["articleId", "status", "rejectStage"], where: { articleId: { in: ids } }, _count: { _all: true } }),
    prisma.artPhoto.groupBy({ by: ["articleId"], where: { articleId: { in: ids }, excluded: false }, _count: { _all: true } }),
    prisma.artModerationEvent.findMany({ where: { articleId: { in: ids }, action: { in: ["insufficient", "close", "approve"] } }, select: { articleId: true, action: true, byAi: true, payload: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
    prisma.artAiModerationResult.findMany({ where: { articleId: { in: ids }, decision: { not: null } }, select: { articleId: true, decision: true, photosBefore: true, photosAfter: true, removed: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
  ]);

  type C = { found: number; passed: number; approved: number; selected: number };
  const cMap = new Map<string, C>();
  for (const g of cands) {
    const c = cMap.get(g.articleId) ?? { found: 0, passed: 0, approved: 0, selected: 0 };
    const n = g._count._all;
    c.found += n;
    // Прошли техфильтр: скачаны и дальше; отбракованные на оценке тоже прошли фильтр. «found» — ещё не скачаны.
    if (g.status === "rejected" ? g.rejectStage != null && g.rejectStage !== "filter" : g.status !== "found") c.passed += n;
    if (g.status === "keep" || g.status === "selected" || g.status === "reserve") c.approved += n;
    if (g.status === "selected") c.selected += n;
    cMap.set(g.articleId, c);
  }
  const pMap = new Map(photos.map((p) => [p.articleId, p._count._all]));
  const marked = new Set<string>();
  const human = new Map<string, { photos: number; removed: number }>();
  for (const e of events) {
    if (e.action === "approve") {
      // Одобрение от имени ИИ-модерации уже учтено в её решении — здесь только люди
      if (e.byAi) continue;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      human.set(e.articleId, { photos: num(p.photos), removed: num(p.removed) });
    } else marked.add(e.articleId);
  }
  const ai = new Map<string, { decision: string | null; before: number; after: number; removed: number }>();
  for (const r of aiResults) ai.set(r.articleId, { decision: r.decision, before: r.photosBefore, after: r.photosAfter, removed: Array.isArray(r.removed) ? r.removed.length : 0 });

  const out: FailedArticle[] = [];
  for (const a of rows) {
    const c = cMap.get(a.id) ?? { found: 0, passed: 0, approved: 0, selected: 0 };
    const facts: ArticleFacts = {
      status: a.status, stage: a.stage, error: a.error, errorStage: a.errorStage, photoTarget: a.photoCount,
      candidatesFound: c.found, passedFilter: c.passed, approvedByRating: c.approved, selected: c.selected, finalPhotos: pMap.get(a.id) ?? 0,
      markedInsufficient: marked.has(a.id), ai: ai.get(a.id) ?? null, human: human.get(a.id) ?? null,
    };
    const reason = classifyArticle(facts);
    if (!reason) continue;
    const keyword = normalizeKeyword(a.keyword);
    if (!keyword) continue;
    const detail = (a.insufficientReason || (a.status === "FAILED" ? a.error : null) || a.note || "").trim().slice(0, 500) || null;
    out.push({
      articleId: a.id, teamId: a.teamId, siteId: a.siteId, runId: a.runId, recipeId: a.recipeId,
      recipeName: a.recipeRef?.name ?? "", nicheCode: a.recipeRef?.nicheCode ?? a.site.nicheCode ?? null,
      keywordRaw: a.keyword.slice(0, 191), keyword, reason, status: a.status, detail, createdAt: a.createdAt, updatedAt: a.updatedAt,
      counts: {
        candidatesFound: c.found, passedFilter: c.passed, approvedByRating: c.approved, selected: c.selected,
        aiRemoved: facts.ai?.removed ?? 0, humanRemoved: facts.human?.removed ?? 0, finalPhotos: facts.finalPhotos, photoTarget: a.photoCount,
      },
    });
  }
  return out;
}

/* ───────── Сборщик ───────── */

export type FailedKeywordDraft = {
  teamId: string; siteId: string; keyword: string; keywordRaw: string; nicheCode: string | null; recipeId: string | null; recipeName: string;
  reason: FailedReason; candidatesFound: number; passedFilter: number; approvedByRating: number; selected: number; aiRemoved: number; humanRemoved: number;
  finalPhotos: number; photoTarget: number; lastArticleId: string; lastRunId: string | null; lastStatus: string; detail: string | null;
  occurrences: number; articleIds: string[]; firstSeenAt: Date; lastSeenAt: Date;
};

export type CollectResult = { full: boolean; scanned: number; failedArticles: number; keywords: number; created: number; updated: number; orphansDeleted: number; drafts?: FailedKeywordDraft[] };

const BATCH = 300;
let running = false;

/**
 * Собрать/обновить список. since не задан — полный проход по всем статьям с реальными фото (бэкфилл);
 * since задан — только ключи статей, изменившихся с этого момента (статья, решение ИИ-модерации, событие модерации),
 * но по каждому такому ключу пересчитываются все его статьи на сайте. dryRun — ничего не пишет, возвращает черновики строк.
 */
export async function collectFailedKeywords(opts: { since?: Date; dryRun?: boolean } = {}): Promise<CollectResult> {
  if (running && !opts.dryRun) return { full: !opts.since, scanned: 0, failedArticles: 0, keywords: 0, created: 0, updated: 0, orphansDeleted: 0 };
  if (!opts.dryRun) running = true;
  try {
    return await collect(opts);
  } finally {
    if (!opts.dryRun) running = false;
  }
}

async function collect({ since, dryRun }: { since?: Date; dryRun?: boolean }): Promise<CollectResult> {
  const failed: FailedArticle[] = [];
  let scanned = 0;
  /** Затронутые пары сайт|ключ (для инкрементального прохода) */
  const touched = new Set<string>();

  if (!since) {
    let cursor: string | undefined;
    for (;;) {
      const rows = (await prisma.article.findMany({ where: { format: "REAL_PHOTO" }, select: ARTICLE_SELECT, orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) })) as ArticleRow[];
      if (!rows.length) break;
      scanned += rows.length;
      failed.push(...(await evaluateBatch(rows)));
      cursor = rows[rows.length - 1].id;
      if (rows.length < BATCH) break;
    }
  } else {
    const [changed, ai, ev] = await Promise.all([
      prisma.article.findMany({ where: { format: "REAL_PHOTO", updatedAt: { gte: since } }, select: { siteId: true, keyword: true } }),
      prisma.artAiModerationResult.findMany({ where: { updatedAt: { gte: since } }, select: { article: { select: { siteId: true, keyword: true, format: true } } } }),
      prisma.artModerationEvent.findMany({ where: { createdAt: { gte: since }, action: { in: ["insufficient", "close", "approve"] } }, select: { article: { select: { siteId: true, keyword: true, format: true } } } }),
    ]);
    const bySite = new Map<string, Set<string>>();
    const add = (siteId: string, kw: string) => {
      const set = bySite.get(siteId) ?? new Set<string>();
      set.add(kw);
      bySite.set(siteId, set);
      touched.add(`${siteId}|${normalizeKeyword(kw)}`);
    };
    for (const a of changed) add(a.siteId, a.keyword);
    for (const r of [...ai, ...ev]) if (r.article.format === "REAL_PHOTO") add(r.article.siteId, r.article.keyword);
    // Все статьи затронутых ключей на сайте (сравнение ключей в базе — без учёта регистра)
    for (const [siteId, kws] of bySite) {
      const list = [...kws];
      for (let i = 0; i < list.length; i += 200) {
        const rows = (await prisma.article.findMany({ where: { siteId, format: "REAL_PHOTO", keyword: { in: list.slice(i, i + 200) } }, select: ARTICLE_SELECT })) as ArticleRow[];
        for (let j = 0; j < rows.length; j += BATCH) {
          const part = rows.slice(j, j + BATCH);
          scanned += part.length;
          failed.push(...(await evaluateBatch(part)));
        }
      }
    }
  }

  // Группируем по сайту и ключу
  const groups = new Map<string, FailedArticle[]>();
  for (const f of failed) {
    const k = `${f.siteId}|${f.keyword}`;
    if (since && !touched.has(k)) continue;
    const g = groups.get(k) ?? [];
    g.push(f);
    groups.set(k, g);
  }

  // Существующие строки этих ключей (для «липких» id статей, первой даты и отметок владельца)
  const existing = new Map<string, { id: string; articleIds: string[]; firstSeenAt: Date; data: string }>();
  const keysBySite = new Map<string, string[]>();
  for (const k of groups.keys()) {
    const [siteId, kw] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    keysBySite.set(siteId, [...(keysBySite.get(siteId) ?? []), kw]);
  }
  for (const [siteId, kws] of keysBySite) {
    for (let i = 0; i < kws.length; i += 300) {
      // Пробный прогон должен работать и до создания таблицы (prisma db push при деплое)
      const rows = await prisma.artFailedKeyword.findMany({ where: { siteId, keyword: { in: kws.slice(i, i + 300) } } }).catch((e) => { if (dryRun) return []; throw e; });
      for (const r of rows) {
        existing.set(`${r.siteId}|${normalizeKeyword(r.keyword)}`, {
          id: r.id,
          articleIds: Array.isArray(r.articleIds) ? (r.articleIds as unknown[]).map(String) : [],
          firstSeenAt: r.firstSeenAt,
          data: fingerprint(r),
        });
      }
    }
  }

  const drafts: FailedKeywordDraft[] = [];
  for (const [k, list] of groups) {
    list.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const last = list[0];
    const ex = existing.get(k);
    const ids = [...new Set([...list.map((x) => x.articleId), ...(ex?.articleIds ?? [])])].slice(0, MAX_IDS);
    const firstNow = new Date(Math.min(...list.map((x) => x.createdAt.getTime())));
    drafts.push({
      teamId: last.teamId, siteId: last.siteId, keyword: last.keyword, keywordRaw: last.keywordRaw, nicheCode: last.nicheCode, recipeId: last.recipeId, recipeName: last.recipeName,
      reason: last.reason, ...last.counts, lastArticleId: last.articleId, lastRunId: last.runId, lastStatus: last.status, detail: last.detail,
      occurrences: ids.length, articleIds: ids,
      firstSeenAt: ex && ex.firstSeenAt < firstNow ? ex.firstSeenAt : firstNow,
      lastSeenAt: last.updatedAt,
    });
  }

  const result: CollectResult = { full: !since, scanned, failedArticles: failed.length, keywords: drafts.length, created: 0, updated: 0, orphansDeleted: 0 };
  if (dryRun) return { ...result, drafts };

  for (const d of drafts) {
    const k = `${d.siteId}|${d.keyword}`;
    const ex = existing.get(k);
    const data = { ...d, articleIds: d.articleIds as object };
    if (!ex) {
      // Гонка с параллельным сборщиком на другом процессе маловероятна; на всякий случай upsert
      await prisma.artFailedKeyword.upsert({ where: { siteId_keyword: { siteId: d.siteId, keyword: d.keyword } }, create: data, update: data });
      result.created++;
    } else if (ex.data !== fingerprint(d)) {
      // Отметки владельца (ignored, note) не трогаем
      await prisma.artFailedKeyword.update({ where: { id: ex.id }, data });
      result.updated++;
    }
  }

  // Полный проход: строки удалённых сайтов убираем (связи с ArtSite в схеме нет)
  if (!since) {
    const siteIds = (await prisma.artSite.findMany({ select: { id: true } })).map((s) => s.id);
    const r = await prisma.artFailedKeyword.deleteMany({ where: siteIds.length ? { siteId: { notIn: siteIds } } : {} });
    result.orphansDeleted = r.count;
  }
  return result;
}

/** Отпечаток полей, которые пишет сборщик: если не изменились — строку не трогаем. */
function fingerprint(r: Record<string, unknown>): string {
  const keys = ["teamId", "keywordRaw", "nicheCode", "recipeId", "recipeName", "reason", "candidatesFound", "passedFilter", "approvedByRating", "selected", "aiRemoved", "humanRemoved", "finalPhotos", "photoTarget", "lastArticleId", "lastRunId", "lastStatus", "detail", "occurrences"];
  const v = keys.map((k) => r[k] ?? null);
  const ids = Array.isArray(r.articleIds) ? [...(r.articleIds as unknown[]).map(String)].sort() : [];
  const dates = [r.firstSeenAt, r.lastSeenAt].map((d) => (d instanceof Date ? d.getTime() : null));
  return JSON.stringify([v, ids, dates]);
}

/**
 * Тик воркера: full — полный проход (при старте), иначе изменения за последние 30 минут (тик раз в 10 минут, с запасом).
 */
export async function failedKeywordsTick(full = false): Promise<CollectResult> {
  return collectFailedKeywords(full ? {} : { since: new Date(Date.now() - 30 * 60_000) });
}
