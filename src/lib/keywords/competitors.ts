/**
 * Конкуренты: какие сайты держат топ-10 по многим ключам — перенос docs/keyword-research/prototype/competitors.py.
 * Считается на лету по последнему снимку каждого ключа (снимков ~тысячи, это быстро).
 * Отличие от прототипа: ниша берётся из ключа (`KwKeyword.niche`, по сценарию Таблицы), а не только угадывается по словам.
 */
import { prisma } from "@/lib/db";
import { monthsAgo } from "./metrics";
import { urlHash } from "./recompute";
import { PLATFORM } from "./hosts";
import { NICHES } from "./types";

/** Платформы и магазины — общий список с расчётом ключей (lib/keywords/hosts.ts). */
export { PLATFORM };

export type CompetitorRow = {
  host: string;
  kind: "platform" | "site";
  kws: number; kwsPct: number;
  pins: number; avgPos: number;
  vol: number;
  niches: Record<string, number>;
  medSaves: number | null;
  ageNewest: number | null; ageOldest: number | null; ageAvg: number | null;
  dated: number; datedPct: number;
  examples: string[];
};

/** Хост как в прототипе: netloc в нижнем регистре без «www.». */
function hostOf(u: string): string {
  try {
    return new URL(u).host.toLowerCase().split("www.").join("");
  } catch {
    return "";
  }
}

export type CompetitorFilter = { niche?: string; kind?: string; q?: string; min?: number };

export async function competitors(f: CompetitorFilter = {}, now = new Date()): Promise<{ total: number; rows: CompetitorRow[] }> {
  const kws = await prisma.kwKeyword.findMany({
    where: { serpAt: { not: null }, ...(f.niche ? { niche: f.niche } : {}) },
    select: {
      phrase: true, niche: true, volume: true, volNone: true,
      snapshots: { orderBy: { takenAt: "desc" }, take: 1, select: { agg: true, pins: { orderBy: { position: "asc" }, select: { position: true, link: true, saves: true } } } },
    },
  });
  const serp = kws.filter((k) => k.snapshots[0] && (k.snapshots[0].agg as { n?: number } | null)?.n);
  const links = new Set<string>();
  for (const k of serp) for (const p of k.snapshots[0].pins) if (p.link) links.add(p.link);
  const hashes = [...links].map(urlHash);
  const dates = new Map<string, string>();
  for (let i = 0; i < hashes.length; i += 2000) {
    for (const a of await prisma.kwArticle.findMany({ where: { urlHash: { in: hashes.slice(i, i + 2000) }, publishedAt: { not: null } }, select: { url: true, publishedAt: true } })) {
      dates.set(a.url, a.publishedAt!.toISOString().slice(0, 10));
    }
  }

  type Acc = { kws: Set<string>; pins: number; pos: number[]; ages: number[]; saves: number[]; niches: Record<string, number>; vol: number; kwVol: Map<string, number> };
  const D = new Map<string, Acc>();
  const total = serp.length;
  for (const k of serp) {
    const seen = new Set<string>();
    const vnum = k.volNone ? 0 : k.volume ?? 0;
    for (const p of k.snapshots[0].pins) {
      if (!p.link) continue;
      const host = hostOf(p.link);
      if (!host) continue;
      let e = D.get(host);
      if (!e) D.set(host, (e = { kws: new Set(), pins: 0, pos: [], ages: [], saves: [], niches: {}, vol: 0, kwVol: new Map() }));
      e.pins++;
      e.pos.push(p.position);
      if (p.saves != null) e.saves.push(p.saves);
      const d = dates.get(p.link);
      const a = d ? monthsAgo(d, now) : null;
      if (a != null && a >= 0) e.ages.push(a);
      if (!seen.has(host)) {
        seen.add(host);
        e.kws.add(k.phrase);
        e.kwVol.set(k.phrase, vnum);
        e.niches[k.niche] = (e.niches[k.niche] ?? 0) + 1;
        e.vol += vnum;
      }
    }
  }

  const med = (a: number[]) => (a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : null);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
  let rows: CompetitorRow[] = [];
  for (const [host, e] of D) {
    const n = e.kws.size;
    if (n < Math.max(2, f.min ?? 2)) continue;
    rows.push({
      host, kind: PLATFORM.test(host) ? "platform" : "site",
      kws: n, kwsPct: pct(n, total), pins: e.pins, avgPos: r1(e.pos.reduce((p, q) => p + q, 0) / e.pos.length), vol: e.vol,
      niches: Object.fromEntries(NICHES.map((x) => [x.key, e.niches[x.key] ?? 0])),
      medSaves: med(e.saves),
      ageNewest: e.ages.length ? r1(Math.min(...e.ages)) : null, ageOldest: e.ages.length ? r1(Math.max(...e.ages)) : null,
      ageAvg: e.ages.length ? r1(e.ages.reduce((p, q) => p + q, 0) / e.ages.length) : null,
      dated: e.ages.length, datedPct: pct(e.ages.length, e.pins),
      examples: [...e.kws].sort((a, b) => (e.kwVol.get(b) ?? 0) - (e.kwVol.get(a) ?? 0)).slice(0, 8),
    });
  }
  rows.sort((a, b) => b.kws - a.kws || b.pins - a.pins);
  if (f.kind === "site" || f.kind === "platform") rows = rows.filter((r) => r.kind === f.kind);
  const q = f.q?.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.host.includes(q));
  return { total, rows };
}
