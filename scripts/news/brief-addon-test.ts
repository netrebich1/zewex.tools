/** Пробное ТЗ по карточке без записи в базу: углы + ТЗ по первому углу. Аргумент: <clusterId>. */
import { prisma } from "@/lib/db";
import { clusterForAi } from "@/lib/news/work";
import { makeAngles, makeBrief, ourArticles } from "@/lib/news/brief";
import { parseSettings } from "@/lib/news/types";
async function main() {
  const p = await prisma.newsProject.findFirstOrThrow({ where: { siteUrl: { contains: "beautydaily" } } });
  const s = parseSettings(p.settings);
  const id = process.argv[2];
  const { c, row } = await clusterForAi(id);
  let cost = 0;
  const ctx = { userId: p.createdById!, teamId: p.teamId, runId: "brief-test", classifyModel: s.classifyModel, embedModel: s.embedModel, onCost: (u: number) => (cost += u) };
  const ours = await ourArticles(p.siteUrl, c.entity ?? c.title);
  const a = await makeAngles(ctx, s, c, ours);
  const md = await makeBrief(ctx, s, "beautydaily.com.ua", c, a.angles[0], ours, row.summaryUk, null);
  console.log(md);
  console.log("COST", cost.toFixed(4));
  await prisma.$disconnect();
}
main();
