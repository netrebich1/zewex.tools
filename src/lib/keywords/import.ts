import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { guessNiche, hum, normPhrase } from "./metrics";
import { recomputeKeywords, urlHash } from "./recompute";
import { classifySeason, seasonFromSheet } from "./season";
import { scenarioNiche, type SerpAgg } from "./types";

/** Стартовые данные из ручного сбора 2026-10-20 (сессия 18fe03bc): лист Evergreen, частотность, снимки выдачи, даты статей. */
export const STARTER_FILE = join(process.cwd(), "prisma", "seed-data", "keywords", "starter.json");
/** Когда снимались стартовые данные (для истории частотности и снимков). */
const STARTER_AT = new Date("2026-10-20T10:00:00Z");

type Starter = {
  sheet: Array<{ keyword: string; seoKeyword: string; focus: string; scenario: string; mode: string; season: string }>;
  volume: Record<string, { estimate?: number; lower_bound?: number; upper_bound?: number; none?: boolean }>;
  serp: Record<string, SerpAgg>;
  artdates: Record<string, string>;
};

/** Аккаунты прототипа и их состояние на 2026-10-20. */
const ACCOUNTS: Array<{ name: string; status: string; gapSec: number; note: string }> = [
  { name: "SEO Netrebich", status: "LIMITED", gapSec: 10, note: "ограничение поиска после ~170 быстрых запросов (ручной сбор 2026-10-20)" },
  { name: "W", status: "SLOW", gapSec: 20, note: "медленный режим с 2026-10-20" },
];

export type ImportReport = { keywords: number; created: number; volumes: number; snapshots: number; articles: number; skipped: number };

const domainOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/**
 * Загружает стартовые данные. Повторный запуск безопасен: ключи сливаются по `norm`,
 * частотность и снимок не добавляются ключу, у которого они уже есть.
 */
export async function importStarter(): Promise<ImportReport> {
  const data = JSON.parse(await readFile(STARTER_FILE, "utf8")) as Starter;
  const rep: ImportReport = { keywords: 0, created: 0, volumes: 0, snapshots: 0, articles: 0, skipped: 0 };

  const accounts = new Map<string, string>();
  for (const a of ACCOUNTS) {
    const ex = await prisma.kwAccount.findUnique({ where: { name: a.name } });
    const acc = ex ?? (await prisma.kwAccount.create({ data: { name: a.name, status: a.status, gapSec: a.gapSec } }));
    if (!ex) await prisma.kwAccountEvent.create({ data: { accountId: acc.id, at: STARTER_AT, kind: a.status === "LIMITED" ? "limited" : "resumed", result: a.status === "LIMITED" ? "error" : "ok", note: a.note } });
    accounts.set(a.name, acc.id);
  }

  // Ключи: сначала лист Evergreen, затем всё, у чего есть частотность или выдача.
  const rows = new Map<string, Prisma.KwKeywordCreateManyInput>();
  for (const r of data.sheet) {
    const norm = normPhrase(r.focus);
    if (!norm || rows.has(norm)) continue;
    rows.set(norm, {
      phrase: r.focus.trim(), norm, source: "sheet", niche: scenarioNiche(r.scenario) || guessNiche(norm), season: seasonFromSheet(r.season),
      articleKeyword: r.keyword || null, seoKeyword: r.seoKeyword || null, scenario: r.scenario || null, mode: r.mode || null,
    });
  }
  const suggested = new Set<string>();
  for (const s of Object.values(data.serp)) for (const t of s.ta ?? []) suggested.add(normPhrase(hum(t)));
  for (const k of [...Object.keys(data.volume), ...Object.keys(data.serp)]) {
    const norm = normPhrase(k);
    if (!norm || rows.has(norm)) continue;
    rows.set(norm, { phrase: k.trim(), norm, source: suggested.has(norm) ? "autocomplete" : "generated", niche: guessNiche(norm), season: classifySeason(norm) });
  }
  const list = [...rows.values()];
  for (let i = 0; i < list.length; i += 500) rep.created += (await prisma.kwKeyword.createMany({ data: list.slice(i, i + 500), skipDuplicates: true })).count;
  const ids = new Map((await prisma.kwKeyword.findMany({ where: { norm: { in: [...rows.keys()] } }, select: { id: true, norm: true } })).map((k) => [k.norm, k.id]));
  rep.keywords = ids.size;

  // Частотность — только ключам, у которых её ещё нет.
  const hasVol = new Set((await prisma.kwVolume.findMany({ where: { keywordId: { in: [...ids.values()] } }, select: { keywordId: true }, distinct: ["keywordId"] })).map((v) => v.keywordId));
  const vols: Prisma.KwVolumeCreateManyInput[] = [];
  for (const [k, v] of Object.entries(data.volume)) {
    const id = ids.get(normPhrase(k));
    if (!id || hasVol.has(id)) { rep.skipped++; continue; }
    hasVol.add(id);
    vols.push({ keywordId: id, estimate: v.none ? null : v.estimate ?? null, lower: v.lower_bound ?? null, upper: v.upper_bound ?? null, none: !!v.none, source: "ads_ui", region: "US", takenAt: STARTER_AT });
  }
  for (let i = 0; i < vols.length; i += 500) rep.volumes += (await prisma.kwVolume.createMany({ data: vols.slice(i, i + 500) })).count;

  // Снимки выдачи с топ-10.
  const hasSnap = new Set((await prisma.kwSerpSnapshot.findMany({ where: { keywordId: { in: [...ids.values()] } }, select: { keywordId: true }, distinct: ["keywordId"] })).map((v) => v.keywordId));
  for (const [k, s] of Object.entries(data.serp)) {
    const id = ids.get(normPhrase(k));
    if (!id || hasSnap.has(id) || !s.n) { rep.skipped++; continue; }
    hasSnap.add(id);
    const { top = [], ta = [], guides = [], acc, ...agg } = s;
    await prisma.kwSerpSnapshot.create({
      data: {
        keywordId: id, accountId: accounts.get(acc || "SEO Netrebich") ?? null, takenAt: STARTER_AT,
        agg: agg as unknown as Prisma.InputJsonValue, typeahead: ta, guides,
        pins: { create: top.map(([link, date, saves], i) => ({ position: i + 1, link: link || null, linkHash: link?.startsWith("http") ? urlHash(link) : null, domain: link ? domainOf(link) : null, createdAt: date ? new Date(`${date}T00:00:00Z`) : null, saves: saves === "" ? null : saves })) },
      },
    });
    rep.snapshots++;
  }

  // Даты статей.
  const arts = Object.entries(data.artdates).map(([url, d]) => ({ urlHash: urlHash(url), url, domain: domainOf(url) ?? "", publishedAt: /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`) : null, status: d ? "ok" : "nodate", fetchedAt: STARTER_AT }));
  for (let i = 0; i < arts.length; i += 500) rep.articles += (await prisma.kwArticle.createMany({ data: arts.slice(i, i + 500), skipDuplicates: true })).count;

  await recomputeKeywords([...ids.values()]);
  return rep;
}
