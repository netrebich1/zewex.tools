/**
 * Пересобрать углы и ТЗ по карточкам тем же путём, что кнопки «+ ТЗ для сайта» и «Беру этот угол» (расход — в прогоны angles/brief).
 * Запуск: npx tsx scripts/news/rebuild-brief.ts <userId> <сайт> <clusterId> [clusterId…]
 * Сайт — домен из списка сайтов проекта (beautydaily.com.ua).
 */
import { prisma } from "@/lib/db";
import { buildSiteBrief, startSiteWork } from "@/lib/news/work";

async function main() {
  const [userId, site, ...ids] = process.argv.slice(2);
  if (!userId || !site || !ids.length) throw new Error("нужны userId, сайт и id кластеров");
  for (const id of ids) {
    const t = Date.now();
    await startSiteWork(userId, id, site, true);
    const b0 = await prisma.newsBrief.findUniqueOrThrow({ where: { clusterId_site: { clusterId: id, site } } });
    await buildSiteBrief(userId, b0.id, 0);
    const c = await prisma.newsCluster.findUniqueOrThrow({ where: { id }, select: { titleUk: true, title: true } });
    const b = await prisma.newsBrief.findUniqueOrThrow({ where: { id: b0.id } });
    const a = (b.angles as { angles: { kind: string; title: string }[]; gaps: string[] }).angles;
    console.log(`\n==================== ${c.titleUk || c.title} → ${site} (${Math.round((Date.now() - t) / 1000)} с)`);
    console.log("УГЛЫ: " + a.map((x, i) => `${i + 1}) [${x.kind}] ${x.title}`).join(" | "));
    console.log((b.brief ?? "").split("\n## Внутрішні посилання")[0]);
  }
  const cost = await prisma.newsRun.aggregate({ _sum: { costUsd: true }, where: { kind: { in: ["angles", "brief"] }, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } });
  console.log(`\nрасход за пересборку: $${(cost._sum.costUsd ?? 0).toFixed(4)}`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
