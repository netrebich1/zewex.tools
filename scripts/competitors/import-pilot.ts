/**
 * Перенос пробного разбора 21.11.2026 (файлы /root/zewex-pilot/out и /clusters) в таблицы «Анализа конкурентов»,
 * чтобы не платить за те же площадки второй раз. Запускать после первого сбора каталога (площадки уже в базе).
 * Идемпотентно: разобранные площадки пропускаются.
 *   npx tsx scripts/competitors/import-pilot.ts [папка, по умолчанию /root/zewex-pilot]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { prisma } from "@/lib/db";
import { buildClusters, saveAnalysis, type KwRow } from "@/lib/competitors/analyze";

type OutFile = { domain: string; total: number; metrics?: { organic?: Record<string, number | null> } | null; rows: Array<{ kw: string; vol: number | null; pos: number | null; etv: number | null; url: string | null }> };
type ClFile = { site: string; takeaway: string; clusters: Array<{ name: string; type: string; what: string; kws: string[] }> };

async function main() {
  const dir = process.argv[2] || "/root/zewex-pilot";
  let done = 0, empty = 0, skipped = 0, missing = 0;
  for (const f of readdirSync(`${dir}/out`).filter((x) => x.endsWith(".json"))) {
    const src = JSON.parse(readFileSync(`${dir}/out/${f}`, "utf8")) as OutFile;
    const site = await prisma.compSite.findFirst({ where: { domain: src.domain }, select: { id: true, status: true } });
    if (!site) { missing++; console.log(src.domain, "нет в каталоге"); continue; }
    if (site.status === "done" || site.status === "empty") { skipped++; continue; }
    const org = src.metrics?.organic ?? {};
    const rows: KwRow[] = src.rows.filter((r) => r.kw).map((r) => ({ kw: r.kw.slice(0, 300), vol: r.vol ?? 0, pos: r.pos, etv: r.etv ?? 0, url: r.url }));
    const ranked = { total: src.total, top10: (org.pos_1 ?? 0) + (org.pos_2_3 ?? 0) + (org.pos_4_10 ?? 0), etv: Math.round(org.etv ?? 0), rows };
    const clPath = `${dir}/clusters/${f}`;
    if (!existsSync(clPath) || rows.length < 20) {
      await prisma.compSite.update({ where: { id: site.id }, data: { status: "empty", kwTotal: ranked.total, kwTop10: ranked.top10, etv: ranked.etv, kwCountry: "Украина", analyzedAt: new Date("2026-11-21T09:40:00Z") } });
      empty++;
      continue;
    }
    const cl = JSON.parse(readFileSync(clPath, "utf8")) as ClFile;
    // В пробных файлах кластер хранит сами запросы — переводим в номера строк (одинаковые запросы идут по порядку).
    const free = new Map<string, number[]>();
    rows.forEach((r, i) => free.set(r.kw, [...(free.get(r.kw) ?? []), i]));
    const raw = cl.clusters.map((c) => ({ name: c.name, type: c.type, what: c.what, idx: c.kws.map((k) => free.get(k)?.shift()).filter((i): i is number => i !== undefined) }));
    await saveAnalysis(site.id, src.domain, "Украина", ranked, { site: cl.site, takeaway: cl.takeaway, clusters: buildClusters(rows, raw, src.domain) }, 0.06);
    done++;
  }
  console.log(`перенесено ${done}, мало данных ${empty}, уже разобрано ${skipped}, нет в каталоге ${missing}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
