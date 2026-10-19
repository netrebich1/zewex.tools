/**
 * Чтение списка «Неудачные ключи» для страницы, выгрузки в Excel/CSV и подсказок при запуске.
 * Видимость — как у сайтов сервиса (artSiteWhere): строка видна, если виден её сайт.
 */
import { prisma } from "@/lib/db";
import type { ArtStatus, Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/auth";
import { artSiteWhere } from "./access";
import { FAILED_REASONS, normalizeKeyword, reasonLabel, type FailedReason } from "./failedKeywords";
import { statusLabel } from "./labels";
import { buildCsv, buildXlsx, type CellValue } from "@/lib/xlsx";

export type FailedSort = "last" | "keyword" | "site" | "reason" | "found" | "final" | "removed" | "times";
export const FAILED_SORTS: FailedSort[] = ["last", "keyword", "site", "reason", "found", "final", "removed", "times"];

export type FailedFilters = {
  siteId?: string;
  reason?: FailedReason;
  recipe?: string;
  /** За сколько дней по «последний раз»; 0 — всё время */
  days: number;
  minTimes: number;
  q?: string;
  /** hide — без «не считать» (по умолчанию), only — только они, all — все */
  ignored: "hide" | "only" | "all";
  sort: FailedSort;
  dir: "asc" | "desc";
};

type Params = Record<string, string | string[] | undefined> | URLSearchParams;
const get = (p: Params, k: string): string | undefined => {
  if (p instanceof URLSearchParams) return p.get(k) ?? undefined;
  const v = p[k];
  return Array.isArray(v) ? v[0] : v;
};

/** Фильтры из адреса страницы или запроса выгрузки (одинаковые имена параметров). */
export function parseFailedFilters(p: Params): FailedFilters {
  const reasonRaw = get(p, "reason");
  const sortRaw = get(p, "sort") as FailedSort | undefined;
  const ign = get(p, "ignored");
  const daysRaw = Number(get(p, "days") ?? 0);
  return {
    siteId: get(p, "site") || undefined,
    reason: FAILED_REASONS.some((r) => r.value === reasonRaw) ? (reasonRaw as FailedReason) : undefined,
    recipe: get(p, "recipe") || undefined,
    days: Number.isFinite(daysRaw) ? Math.min(3650, Math.max(0, Math.round(daysRaw))) : 0,
    minTimes: Math.min(1000, Math.max(1, Math.round(Number(get(p, "min") ?? 1) || 1))),
    q: (get(p, "q") ?? "").trim().slice(0, 100) || undefined,
    ignored: ign === "only" || ign === "all" ? ign : "hide",
    sort: sortRaw && FAILED_SORTS.includes(sortRaw) ? sortRaw : "last",
    dir: get(p, "dir") === "asc" ? "asc" : "desc",
  };
}

/** Строка адреса для фильтров (пустые и значения по умолчанию опускаются). */
export function failedQuery(f: FailedFilters, patch: Partial<FailedFilters> = {}): string {
  const v = { ...f, ...patch };
  const u = new URLSearchParams();
  if (v.siteId) u.set("site", v.siteId);
  if (v.reason) u.set("reason", v.reason);
  if (v.recipe) u.set("recipe", v.recipe);
  if (v.days) u.set("days", String(v.days));
  if (v.minTimes > 1) u.set("min", String(v.minTimes));
  if (v.q) u.set("q", v.q);
  if (v.ignored !== "hide") u.set("ignored", v.ignored);
  if (v.sort !== "last") u.set("sort", v.sort);
  if (v.dir !== "desc") u.set("dir", v.dir);
  return u.toString();
}

export type VisibleSite = { id: string; name: string };

export async function visibleArtSites(me: CurrentUser): Promise<VisibleSite[]> {
  return prisma.artSite.findMany({ where: await artSiteWhere(me), select: { id: true, name: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

/** where без фильтра «не считать» и без причины — для счётчиков по причинам. */
function baseWhere(f: FailedFilters, siteIds: string[]): Prisma.ArtFailedKeywordWhereInput {
  const siteIn = f.siteId && siteIds.includes(f.siteId) ? [f.siteId] : siteIds;
  return {
    siteId: { in: siteIn },
    ...(f.recipe ? { recipeName: f.recipe } : {}),
    ...(f.days ? { lastSeenAt: { gte: new Date(Date.now() - f.days * 86400_000) } } : {}),
    ...(f.minTimes > 1 ? { occurrences: { gte: f.minTimes } } : {}),
    ...(f.q ? { keyword: { contains: f.q.toLowerCase() } } : {}),
  };
}

export function failedWhere(f: FailedFilters, siteIds: string[]): Prisma.ArtFailedKeywordWhereInput {
  return {
    ...baseWhere(f, siteIds),
    ...(f.reason ? { reason: f.reason } : {}),
    ...(f.ignored === "hide" ? { ignored: false } : f.ignored === "only" ? { ignored: true } : {}),
  };
}

function orderBy(f: FailedFilters): Prisma.ArtFailedKeywordOrderByWithRelationInput[] {
  const d = f.dir;
  switch (f.sort) {
    case "keyword": return [{ keyword: d }];
    case "site": return [{ siteId: d }, { lastSeenAt: "desc" }];
    case "reason": return [{ reason: d }, { lastSeenAt: "desc" }];
    case "found": return [{ candidatesFound: d }, { keyword: "asc" }];
    case "final": return [{ finalPhotos: d }, { keyword: "asc" }];
    case "removed": return [{ aiRemoved: d }, { humanRemoved: d }];
    case "times": return [{ occurrences: d }, { lastSeenAt: "desc" }];
    default: return [{ lastSeenAt: d }];
  }
}

export type FailedRow = Awaited<ReturnType<typeof prisma.artFailedKeyword.findMany>>[number];

export async function listFailedKeywords(f: FailedFilters, siteIds: string[], take?: number): Promise<{ rows: FailedRow[]; total: number }> {
  const where = failedWhere(f, siteIds);
  const [rows, total] = await Promise.all([
    prisma.artFailedKeyword.findMany({ where, orderBy: orderBy(f), ...(take ? { take } : {}) }),
    prisma.artFailedKeyword.count({ where }),
  ]);
  return { rows, total };
}

export type FailedSummary = {
  byReason: Record<string, number>;
  total: number;
  ignored: number;
  articles: number;
  recipes: string[];
  lastCollected: Date | null;
};

/** Счётчики над таблицей: по причинам (без учёта выбранной причины), скрытые «не считать», затронуто статей, список рецептов. */
export async function failedSummary(f: FailedFilters, siteIds: string[]): Promise<FailedSummary> {
  const base = baseWhere(f, siteIds);
  const [byReason, ignored, sums, recipes, last] = await Promise.all([
    prisma.artFailedKeyword.groupBy({ by: ["reason"], where: { ...base, ignored: false }, _count: { _all: true } }),
    prisma.artFailedKeyword.count({ where: { ...base, ...(f.reason ? { reason: f.reason } : {}), ignored: true } }),
    prisma.artFailedKeyword.aggregate({ where: { ...base, ...(f.reason ? { reason: f.reason } : {}), ignored: false }, _sum: { occurrences: true } }),
    prisma.artFailedKeyword.findMany({ where: { siteId: { in: siteIds } }, distinct: ["recipeName"], select: { recipeName: true }, orderBy: { recipeName: "asc" } }),
    prisma.artFailedKeyword.aggregate({ where: { siteId: { in: siteIds } }, _max: { updatedAt: true } }),
  ]);
  const map: Record<string, number> = {};
  for (const g of byReason) map[g.reason] = g._count._all;
  return {
    byReason: map,
    total: Object.values(map).reduce((s, n) => s + n, 0),
    ignored,
    articles: sums._sum.occurrences ?? 0,
    recipes: recipes.map((r) => r.recipeName).filter(Boolean),
    lastCollected: last._max.updatedAt ?? null,
  };
}

/* ───────── Выгрузка ───────── */

const HEADERS = ["Ключ", "Сайт", "Причина", "Найдено кандидатов", "Прошло техфильтр", "Одобрено ИИ-оценкой", "Отобрано", "Убрала ИИ-модерация", "Убрал модератор", "Итог фото", "Нужно фото", "Раз неудачно", "Первый раз", "Последний раз", "Статус последней статьи", "Рецепт", "Ниша", "Причина подробно", "Не считать", "Заметка", "Статья"];

const dt = (d: Date) => d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" });

function rowCells(r: FailedRow, siteName: Map<string, string>, origin: string): CellValue[] {
  return [
    r.keywordRaw || r.keyword, siteName.get(r.siteId) ?? r.siteId, reasonLabel(r.reason),
    r.candidatesFound, r.passedFilter, r.approvedByRating, r.selected, r.aiRemoved, r.humanRemoved, r.finalPhotos, r.photoTarget,
    r.occurrences, dt(r.firstSeenAt), dt(r.lastSeenAt), r.lastStatus ? statusLabel(r.lastStatus as ArtStatus) : "", r.recipeName, r.nicheCode ?? "",
    r.detail ?? "", r.ignored ? "да" : "", r.note ?? "", r.lastArticleId ? `${origin}/pinterest/articles/articles/${r.lastArticleId}` : "",
  ];
}

export function failedXlsx(rows: FailedRow[], sites: VisibleSite[], origin: string): Buffer {
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  // Сводка: причина × сайт (без «не считать»)
  const counted = rows.filter((r) => !r.ignored);
  const usedSites = sites.filter((s) => counted.some((r) => r.siteId === s.id));
  const summary: CellValue[][] = [["Причина", "Всего ключей", "Статей", ...usedSites.map((s) => s.name)]];
  for (const reason of FAILED_REASONS) {
    const list = counted.filter((r) => r.reason === reason.value);
    summary.push([reason.label, list.length, list.reduce((s, r) => s + r.occurrences, 0), ...usedSites.map((s) => list.filter((r) => r.siteId === s.id).length)]);
  }
  summary.push(["Итого", counted.length, counted.reduce((s, r) => s + r.occurrences, 0), ...usedSites.map((s) => counted.filter((r) => r.siteId === s.id).length)]);
  if (rows.length > counted.length) summary.push([], ["Помечено «не считать» (не входят в сводку)", rows.length - counted.length]);
  return buildXlsx([
    { name: "Неудачные ключи", rows: [HEADERS, ...rows.map((r) => rowCells(r, siteName, origin))], widths: [40, 22, 22, 12, 12, 12, 10, 12, 12, 10, 10, 10, 16, 16, 20, 26, 14, 50, 10, 30, 60] },
    { name: "Сводка", rows: summary, widths: [40, 14, 10, ...usedSites.map(() => 18)], boldRows: [0, summary.length - (rows.length > counted.length ? 3 : 1)] },
  ]);
}

export function failedCsv(rows: FailedRow[], sites: VisibleSite[], origin: string): string {
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  return buildCsv([HEADERS, ...rows.map((r) => rowCells(r, siteName, origin))]);
}

/* ───────── Подсказка при запуске ───────── */

export type FailedHint = { keyword: string; reason: string; label: string; finalPhotos: number; photoTarget: number; occurrences: number };

/** Какие из ключей уже были неудачными на сайте (без «не считать»). keyword в ответе — нормализованный. */
export async function failedKeywordHints(siteId: string, keywords: string[]): Promise<FailedHint[]> {
  const list = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))].slice(0, 3000);
  if (!list.length) return [];
  const out: FailedHint[] = [];
  for (let i = 0; i < list.length; i += 500) {
    const rows = await prisma.artFailedKeyword.findMany({
      where: { siteId, ignored: false, keyword: { in: list.slice(i, i + 500) } },
      select: { keyword: true, reason: true, finalPhotos: true, photoTarget: true, occurrences: true },
    });
    for (const r of rows) out.push({ keyword: normalizeKeyword(r.keyword), reason: r.reason, label: reasonLabel(r.reason), finalPhotos: r.finalPhotos, photoTarget: r.photoTarget, occurrences: r.occurrences });
  }
  return out;
}
