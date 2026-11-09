/**
 * Импорт набора ключей из ручного сбора (папка с vol.json, serp.json, artdates.json, fragments.json, soup*.json).
 *   npx tsx scripts/keywords/import-dataset.ts <папка> [--min=3000] [--taken=2026-10-21T05:00:00Z] [--apply]
 * Без --apply только считает, что будет загружено.
 *
 * Правила (сессия сбора 2026-10-21): частотность от --min, минимум 2 слова; дубли ед./мн. числа сливаются
 * (оставляется вариант с большей частотностью); «обрывки» из fragments.json не загружаются; ключи, которые уже есть
 * в базе (по той же нормализованной форме), не дублируются — им добавляются новая частотность (если изменилась)
 * и снимок выдачи (если отличается от последнего). Ниша — по словам ключа (guessNiche), сезонность — classifySeason.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { guessNiche, hum, normPhrase } from "@/lib/keywords/metrics";
import { recomputeKeywords, urlHash } from "@/lib/keywords/recompute";
import { classifySeason } from "@/lib/keywords/season";
import type { SerpAgg } from "@/lib/keywords/types";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const opt = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const APPLY = args.includes("--apply");
const MIN = Number(opt("min") ?? 3000);
const TAKEN = new Date(opt("taken") ?? "2026-10-21T05:00:00Z");
if (!dir) throw new Error("Укажите папку с данными");

const lj = <T,>(f: string, def: T): T => (existsSync(join(dir, f)) ? (JSON.parse(readFileSync(join(dir, f), "utf8").replace(/^﻿/, "")) as T) : def);
type Vol = { estimate?: number; lower_bound?: number; upper_bound?: number; none?: boolean };
const vol = lj<Record<string, Vol>>("vol.json", {});
const serp = lj<Record<string, SerpAgg>>("serp.json", {});
const artdates = lj<Record<string, string>>("artdates.json", {});
const fragments = lj<Record<string, string>>("fragments.json", {});
const soups = [lj<Record<string, string[]>>("soup.json", {}), lj<Record<string, string[]>>("soup2.json", {})];

/** Единственное число слова — как sing() прототипа. */
const sing = (w: string) => (w.endsWith("ies") ? w.slice(0, -3) + "y" : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
/** Форма для слияния дублей: нижний регистр, одиночные пробелы, каждое слово в ед. числе. */
const stem = (s: string) => normPhrase(s).split(" ").map(sing).join(" ");
const domainOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };

async function main() {
  // 1. Кандидаты: частотность от MIN, 2+ слова, не обрывки; дубли ед./мн. — по наибольшей частотности.
  const frag = new Set(Object.keys(fragments).map(normPhrase));
  const best = new Map<string, { phrase: string; v: Vol; variants: string[] }>();
  let below = 0, oneWord = 0, fragSkipped = 0;
  for (const [k, v] of Object.entries(vol)) {
    const n = normPhrase(k);
    if (!(v.estimate && v.estimate >= MIN)) { below++; continue; }
    if (n.split(" ").length < 2) { oneWord++; continue; }
    if (frag.has(n)) { fragSkipped++; continue; }
    const st = stem(n);
    const cur = best.get(st);
    if (!cur) best.set(st, { phrase: k.trim(), v, variants: [k] });
    else {
      cur.variants.push(k);
      if ((v.estimate ?? 0) > (cur.v.estimate ?? 0)) { cur.phrase = k.trim(); cur.v = v; }
    }
  }
  const serpBy = new Map(Object.entries(serp).filter(([, s]) => s?.n).map(([k, s]) => [normPhrase(k), s]));
  const suggested = new Set<string>();
  for (const s of soups) for (const list of Object.values(s)) for (const t of list ?? []) suggested.add(normPhrase(hum(t)));
  for (const s of serpBy.values()) for (const t of s.ta ?? []) suggested.add(normPhrase(hum(t)));

  // 2. Уже есть в базе — по той же форме слияния.
  const existing = await prisma.kwKeyword.findMany({ select: { id: true, norm: true, phrase: true } });
  const byStem = new Map(existing.map((e) => [stem(e.norm), e]));
  const toCreate: Prisma.KwKeywordCreateManyInput[] = [];
  let matched = 0;
  for (const [st, b] of best) {
    if (byStem.has(st)) { matched++; continue; }
    const norm = normPhrase(b.phrase);
    toCreate.push({ phrase: b.phrase, norm, source: suggested.has(norm) ? "autocomplete" : "generated", niche: guessNiche(norm), season: classifySeason(norm) });
  }
  console.log(`vol.json: ${Object.keys(vol).length} ключей; ниже ${MIN}: ${below}, одно слово: ${oneWord}, обрывков: ${fragSkipped}`);
  console.log(`после слияния ед./мн.: ${best.size}; уже в базе: ${matched}; новых: ${toCreate.length}`);
  const seasons: Record<string, number> = {};
  for (const r of toCreate) seasons[r.season as string] = (seasons[r.season as string] ?? 0) + 1;
  const niches: Record<string, number> = {};
  for (const r of toCreate) niches[r.niche as string] = (niches[r.niche as string] ?? 0) + 1;
  console.log(`новые по нишам: ${JSON.stringify(niches)}, по сезонности: ${JSON.stringify(seasons)}`);
  const withSerp = [...best.values()].filter((b) => b.variants.some((x) => serpBy.has(normPhrase(x)))).length;
  console.log(`со снимком выдачи: ${withSerp} из ${best.size}`);
  if (!APPLY) { console.log("Пробный прогон: ничего не записано. Добавьте --apply."); return; }

  // 3. Запись: ключи, частотность, снимки, даты статей, пересчёт.
  for (let i = 0; i < toCreate.length; i += 500) await prisma.kwKeyword.createMany({ data: toCreate.slice(i, i + 500), skipDuplicates: true });
  const all = await prisma.kwKeyword.findMany({ select: { id: true, norm: true } });
  const idByStem = new Map(all.map((e) => [stem(e.norm), e.id]));
  const accounts = new Map((await prisma.kwAccount.findMany({ select: { id: true, name: true } })).map((a) => [a.name, a.id]));
  const touched = new Set<string>();
  let vols = 0, snaps = 0, sameSnaps = 0;
  for (const [st, b] of best) {
    const id = idByStem.get(st);
    if (!id) continue;
    // Частотность: новая запись, если у ключа её нет или значение изменилось.
    const last = await prisma.kwVolume.findFirst({ where: { keywordId: id }, orderBy: { takenAt: "desc" }, select: { estimate: true, none: true } });
    if (!last || last.none || last.estimate !== b.v.estimate) {
      await prisma.kwVolume.create({ data: { keywordId: id, estimate: b.v.estimate ?? null, lower: b.v.lower_bound ?? null, upper: b.v.upper_bound ?? null, none: false, source: "ads_ui", region: "US", takenAt: TAKEN } });
      vols++;
      touched.add(id);
    }
    // Снимок выдачи: от варианта-представителя, иначе от любого варианта с выдачей.
    const s = serpBy.get(normPhrase(b.phrase)) ?? b.variants.map((x) => serpBy.get(normPhrase(x))).find(Boolean);
    if (!s) continue;
    const { top = [], ta = [], guides = [], acc, ...agg } = s;
    const prev = await prisma.kwSerpSnapshot.findFirst({ where: { keywordId: id }, orderBy: { takenAt: "desc" }, select: { agg: true, pins: { orderBy: { position: "asc" }, select: { link: true, saves: true } } } });
    const sig = (pins: Array<{ link: string | null; saves: number | null }>, a: Partial<SerpAgg>) => JSON.stringify([a.n, a.ad, a.prod, a.fresh3, a.med, pins.map((p) => [p.link ?? "", p.saves ?? null])]);
    const newSig = sig(top.map(([l, , sv]) => ({ link: l || null, saves: sv === "" ? null : sv })), agg as Partial<SerpAgg>);
    if (prev && sig(prev.pins, prev.agg as Partial<SerpAgg>) === newSig) { sameSnaps++; continue; }
    await prisma.kwSerpSnapshot.create({
      data: {
        keywordId: id, accountId: accounts.get(acc || "SEO Netrebich") ?? null, takenAt: TAKEN,
        agg: agg as unknown as Prisma.InputJsonValue, typeahead: ta, guides,
        pins: { create: top.map(([link, date, saves], i) => ({ position: i + 1, link: link || null, domain: link ? domainOf(link)?.slice(0, 190) ?? null : null, linkHash: link?.startsWith("http") ? urlHash(link) : null, createdAt: date ? new Date(`${date}T00:00:00Z`) : null, saves: saves === "" ? null : saves })) },
      },
    });
    snaps++;
    touched.add(id);
  }
  const arts = Object.entries(artdates).map(([url, d]) => ({ urlHash: urlHash(url), url, domain: domainOf(url)?.slice(0, 190) ?? "", publishedAt: /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`) : null, status: d ? "ok" : "nodate", fetchedAt: TAKEN }));
  let artsNew = 0;
  for (let i = 0; i < arts.length; i += 500) artsNew += (await prisma.kwArticle.createMany({ data: arts.slice(i, i + 500), skipDuplicates: true })).count;
  console.log(`записано: ключей ${toCreate.length}, замеров частотности ${vols}, снимков выдачи ${snaps} (такие же, как были: ${sameSnaps}), новых статей ${artsNew}`);
  const n = await recomputeKeywords([...touched]);
  console.log(`пересчитано ключей: ${n}`);
}
main().finally(() => prisma.$disconnect());
