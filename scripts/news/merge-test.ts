/** Склейка дублей кластеров: без флага — пробно (печатает группы, ничего не пишет), с --real — склеивает. */
import { prisma } from "@/lib/db";
import { mergeStep } from "@/lib/news/merge";
import { parseSettings, emptyStats } from "@/lib/news/types";
async function main() {
  const p = await prisma.newsProject.findFirstOrThrow({ where: { siteUrl: { contains: "beautydaily" } } });
  const s = parseSettings(p.settings);
  let cost = 0;
  const ctx = { userId: p.createdById!, teamId: p.teamId, projectId: p.id, op: "dev" as const, runId: "merge-test", classifyModel: s.classifyModel, embedModel: s.embedModel, onCost: (u: number) => (cost += u) };
  const stats = emptyStats();
  await mergeStep(p.id, ctx, s, stats, (m) => console.log(m), process.argv[2] !== "--real");
  console.log("cost", cost.toFixed(4), "merged", stats.clustersMerged ?? "-");
  await prisma.$disconnect();
}
main();
