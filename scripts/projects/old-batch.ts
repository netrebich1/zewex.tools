/**
 * «Старые URL»: создать пачку старых страниц под новые пины и пересобрать таблицу.
 *   tsx scripts/projects/old-batch.ts                       — только пересобрать таблицу
 *   tsx scripts/projects/old-batch.ts sync                  — досбор недельной истории Метрики (команда Zewex) и пересборка
 *   tsx scripts/projects/old-batch.ts dry "Название" [20]   — посчитать, что попало бы в пачку (по N страниц «в работу» на сайт)
 *   tsx scripts/projects/old-batch.ts new "Название" [20]   — создать пачку (с контрольной группой) и пересобрать таблицу
 *   tsx scripts/projects/old-batch.ts del "Название"        — удалить пачку (страницы снова свободны)
 */
import { prisma } from "@/lib/db";
import { metrikaSync } from "@/lib/projects/stats";
import { createOldBatch, oldUrlsTick } from "@/lib/projects/oldurls";

(async () => {
  const [mode, name, n] = process.argv.slice(2);
  if (mode === "sync") {
    const team = await prisma.team.findUnique({ where: { slug: process.env.PRJ_OLD_TEAM || "zewex" }, select: { id: true } });
    console.log("metrika:", JSON.stringify(await metrikaSync(team!.id)));
    const g = await prisma.prjUrlHist.groupBy({ by: ["week"], where: { NOT: { path: "*" } }, _count: { _all: true }, _sum: { visits: true }, orderBy: { week: "asc" } });
    for (const r of g) console.log(`  ${r.week}: страниц ${r._count._all}, визитов ${r._sum.visits}`);
  }
  if (mode === "del") {
    if (!name) throw new Error("нужно название пачки");
    const r = await prisma.prjOldBatch.deleteMany({ where: { name } });
    console.log(`удалено пачек: ${r.count} (вкладку в таблице убрать руками)`);
  }
  if (mode === "dry" || mode === "new") {
    if (!name) throw new Error("нужно название пачки");
    const r = await createOldBatch(name, Number(n) || 20, { dry: mode === "dry" });
    console.log(`${mode === "dry" ? "ПРОБА" : "СОЗДАНА"} «${r.name}»: в работу ${r.test}, контроль ${r.control}, сайтов ${r.sites.length}`);
    for (const s of r.sites) console.log(`  ${s.site}: в работу ${s.test} (${s.visits} визитов за 4 нед), контроль ${s.control}`);
  }
  if (mode !== "dry") console.log("sheet:", JSON.stringify(await oldUrlsTick(true)));
})().catch((e) => { console.error("ERR", e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
