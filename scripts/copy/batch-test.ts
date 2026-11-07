/**
 * Проверка планировщика партий без сборки: создаёт партию, сразу ставит на паузу, печатает раскладку и удаляет её.
 *   sudo -u zewex_tools_usr -H npx tsx scripts/copy/batch-test.ts --site thefreshstyle.com --site styles-4-you.com --quota nails:hi=5,mid=5 --quota hair:low=4
 * --cores "almond nails;blunt bob" — только эти ядра (квоты тогда задают число по нишам и классу any). --photos 25 --photos-max 35 — диапазон фото; --max-per-word 3 — разнообразие. С --keep партия остаётся на паузе (продолжить можно с экрана), с --run — сразу собирается. --year 2027, --season (разрешить сезонные), --publish (без проверки), --name. --writer openrouter:google/gemini-2.5-flash-lite — модель писателя вместо модели сценария (A/B).
 */
import { prisma } from "@/lib/db";
import { planBatch, type Quotas } from "@/lib/copy/batch";

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
  const sites = await prisma.artSite.findMany({ where: { OR: get("--site").flatMap((s) => [{ name: s }, { id: s }]) }, select: { id: true, name: true } });
  const quotas: Quotas = {};
  for (const q of get("--quota")) {
    const [niche, rest] = q.split(":");
    quotas[niche] = Object.fromEntries(rest.split(",").map((p) => { const [k, v] = p.split("="); return [k, Number(v)]; }));
  }
  const user = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  const t0 = Date.now();
  const r = await planBatch({ name: get("--name")[0] ?? "Тест планировщика", siteIds: sites.map((s) => s.id), quotas, word: get("--word")[0] ?? "", cores: get("--cores")[0]?.split(";"), photos: Number(get("--photos")[0] ?? 25), photosMax: get("--photos-max")[0] ? Number(get("--photos-max")[0]) : null, maxPerWord: Number(get("--max-per-word")[0] ?? 3), review: !args.includes("--publish"), noSeason: !args.includes("--season"), year: get("--year")[0] ? Number(get("--year")[0]) : null, writerModel: get("--writer")[0] ?? null, createdById: user!.id });
  if (!args.includes("--run")) await prisma.copyBatch.update({ where: { id: r.id }, data: { status: "paused" } });
  const items = await prisma.copyBatchItem.findMany({ where: { batchId: r.id }, orderBy: { position: "asc" } });
  const name = new Map(sites.map((s) => [s.id, s.name]));
  console.log(`партия ${r.id}: запланировано ${r.planned} за ${Date.now() - t0} мс${r.note ? `\nзаметка: ${r.note}` : ""}`);
  console.table(items.map((i) => ({ n: i.position, niche: i.niche, core: i.core, cls: i.volClass, vol: i.volume, site: name.get(i.siteId) })));
  if (!args.includes("--keep") && !args.includes("--run")) { await prisma.copyBatch.delete({ where: { id: r.id } }); console.log("партия удалена"); }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
