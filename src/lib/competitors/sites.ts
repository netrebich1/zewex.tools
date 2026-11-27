/**
 * «Анализ конкурентов»: доступ, настройки, список площадок с фильтрами, очередь разбора, выгрузка.
 * Инструмент команды WexOra: видят её участники и админы, настройки меняют админ и лидер WexOra.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { Sheet } from "@/lib/xlsx";
import { compKeyTeamId } from "./analyze";
import { geoWholeCatalog, syncCatalog } from "./collab";
import type { GeoData } from "./geo";
import { DEFAULT_SETTINGS, LEASE_SECONDS, parseSettings, splitList, STATUS_LABELS, type ClusterTop, type CompSettings, type SyncStats } from "./types";

/* ---------- Доступ ---------- */

export async function canSee(me: CurrentUser): Promise<boolean> {
  if (me.role === "ADMIN") return true;
  return me.teamIds.includes(await compKeyTeamId().catch(() => ""));
}

export async function canManage(me: CurrentUser): Promise<boolean> {
  if (me.role === "ADMIN") return true;
  return me.leadTeamIds.includes(await compKeyTeamId().catch(() => ""));
}

export async function assertSee(me: CurrentUser): Promise<void> {
  if (!(await canSee(me))) throw new Error("«Анализ конкурентов» открыт команде WexOra");
}

/* ---------- Настройки и состояние ---------- */

export async function loadState(): Promise<{ settings: CompSettings; lastSyncAt: Date | null; lastSync: SyncStats | null; syncAsked: Date | null }> {
  const s = await prisma.compState.findUnique({ where: { id: "main" } });
  return { settings: s ? parseSettings(s.settings) : DEFAULT_SETTINGS, lastSyncAt: s?.lastSyncAt ?? null, lastSync: (s?.lastSync as SyncStats | null) ?? null, syncAsked: s?.syncAsked ?? null };
}

export async function saveSettings(settings: CompSettings): Promise<void> {
  const json = settings as unknown as Prisma.InputJsonValue;
  await prisma.compState.upsert({ where: { id: "main" }, update: { settings: json }, create: { id: "main", settings: json } });
}

export async function askSync(): Promise<void> {
  const json = DEFAULT_SETTINGS as unknown as Prisma.InputJsonValue;
  await prisma.compState.upsert({ where: { id: "main" }, update: { syncAsked: new Date() }, create: { id: "main", settings: json, syncAsked: new Date() } });
}

/* ---------- Список ---------- */

export type ListFilter = { country: string; days: number; deals: number; status: string; q: string; sort: string };

export function parseFilter(get: (k: string) => string | undefined, settings: CompSettings): ListFilter {
  const days = Number(get("days"));
  const deals = Number(get("deals"));
  return {
    country: get("country") ?? settings.countries[0] ?? "",
    days: [7, 15, 31, 61, 92].includes(days) ? days : settings.periodDays,
    deals: Number.isFinite(deals) && get("deals") !== undefined ? Math.max(0, Math.min(50, deals)) : settings.minDeals,
    status: ["all", "done", "todo"].includes(get("status") ?? "") ? (get("status") as string) : "all",
    q: (get("q") ?? "").trim().toLowerCase().slice(0, 100),
    sort: ["clicks", "added", "deals", "kw", "growth"].includes(get("sort") ?? "") ? (get("sort") as string) : "clicks",
  };
}

export function filterWhere(f: ListFilter): Prisma.CompSiteWhereInput {
  const and: Prisma.CompSiteWhereInput[] = [{ addedAt: { gte: new Date(Date.now() - f.days * 86_400_000) } }];
  if (f.country && f.country !== "all") and.push({ countries: { contains: `|${f.country}|` } });
  if (f.deals > 0) and.push({ deals: { gte: f.deals } });
  if (f.status === "done") and.push({ status: "done" });
  if (f.status === "todo") and.push({ status: { not: "done" } });
  if (f.q) and.push({ OR: [{ domain: { contains: f.q } }, { mainClusters: { contains: f.q } }, { categories: { contains: f.q } }] });
  return { AND: and };
}

const ORDER: Record<string, Prisma.CompSiteOrderByWithRelationInput[]> = {
  clicks: [{ gscClicks: "desc" }],
  added: [{ addedAt: "desc" }, { gscClicks: "desc" }],
  deals: [{ deals: "desc" }, { gscClicks: "desc" }],
  kw: [{ kwTotal: "desc" }, { gscClicks: "desc" }],
  growth: [{ gscGrowth: "desc" }, { gscClicks: "desc" }],
};

export async function listSites(f: ListFilter, take = 300) {
  const where = filterWhere(f);
  const [rows, total, done] = await Promise.all([
    prisma.compSite.findMany({ where, orderBy: ORDER[f.sort] ?? ORDER.clicks, take, omit: { data: true, summary: true, takeaway: true } }),
    prisma.compSite.count({ where }),
    prisma.compSite.count({ where: { AND: [where, { status: "done" }] } }),
  ]);
  return { rows, total, done };
}

/** Страны, которые есть у площадок в базе, по убыванию числа площадок. */
export async function countryOptions(): Promise<Array<{ name: string; count: number }>> {
  const rows = await prisma.compSite.findMany({ select: { countries: true } });
  const counts = new Map<string, number>();
  for (const r of rows) for (const c of splitList(r.countries)) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/* ---------- Очередь разбора ---------- */

/** Ставит в очередь площадки под условия настроек, не больше остатка суточного лимита. Возвращает число поставленных. */
export async function queueByRules(settings: CompSettings): Promise<number> {
  if (!settings.enabled || !settings.dailyLimit || !settings.countries.length) return 0;
  const since = new Date(Date.now() - 86_400_000);
  const used = await prisma.compSite.count({ where: { OR: [{ analyzedAt: { gte: since } }, { status: { in: ["queued", "processing"] } }] } });
  const room = settings.dailyLimit - used;
  if (room <= 0) return 0;
  const pick = await prisma.compSite.findMany({
    where: {
      status: "none",
      addedAt: { gte: new Date(Date.now() - settings.periodDays * 86_400_000) },
      deals: { gte: settings.minDeals },
      gscClicks: { gte: settings.minClicks },
      OR: settings.countries.map((c) => ({ countries: { contains: `|${c}|` } })),
    },
    orderBy: { gscClicks: "desc" },
    take: room,
    select: { id: true },
  });
  if (!pick.length) return 0;
  await prisma.compSite.updateMany({ where: { id: { in: pick.map((p) => p.id) }, status: "none" }, data: { status: "queued", attempts: 0, error: null } });
  return pick.length;
}

/** Ручная постановка: одна площадка или все из текущего фильтра (не больше limit). */
export async function queueSites(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const r = await prisma.compSite.updateMany({ where: { id: { in: ids }, status: { notIn: ["queued", "processing"] } }, data: { status: "queued", attempts: 0, error: null, leaseUntil: null } });
  return r.count;
}

export async function claimSite(workerId: string): Promise<{ id: string; domain: string } | null> {
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const next = await prisma.compSite.findFirst({ where: { status: "queued", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, orderBy: { gscClicks: "desc" }, select: { id: true, domain: true } });
    if (!next) return null;
    const got = await prisma.compSite.updateMany({ where: { id: next.id, status: "queued" }, data: { status: "processing", workerId, leaseUntil: new Date(Date.now() + LEASE_SECONDS * 1000), attempts: { increment: 1 } } });
    if (got.count) return next;
  }
  return null;
}

/** Разборы, оборванные перезапуском воркера или зависшие дольше аренды, — обратно в очередь. */
export async function requeueStale(hostPrefix?: string): Promise<number> {
  const r = await prisma.compSite.updateMany({
    where: { status: "processing", OR: [{ leaseUntil: { lt: new Date() } }, ...(hostPrefix ? [{ workerId: { startsWith: hostPrefix } }] : [])] },
    data: { status: "queued", workerId: null, leaseUntil: null },
  });
  return r.count;
}

/* ---------- Сбор по расписанию ---------- */

const kyivHour = () => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Kyiv" }).format(new Date()));

/** Пора ли собирать: раз в сутки после 06:00 по Киеву или по кнопке «Обновить сейчас». */
export async function syncDue(): Promise<boolean> {
  const s = await loadState();
  if (s.syncAsked && (!s.lastSyncAt || s.syncAsked > s.lastSyncAt)) return true;
  if (!s.settings.enabled) return false;
  if (!s.lastSyncAt) return true;
  return Date.now() - s.lastSyncAt.getTime() > 20 * 3_600_000 && kyivHour() >= 6;
}

export async function runSync(shouldStop: () => boolean = () => false): Promise<SyncStats> {
  const { settings } = await loadState();
  let stats: SyncStats;
  let geo: GeoData | null = null;
  try {
    const r = await syncCatalog(shouldStop);
    stats = r.stats;
    // Срезы по новым площадкам обновляются каждый сбор; срез «весь каталог» сохраняется как был.
    geo = { ...((await loadGeo()) ?? {}), at: new Date().toISOString(), windows: r.windows };
    stats.queued = await queueByRules(settings);
  } catch (e) {
    stats = { error: e instanceof Error ? e.message : String(e) };
  }
  const json = settings as unknown as Prisma.InputJsonValue;
  const geoPatch = geo ? { geo: geo as unknown as Prisma.InputJsonValue } : {};
  await prisma.compState.upsert({ where: { id: "main" }, update: { lastSyncAt: new Date(), lastSync: stats as Prisma.InputJsonValue, syncAsked: null, ...geoPatch }, create: { id: "main", settings: json, lastSyncAt: new Date(), lastSync: stats as Prisma.InputJsonValue, ...geoPatch } });
  return stats;
}

/* ---------- Гео ---------- */

/** Срез по всему каталогу пересчитывается раз в неделю: это 460+ запросов к Collaborator. */
const GEO_ALL_DAYS = 7;

export async function loadGeo(): Promise<GeoData | null> {
  const s = await prisma.compState.findUnique({ where: { id: "main" }, select: { geo: true } });
  return (s?.geo as GeoData | null) ?? null;
}

export async function geoAllDue(): Promise<boolean> {
  const s = await loadState();
  if (!s.settings.enabled || !s.lastSyncAt) return false;
  const geo = await loadGeo();
  return !geo?.allAt || Date.now() - new Date(geo.allAt).getTime() > GEO_ALL_DAYS * 86_400_000;
}

/** Пересчёт среза «весь каталог». При ошибке время всё равно сдвигается на сутки вперёд, чтобы не долбить API каждую минуту. */
export async function runGeoAll(shouldStop: () => boolean = () => false): Promise<{ total?: number; error?: string }> {
  let out: { total?: number; error?: string };
  let all: GeoData["all"];
  try {
    const r = await geoWholeCatalog(shouldStop);
    all = r.block;
    out = { total: r.total };
  } catch (e) {
    out = { error: e instanceof Error ? e.message : String(e) };
  }
  const cur = (await loadGeo()) ?? { at: new Date().toISOString(), windows: {} };
  const allAt = all ? new Date().toISOString() : new Date(Date.now() - (GEO_ALL_DAYS - 1) * 86_400_000).toISOString();
  const next: GeoData = { ...cur, ...(all ? { all } : {}), allAt };
  await prisma.compState.update({ where: { id: "main" }, data: { geo: next as unknown as Prisma.InputJsonValue } });
  return out;
}

/* ---------- Выгрузка ---------- */

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const list = (packed: string) => splitList(packed).join(", ");

/** Три листа, как в пробной таблице: площадки, кластеры, ключи. Ключей — не больше maxKeywords строк. */
export async function exportSheets(f: ListFilter, maxKeywords = 150_000): Promise<Sheet[]> {
  const sites = await prisma.compSite.findMany({ where: filterWhere(f), orderBy: ORDER[f.sort] ?? ORDER.clicks, take: 2000, omit: { data: true } });
  const ids = sites.filter((s) => s.status === "done").map((s) => s.id);
  const domainOf = new Map(sites.map((s) => [s.id, s.domain]));
  const clusters = ids.length ? await prisma.compCluster.findMany({ where: { siteId: { in: ids } }, orderBy: [{ siteId: "asc" }, { position: "asc" }] }) : [];
  const keywords = ids.length ? await prisma.compKeyword.findMany({ where: { siteId: { in: ids } }, orderBy: [{ siteId: "asc" }, { etv: "desc" }], take: maxKeywords }) : [];
  const order = new Map(sites.map((s, i) => [s.id, i]));
  const bySite = <T extends { siteId: string }>(a: T, b: T) => (order.get(a.siteId) ?? 0) - (order.get(b.siteId) ?? 0);
  return [
    {
      name: "Площадки",
      widths: [28, 12, 10, 12, 13, 11, 12, 13, 9, 12, 34, 11, 14, 50, 60, 70, 36],
      rows: [
        ["Домен", "Добавлен", "Сделок от", "Клики GSC за месяц", "Показы GSC за месяц", "Рост кликов за 3 мес, %", "Страны", "Запросов в топ-30", "В топ-10", "Оценка трафика из поиска", "Категории Collaborator", "Цена статьи", "Разбор", "Что за сайт", "Главные кластеры (доля оценки трафика)", "Что работает и что повторить", "Страница в Collaborator"],
        ...sites.map((s) => [s.domain, day(s.addedAt), s.deals, s.gscClicks, s.gscImpr, s.gscGrowth, list(s.countries), s.kwTotal, s.kwTop10, s.etv, list(s.categories), s.price != null ? `${Math.round(s.price)} ${s.currency}` : "", STATUS_LABELS[s.status] ?? s.status, s.summary ?? "", s.mainClusters ?? "", s.takeaway ?? "", s.collabUrl]),
      ],
    },
    {
      name: "Кластеры",
      widths: [28, 34, 16, 10, 12, 8, 12, 80, 60, 50],
      rows: [
        ["Домен", "Кластер", "Тип", "Запросов", "Оценка трафика в мес", "Доля, %", "Суммарная частота", "Примеры запросов (частота, позиция)", "Какой контент собирает трафик", "Главные страницы"],
        ...[...clusters].sort((a, b) => bySite(a, b) || a.position - b.position).map((c) => [domainOf.get(c.siteId) ?? "", c.name, c.type, c.count, c.etv, c.share, c.volume, ((c.top as ClusterTop[] | null) ?? []).map((t) => `${t.kw} (${t.vol ?? 0}, поз. ${t.pos ?? "—"})`).join(", "), c.what ?? "", ((c.pages as string[] | null) ?? []).join("\n")]),
      ],
    },
    {
      name: "Ключи",
      widths: [28, 46, 10, 9, 10, 60, 34],
      rows: [
        ["Домен", "Запрос", "Частота", "Позиция", "Оценка трафика", "Страница", "Кластер"],
        ...[...keywords].sort((a, b) => bySite(a, b) || b.etv - a.etv).map((k) => [domainOf.get(k.siteId) ?? "", k.kw, k.volume, k.pos, k.etv, k.url ?? "", k.cluster]),
      ],
    },
  ];
}

