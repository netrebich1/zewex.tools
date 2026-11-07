/**
 * Импорт декор-ключей с частотностью из выгрузки Google-таблицы «Темы 2027» (вкладка Decor → decor_all.tsv).
 *   npx tsx scripts/keywords/import-decor.ts <файл.tsv> [--min=1000] [--taken=2026-10-21T08:00:00Z] [--apply]
 * Колонки: Ключ, Источник (исходник | найдено ИИ), Сезонность, Частотность (аудитория US/мес), Диапазон (от-до).
 * Ниша — interior; ключи, которые уже есть в базе (по нормализованной форме), не трогаются. Только частотность,
 * без снимков выдачи. Нужно Article Copy: классы ВЧ/СЧ/НЧ для интерьерных ядер.
 */
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/db";
import { normPhrase } from "@/lib/keywords/metrics";
import { MIN_VOLUME } from "@/lib/keywords/types";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const APPLY = args.includes("--apply");
const MIN = Number(opt("min") ?? 1000);
const TAKEN = new Date(opt("taken") ?? "2026-10-21T08:00:00Z");
if (!file) throw new Error("Укажите TSV-файл");

async function main() {
  const rows = readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"));
  const h = rows[0];
  const col = (name: string) => { const i = h.findIndex((x) => x.startsWith(name)); if (i < 0) throw new Error(`Нет колонки «${name}»`); return i; };
  const iK = col("Ключ"), iSrc = col("Источник"), iSe = col("Сезонность"), iV = col("Частотность"), iR = col("Диапазон");
  const existing = new Set((await prisma.kwKeyword.findMany({ select: { norm: true } })).map((k) => k.norm));
  const seen = new Set<string>();
  let below = 0, oneWord = 0, dup = 0, added = 0;
  const data: Array<{ phrase: string; norm: string; source: string; season: string; volume: number; lo: number | null; hi: number | null }> = [];
  for (const r of rows.slice(1)) {
    const phrase = (r[iK] ?? "").trim();
    const v = Number(r[iV]);
    if (!phrase || !Number.isFinite(v)) continue;
    const norm = normPhrase(phrase);
    if (v < MIN) { below++; continue; }
    if (norm.split(" ").length < 2) { oneWord++; continue; }
    if (existing.has(norm) || seen.has(norm)) { dup++; continue; }
    seen.add(norm);
    const m = /^(\d+)-(\d+)$/.exec((r[iR] ?? "").trim());
    data.push({ phrase, norm, source: (r[iSrc] ?? "").includes("ИИ") ? "generated" : "sheet", season: (r[iSe] ?? "").trim() ? "soft" : "none", volume: v, lo: m ? Number(m[1]) : null, hi: m ? Number(m[2]) : null });
  }
  console.log(`строк ${rows.length - 1}: ниже ${MIN} — ${below}, одно слово — ${oneWord}, уже в базе — ${dup}, к загрузке — ${data.length}`);
  console.log(`из них ≥ ${MIN}: ${data.length}, ≥ ${MIN_VOLUME}: ${data.filter((d) => d.volume >= MIN_VOLUME).length}, ≥ 10 000: ${data.filter((d) => d.volume >= 10000).length}, ≥ 30 000: ${data.filter((d) => d.volume >= 30000).length}`);
  if (!APPLY) { console.log("без --apply ничего не записано"); await prisma.$disconnect(); return; }
  for (const d of data) {
    const k = await prisma.kwKeyword.create({
      data: { phrase: d.phrase, norm: d.norm, niche: "interior", source: d.source, season: d.season, status: "new", volume: d.volume, volLower: d.lo, volUpper: d.hi, volAt: TAKEN, verdict: d.volume < MIN_VOLUME ? "low_volume" : null },
      select: { id: true },
    });
    await prisma.kwVolume.create({ data: { keywordId: k.id, estimate: d.volume, lower: d.lo, upper: d.hi, takenAt: TAKEN } });
    added++;
  }
  console.log(`загружено ${added}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
