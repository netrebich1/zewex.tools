import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { KEEP_DAYS, parseSettings, type RunStats, type ScorePart } from "./types";
import type { ClusterResearch } from "./research";
import { projectSpend } from "./runs";

/** Выборки для экранов модуля: лента, сводка, прогоны и расход. */

export type FeedFilter = { cat?: string; urgent?: boolean; notUa?: boolean; all?: boolean; status?: string; priority?: string; sort?: "score" | "fresh"; hours?: number; fav?: boolean; favDay?: number; onSite?: boolean };

/** Начало дня по Киеву: back = 0 — сегодня, 1 — вчера, 2 — позавчера. */
export function kyivDayStart(back = 0): Date {
  const now = new Date();
  const k = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
  const shift = k.getTime() - now.getTime();
  k.setHours(0, 0, 0, 0);
  return new Date(k.getTime() - shift - back * 86_400_000);
}

/** Сколько отмечено в избранное за сегодня, вчера и позавчера (по Киеву). */
export async function favCounts(projectId: string): Promise<number[]> {
  const rows = await prisma.newsCluster.findMany({ where: { projectId, starred: true, starredAt: { gte: kyivDayStart(KEEP_DAYS - 1) } }, select: { starredAt: true } });
  return [0, 1, 2].map((d) => rows.filter((r) => r.starredAt! >= kyivDayStart(d) && (d === 0 || r.starredAt! < kyivDayStart(d - 1))).length);
}

export type FeedSource = { domain: string; title: string; url: string; at: Date; tier: string };
export type FeedCard = {
  id: string;
  title: string;
  imageUrl: string | null;
  category: string | null;
  subcategory: string | null;
  mainEntityName: string | null;
  score: number;
  urgent: boolean;
  status: string;
  sensitive: boolean;
  sourceCount: number;
  uaCount: number;
  worldCount: number;
  firstPublishedAt: Date;
  lastItemAt: Date;
  parts: ScorePart[];
  history: { at: string; score: number }[];
  sources: FeedSource[];
  entities: { name: string; orig?: string; type?: string; role?: string }[];
  titleUk: string | null;
  summaryUk: string | null;
  whyUs: string | null;
  priority: string | null;
  priorityWhy: string[];
  angles: { angles: { title: string; angle: string; why: string; novelty: number; usefulness: number; kind: string; format?: string }[]; competitorsAngle?: string; gaps?: string[]; ours?: { title: string; url: string }[] } | null;
  angleIdx: number | null;
  brief: string | null;
  briefAt: Date | null;
  isNew: boolean;
  starred: boolean;
  research: ClusterResearch | null;
  newSources: number;
  onSite: { url: string; title: string; at: string } | null;
};

export async function feed(projectId: string, f: FeedFilter): Promise<{ cards: FeedCard[]; hidden: number; total: number; lastRunAt: Date | null }> {
  const p = await prisma.newsProject.findUniqueOrThrow({ where: { id: projectId } });
  const s = parseSettings(p.settings);
  // Свежесть считаем по первой публикации инфоповода, а не по последней перепечатке (решение владельца 29.10:
  // тема, начавшаяся 12 часов назад, не свежая, даже если её только что дописал ещё один сайт).
  // «Свежее»: окно в часах, без отсечки по топ-N; «Топ»: инфоповоды не старше суток.
  const fresh = f.sort === "fresh";
  const hours = fresh ? Math.max(1, Math.min(72, f.hours || 6)) : 24;
  const since = new Date(Date.now() - hours * 3600_000);
  const lastRun = await prisma.newsRun.findFirst({ where: { projectId, kind: { in: ["scheduled", "manual"] }, status: "done" }, orderBy: { finishedAt: "desc" }, select: { startedAt: true } });
  const rows = await prisma.newsCluster.findMany({
    where: {
      // Вкладки «В работе», «Уже на сайте», «Избранное» — инфоповоды не старше KEEP_DAYS; избранное ещё и по дню, когда отмечено.
      projectId, ...(f.status || f.fav || f.onSite ? { firstPublishedAt: { gte: new Date(Date.now() - KEEP_DAYS * 86_400_000) } } : { firstPublishedAt: { gte: since } }),
      ...(f.fav ? { starredAt: { gte: kyivDayStart(f.favDay ?? 0), ...(f.favDay ? { lt: kyivDayStart(f.favDay - 1) } : {}) } } : {}), score: { gte: f.status || f.fav || f.onSite ? 0 : s.minScore }, category: f.cat ? f.cat : { in: s.targetCategories }, ...(f.priority ? { priority: f.priority } : {}),
      status: f.status ? f.status : { not: "rejected" }, ...(f.urgent ? { urgent: true } : {}), ...(f.notUa ? { uaCount: 0, worldCount: { gt: 0 } } : {}), ...(f.fav ? { starred: true } : {}),
      // Статья уже есть на сайте — карточка уходит из ленты во вкладку «Уже на сайте» (в «Избранном» и «В работе» остаётся).
      ...(f.onSite ? { onSite: { not: Prisma.DbNull } } : f.fav || f.status ? {} : { onSite: { equals: Prisma.DbNull } }),
    },
    orderBy: fresh ? [{ firstPublishedAt: "desc" }, { score: "desc" }] : [{ score: "desc" }, { lastItemAt: "desc" }],
    take: 300,
  });
  const total = rows.length;
  const shown = f.all || fresh || f.fav || f.onSite ? rows : rows.slice(0, s.topN);
  const runStart = lastRun?.startedAt ?? null;
  const items = await prisma.newsItem.findMany({
    where: { clusterId: { in: shown.map((r) => r.id) } },
    select: { clusterId: true, title: true, url: true, domain: true, tier: true, publishedAt: true, foundAt: true, extraSources: true },
    orderBy: { foundAt: "asc" },
  });
  const byCluster = new Map<string, FeedSource[]>();
  for (const it of items) {
    if (!it.clusterId) continue;
    const list = byCluster.get(it.clusterId) ?? [];
    list.push({ domain: it.domain, title: it.title, url: it.url, at: it.publishedAt ?? it.foundAt, tier: it.tier });
    for (const x of Array.isArray(it.extraSources) ? (it.extraSources as { domain: string; url: string; at: string; tier: string }[]) : []) {
      list.push({ domain: x.domain, title: it.title, url: x.url, at: new Date(x.at), tier: x.tier });
    }
    byCluster.set(it.clusterId, list);
  }
  const cards: FeedCard[] = shown.map((c) => {
    const seen = new Set<string>();
    const sources = (byCluster.get(c.id) ?? []).sort((a, b) => a.at.getTime() - b.at.getTime()).filter((x) => (seen.has(x.domain) ? false : (seen.add(x.domain), true)));
    return {
      id: c.id, title: c.title, imageUrl: c.imageUrl, category: c.category, subcategory: c.subcategory, mainEntityName: c.mainEntityName, score: Math.round(c.score), urgent: c.urgent, status: c.status,
      sensitive: c.sensitive, sourceCount: c.sourceCount, uaCount: c.uaCount, worldCount: c.worldCount, firstPublishedAt: c.firstPublishedAt, lastItemAt: c.lastItemAt,
      parts: Array.isArray(c.scoreParts) ? (c.scoreParts as ScorePart[]) : [], history: Array.isArray(c.scoreHistory) ? (c.scoreHistory as { at: string; score: number }[]) : [],
      sources, entities: Array.isArray(c.entities) ? (c.entities as FeedCard["entities"]) : [],
      titleUk: c.titleUk, summaryUk: c.summaryUk, whyUs: c.whyUs, priority: c.priority, priorityWhy: Array.isArray(c.priorityWhy) ? (c.priorityWhy as string[]) : [],
      angles: (c.angles as FeedCard["angles"]) ?? null, angleIdx: c.angleIdx, brief: c.brief, briefAt: c.briefAt,
      // Что изменилось в последнем прогоне: кластер новый или к нему добавились источники.
      isNew: !!runStart && c.createdAt >= runStart,
      starred: c.starred, research: (c.research as ClusterResearch | null) ?? null, onSite: (c.onSite as FeedCard["onSite"]) ?? null,
      newSources: runStart && c.createdAt < runStart ? sources.filter((x) => x.at >= runStart).length : 0,
    };
  });
  return { cards, hidden: Math.max(0, total - shown.length), total, lastRunAt: runStart };
}

export async function summary(projectId: string) {
  const p = await prisma.newsProject.findUniqueOrThrow({ where: { id: projectId } });
  const s = parseSettings(p.settings);
  const since = new Date(Date.now() - 24 * 3600_000);
  const [runs, spend, waiting, urgent, cards, lastRun, active] = await Promise.all([
    prisma.newsRun.findMany({ where: { projectId, createdAt: { gte: since } }, select: { stats: true } }),
    projectSpend(projectId),
    prisma.newsItem.count({ where: { projectId, status: "queued" } }),
    prisma.newsCluster.count({ where: { projectId, firstPublishedAt: { gte: since }, urgent: true, status: { not: "rejected" } } }),
    prisma.newsCluster.count({ where: { projectId, firstPublishedAt: { gte: since }, score: { gte: s.minScore }, category: { in: s.targetCategories }, status: { not: "rejected" } } }),
    prisma.newsRun.findFirst({ where: { projectId, status: { in: ["done", "failed"] }, kind: { in: ["scheduled", "manual"] } }, orderBy: { createdAt: "desc" } }),
    prisma.newsRun.findFirst({ where: { projectId, status: { in: ["queued", "running"] }, kind: { in: ["scheduled", "manual"] } }, orderBy: { createdAt: "desc" } }),
  ]);
  const sum = (k: keyof RunStats) => runs.reduce((a, r) => a + (Number((r.stats as RunStats | null)?.[k]) || 0), 0);
  return {
    settings: s,
    fetched: sum("fetched"),
    fresh: sum("fresh"),
    passed: sum("fresh") - sum("cutWords") - sum("cutRubric") - sum("cutWhitelist"),
    classified: sum("classified"),
    waiting,
    urgent,
    cards: Math.min(cards, s.topN),
    cardsTotal: cards,
    spend,
    lastRun,
    active,
    nextRunAt: p.nextRunAt,
  };
}


export async function runsOf(projectId: string, take = 60) {
  const runs = await prisma.newsRun.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take });
  const ids = [...new Set(runs.map((r) => r.userId).filter((x): x is string => !!x))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return runs.map((r) => ({ ...r, userName: users.find((u) => u.id === r.userId)?.name ?? null, st: (r.stats ?? {}) as Partial<RunStats> }));
}

/** Расход по дням за 14 дней (по журналу прогонов) и средняя цена прогона за 7 дней. */
export async function spendByDay(projectId: string) {
  const since = new Date(Date.now() - 14 * 86_400_000);
  const runs = await prisma.newsRun.findMany({ where: { projectId, createdAt: { gte: since } }, select: { createdAt: true, costUsd: true, kind: true, status: true } });
  const days = new Map<string, { usd: number; runs: number }>();
  for (const r of runs) {
    const d = r.createdAt.toISOString().slice(0, 10);
    const x = days.get(d) ?? { usd: 0, runs: 0 };
    x.usd += r.costUsd;
    x.runs++;
    days.set(d, x);
  }
  const week = runs.filter((r) => Date.now() - r.createdAt.getTime() < 7 * 86_400_000 && r.status === "done");
  const avgRun = week.length ? week.reduce((a, r) => a + r.costUsd, 0) / week.length : null;
  const last7 = [...days.entries()].filter(([d]) => Date.now() - Date.parse(d) < 7 * 86_400_000).reduce((a, [, v]) => a + v.usd, 0);
  return { days: [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])), avgRun, last7 };
}

export function fmtKyiv(d: Date | string | null | undefined, withDate = true): string {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toLocaleString("ru-RU", { timeZone: "Europe/Kyiv", ...(withDate ? { day: "2-digit", month: "2-digit" } : {}), hour: "2-digit", minute: "2-digit" });
}

export function agoText(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - (typeof d === "string" ? Date.parse(d) : d.getTime());
  const min = Math.round(ms / 60_000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч ${min % 60 ? `${min % 60} мин ` : ""}назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

/** Тренды за 12 ч + карточка ленты, если тренд уже в кластере (по заголовку и герою). */
export async function trendsOf(projectId: string) {
  const since = new Date(Date.now() - 12 * 3600_000);
  const [trends, clusters] = await Promise.all([
    prisma.newsTrend.findMany({ where: { projectId, lastSeenAt: { gte: since } }, orderBy: [{ relevant: "desc" }, { lastSeenAt: "desc" }], take: 30 }),
    prisma.newsCluster.findMany({ where: { projectId, lastItemAt: { gte: new Date(Date.now() - 48 * 3600_000) } }, select: { id: true, title: true, titleUk: true, mainEntityName: true, score: true }, orderBy: { score: "desc" } }),
  ]);
  const norm = (s: string) => s.toLowerCase().replace(/[’'ʼ]/g, "").replace(/ё/g, "е");
  return trends.map((t) => {
    const words = norm(t.title).split(/\s+/).filter((w) => w.length >= 3).map((w) => w.slice(0, Math.max(3, w.length - 2)));
    const hit = words.length ? clusters.find((c) => {
      const hay = norm(`${c.title} ${c.titleUk ?? ""} ${c.mainEntityName ?? ""}`);
      return words.every((w) => hay.includes(w));
    }) : undefined;
    return { ...t, cluster: hit ? { id: hit.id, title: hit.titleUk || hit.title, score: Math.round(hit.score) } : null };
  });
}
