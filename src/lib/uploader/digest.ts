/**
 * Сводки на «Сегодня» (по просьбе владельца 26.11.2026):
 * - `dayDigest` — итог заливки дня: сколько залито, сколько не залито и по каким причинам (прокси, вход, Dolphin…), что ещё в очереди,
 *   у кого после проверки 0 пинов в расписании. Считается из строк таблицы «Сегодня», без отдельных запросов.
 * - `growthAlerts` — зелёная плашка: сайты, где за последний полный день трафик с Pinterest (Метрика) или показы (аналитика Pinterest)
 *   выросли больше чем на 20% к тому же дню недели неделей раньше (среда к среде). Данные — `PrjStatDay`, их собирают
 *   агент заливки (Pinterest) и `metrikaTick` (Метрика). У Pinterest последний закрытый день бывает на 3–6 дней раньше сегодняшнего.
 * Без next/*.
 */
import { prisma } from "@/lib/db";
import { ERROR_LABELS, type ErrorKind } from "./types";
import type { TodayRow } from "./views";
import type { SiteRow } from "./sites";

export type DayDigest = {
  withFile: number; uploaded: number; queued: number; notStarted: number;
  failed: Array<{ kind: string; label: string; sites: string[] }>;
  emptySchedule: string[];
};

const ORDER: string[] = ["proxy_failed", "not_logged_in", "profile_not_found", "browser_missing", "dolphin_offline", "dolphin_auth", "rate_limited", "pinterest_rejected", "upload_form_changed", "profile_busy", "network", "unknown"];

export function dayDigest(rows: TodayRow[]): DayDigest {
  const withFile = rows.filter((r) => r.file && r.file.count > 0);
  const failed = new Map<string, string[]>();
  let uploaded = 0, queued = 0, notStarted = 0;
  const emptySchedule: string[] = [];
  for (const r of withFile) {
    if (r.uploaded) {
      uploaded++;
      if (r.lastTask?.scheduled === 0) emptySchedule.push(r.site.name);
      continue;
    }
    const t = r.lastTask;
    if (!t) { notStarted++; continue; }
    if (t.status === "QUEUED" || t.status === "LEASED") { queued++; continue; }
    if (t.status === "FAILED" || t.status === "SKIPPED") {
      const k = t.errorKind ?? "unknown";
      if (k === "no_file") { notStarted++; continue; }
      (failed.get(k) ?? failed.set(k, []).get(k)!).push(r.site.name);
      continue;
    }
    notStarted++;
  }
  return {
    withFile: withFile.length, uploaded, queued, notStarted, emptySchedule,
    failed: [...failed].map(([kind, sites]) => ({ kind, label: ERROR_LABELS[kind as ErrorKind] ?? kind, sites }))
      .sort((a, b) => (ORDER.indexOf(a.kind) + 100) % 100 - (ORDER.indexOf(b.kind) + 100) % 100 || b.sites.length - a.sites.length),
  };
}

export type Growth = { site: string; cur: number; prev: number; pct: number };
export type GrowthAlerts = { traffic: { day: string; prevDay: string; list: Growth[] } | null; impressions: { day: string; prevDay: string; list: Growth[] } | null };

const GROWTH = 0.2;
const dom = (s: string | null | undefined) => (s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Домены сайтов — как в «Трафике» Проектов: адрес подключённого сайта, иначе имя. */
async function domains(sites: SiteRow[]): Promise<Map<string, string>> {
  const acc = new Map((await prisma.siteAccess.findMany({ where: { id: { in: sites.map((s) => s.wpConnectionId).filter((x): x is string => !!x) } }, select: { id: true, baseUrl: true, name: true } })).map((a) => [a.id, a]));
  const out = new Map<string, string>();
  for (const s of sites) {
    const a = s.wpConnectionId ? acc.get(s.wpConnectionId) : null;
    const d = (a && (dom(a.baseUrl) || dom(a.name))) || dom(s.name);
    if (d) out.set(d, s.name);
  }
  return out;
}

export async function growthAlerts(sites: SiteRow[], today: string): Promise<GrowthAlerts> {
  const byDomain = await domains(sites);
  const names = [...byDomain.keys()];
  if (!names.length) return { traffic: null, impressions: null };
  const since = addDays(today, -20);
  const rows = await prisma.prjStatDay.findMany({
    where: { site: { in: names }, day: { gte: since, lt: today }, source: { in: ["metrika", "pinterest"] } },
    select: { source: true, site: true, day: true, estimate: true, pinVisits: true, impressions: true },
  });
  const pick = (source: string, val: (r: (typeof rows)[number]) => number | null, minPrev: number) => {
    const own = rows.filter((r) => r.source === source && !r.estimate);
    // Последний полный день — самый свежий день, по которому данные есть хотя бы у трети сайтов.
    const count = new Map<string, number>();
    for (const r of own) count.set(r.day, (count.get(r.day) ?? 0) + 1);
    const sitesWith = new Set(own.map((r) => r.site)).size;
    const day = [...count].filter(([, n]) => n >= Math.max(1, Math.ceil(sitesWith / 3))).map(([d]) => d).sort().pop();
    if (!day) return null;
    const prevDay = addDays(day, -7);
    const at = new Map(own.filter((r) => r.day === day || r.day === prevDay).map((r) => [`${r.site}|${r.day}`, val(r) ?? 0]));
    const list: Growth[] = [];
    for (const site of names) {
      const cur = at.get(`${site}|${day}`), prev = at.get(`${site}|${prevDay}`);
      if (cur == null || prev == null || prev < minPrev) continue;
      const pct = (cur - prev) / prev;
      if (pct > GROWTH) list.push({ site: byDomain.get(site) ?? site, cur, prev, pct });
    }
    list.sort((a, b) => b.pct - a.pct);
    return { day, prevDay, list };
  };
  // Порог базы: от малых чисел «+50%» ничего не значит (2 визита → 3).
  return { traffic: pick("metrika", (r) => r.pinVisits, 20), impressions: pick("pinterest", (r) => r.impressions, 1000) };
}
