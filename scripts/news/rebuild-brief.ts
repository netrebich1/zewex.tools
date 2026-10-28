/**
 * Пересобрать углы и ТЗ по карточкам тем же путём, что кнопки «В работу» и «Беру этот угол» (расход — в прогоны angles/brief).
 * Запуск: npx tsx scripts/news/rebuild-brief.ts <userId> <clusterId> [clusterId…]
 */
import { prisma } from "@/lib/db";
import { buildBrief, startWork } from "@/lib/news/work";

async function main() {
  const [userId, ...ids] = process.argv.slice(2);
  if (!userId || !ids.length) throw new Error("нужны userId и id кластеров");
  for (const id of ids) {
    const t = Date.now();
    await startWork(userId, id, true);
    await buildBrief(userId, id, 0);
    const c = await prisma.newsCluster.findUniqueOrThrow({ where: { id }, select: { titleUk: true, title: true, angles: true, brief: true } });
    const a = (c.angles as { angles: { kind: string; title: string }[]; gaps: string[] }).angles;
    console.log(`\n==================== ${c.titleUk || c.title} (${Math.round((Date.now() - t) / 1000)} с)`);
    console.log("УГЛЫ: " + a.map((x, i) => `${i + 1}) [${x.kind}] ${x.title}`).join(" | "));
    console.log((c.brief ?? "").split("\n## Внутрішні посилання")[0]);
  }
  const cost = await prisma.newsRun.aggregate({ _sum: { costUsd: true }, where: { kind: { in: ["angles", "brief"] }, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } });
  console.log(`\nрасход за пересборку: $${(cost._sum.costUsd ?? 0).toFixed(4)}`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
