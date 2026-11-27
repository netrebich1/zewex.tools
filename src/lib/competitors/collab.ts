/**
 * Каталог Collaborator.pro (API v2, https://collaborator.pro/api/v2/docs): площадки, добавленные за 3 месяца.
 * Ключ — COLLABORATOR_API_KEY в .env на сервере. Лимит 100 чтений в минуту: темп держим по заголовкам ответа.
 * В базу попадают только площадки с кликами Google Search Console — остальным нечего разбирать.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { GeoAcc, geoWindows, type GeoBlock } from "./geo";
import { KEEP_DAYS, packList, type SiteData, type SyncStats } from "./types";

const BASE = process.env.COLLABORATOR_API_URL || "https://collaborator.pro/api/v2/public";

type Named = { id: number; name: string };
type Monthly = Array<{ month: string; value: number }>;
export type Creator = {
  id: number;
  name: string;
  is_domain_visible: boolean;
  url: string;
  categories: Named[];
  country: Named[];
  site_languages: Named[];
  traffic: number | null;
  gsc: { clicks?: { last_month?: number | null; monthly?: Monthly }; impressions?: { last_month?: number | null; monthly?: Monthly } } | null;
  deals_count_at_least: number | null;
  added_to_system_at: string | null;
  description: { original?: string; translations?: Record<string, string> } | null;
  keywords: number | null;
  serpstat_in_top: number | null;
  tags: string[];
  prices: Array<{ format_id: number; price_publication: { amount: string; currency: string } | null }>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(path: string): Promise<T> {
  const key = process.env.COLLABORATOR_API_KEY;
  if (!key) throw new Error("COLLABORATOR_API_KEY не задан в .env на сервере");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { headers: { "X-Api-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 429 && attempt < 6) {
      await sleep((Number(res.headers.get("Retry-After")) || 5) * 1000 + 1000);
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
      throw new Error(`Collaborator: ${body?.detail ?? body?.title ?? `HTTP ${res.status}`}`);
    }
    const remaining = Number(res.headers.get("X-Ratelimit-Remaining"));
    if (Number.isFinite(remaining) && remaining < 3) await sleep((Number(res.headers.get("X-Ratelimit-Reset")) || 5) * 1000 + 1000);
    return (await res.json()) as T;
  }
}

/** Проверка ключа: роль аккаунта. */
export async function collabPing(): Promise<string> {
  const r = await get<{ account_role?: string }>("/me/capabilities");
  return r.account_role ?? "?";
}

/** Все площадки, добавленные за 3 месяца (самые новые первыми). */
export async function fetchNewCreators(shouldStop: () => boolean = () => false): Promise<Creator[]> {
  const out: Creator[] = [];
  for (let page = 1; page <= 300; page++) {
    if (shouldStop()) throw new Error("остановлено");
    const d = await get<{ items: Creator[]; pagination: { page_count: number } }>(`/creator/list?add_system=4&per_page=100&page=${page}&language=ru&sort=-first_moderation_at`);
    out.push(...d.items);
    if (!d.items.length || page >= d.pagination.page_count) break;
  }
  return out;
}

/** Рост последнего месяца к месяцу тремя раньше, %. */
function growth(monthly: Monthly | undefined): number | null {
  const m = (monthly ?? []).map((x) => Number(x.value) || 0);
  if (m.length < 4 || !m[m.length - 4]) return null;
  return Math.max(-100, Math.min(100_000, Math.round(((m[m.length - 1] - m[m.length - 4]) / m[m.length - 4]) * 100)));
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function toRow(c: Creator) {
  const article = c.prices?.find((p) => p.format_id === 1) ?? c.prices?.[0];
  const price = article?.price_publication ? Number(article.price_publication.amount) : null;
  const data: SiteData = {
    gsc: { clicks: c.gsc?.clicks?.monthly ?? [], impressions: c.gsc?.impressions?.monthly ?? [] },
    description: cut(c.description?.translations?.ru ?? c.description?.original ?? "", 1000),
    tags: (c.tags ?? []).slice(0, 20),
  };
  return {
    domain: cut(c.name.trim().toLowerCase(), 191),
    countries: cut(packList((c.country ?? []).map((x) => x.name)), 500),
    languages: cut(packList((c.site_languages ?? []).map((x) => x.name)), 300),
    categories: cut(packList((c.categories ?? []).map((x) => x.name)), 500),
    addedAt: c.added_to_system_at ? new Date(`${c.added_to_system_at}T00:00:00Z`) : null,
    deals: c.deals_count_at_least ?? 0,
    gscClicks: Math.round(c.gsc?.clicks?.last_month ?? 0),
    gscImpr: Math.round(c.gsc?.impressions?.last_month ?? 0),
    gscGrowth: growth(c.gsc?.clicks?.monthly),
    traffic: c.traffic ?? null,
    serpstatTop: c.serpstat_in_top ?? null,
    ahrefsKw: c.keywords ?? null,
    price: price != null && Number.isFinite(price) ? price : null,
    currency: article?.price_publication?.currency ?? "",
    collabUrl: cut(c.url ?? "", 300),
    data: data as unknown as Prisma.InputJsonValue,
  };
}

/**
 * Сбор: каталог за 3 месяца → площадки с кликами GSC и открытым доменом в базу (новые создаются, известные обновляют цифры).
 * Площадки, выпавшие из окна 3 месяцев и так и не разобранные, удаляются; разобранные остаются как архив.
 */
export async function syncCatalog(shouldStop: () => boolean = () => false): Promise<{ stats: SyncStats; windows: Record<string, GeoBlock> }> {
  const started = Date.now();
  const all = await fetchNewCreators(shouldStop);
  // Гео считаем по всем новым площадкам, а не только по тем, что с кликами GSC: заказы есть и без GSC.
  const windows = geoWindows(all);
  const good = all.filter((c) => c.is_domain_visible && c.name.includes(".") && (c.gsc?.clicks?.last_month ?? 0) > 0);
  const known = new Map((await prisma.compSite.findMany({ select: { collabId: true, id: true } })).map((s) => [s.collabId, s.id]));
  const now = new Date();
  let fresh = 0;
  for (const c of good) {
    const row = toRow(c);
    const id = known.get(c.id);
    if (id) await prisma.compSite.update({ where: { id }, data: { ...row, lastSeenAt: now } });
    else {
      await prisma.compSite.create({ data: { ...row, collabId: c.id } });
      fresh++;
    }
  }
  const border = new Date(Date.now() - (KEEP_DAYS + 7) * 86_400_000);
  const removed = await prisma.compSite.deleteMany({ where: { status: { in: ["none", "error", "empty"] }, lastSeenAt: { lt: border } } });
  return { stats: { total: all.length, kept: good.length, fresh, removed: removed.count, seconds: Math.round((Date.now() - started) / 1000) }, windows };
}

/**
 * Гео по всему каталогу (≈46 тысяч площадок, 460+ запросов, 5–6 минут при лимите 100 в минуту).
 * Площадки идут страницами прямо в накопитель и в памяти не держатся.
 */
export async function geoWholeCatalog(shouldStop: () => boolean = () => false): Promise<{ block: GeoBlock; total: number }> {
  const acc = new GeoAcc();
  let total = 0;
  // Ограничение API: page × per_page ≤ 100 000.
  for (let page = 1; page <= 1000; page++) {
    if (shouldStop()) throw new Error("остановлено");
    const d = await get<{ items: Creator[]; pagination: { page_count: number } }>(`/creator/list?per_page=100&page=${page}&language=ru&sort=-first_moderation_at`);
    for (const c of d.items) acc.add(c);
    total += d.items.length;
    if (!d.items.length || page >= d.pagination.page_count) break;
  }
  return { block: acc.block(), total };
}
