/**
 * Блоговые Canvas-стили (zxb:*) → каталог: создать/обновить из кода, утвердить и поставить отрисовку превью.
 *   npx tsx scripts/pins/seed-blog-styles.ts [--no-approve]
 * Утверждение снимается на странице «Стили» → Canvas, как у любого стиля каталога.
 */
import { prisma } from "@/lib/db";
import { CATALOG_LIB, seedCuratedStyles } from "@/lib/pins/canvas/catalog";
import { enqueueJob, JobConflict } from "@/lib/pins/jobs";

async function main() {
  const r = await seedCuratedStyles();
  console.log(`curated: created ${r.created}, updated ${r.updated}${r.invalid.length ? `, invalid: ${r.invalid.join(" | ")}` : ""}`);
  if (!process.argv.includes("--no-approve")) {
    const a = await prisma.pinCanvasStyle.updateMany({ where: { libraryId: CATALOG_LIB, id: { startsWith: "zxb:" }, isActive: true }, data: { isApproved: true } });
    console.log(`approved zxb:*: ${a.count}`);
  }
  const missing = await prisma.pinCanvasStyle.count({ where: { libraryId: CATALOG_LIB, isActive: true, previewPath: null } });
  const sys = await prisma.pinRun.findFirst({ where: { name: "__system__" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!missing) console.log("previews: all present");
  else if (!sys) console.log(`previews: ${missing} missing, no __system__ run — press «Собрать каталог» on the Styles page`);
  else {
    try { await enqueueJob(sys.id, "previews", {}); console.log(`previews: ${missing} queued`); }
    catch (e) { if (e instanceof JobConflict) console.log("previews: job already queued"); else throw e; }
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
