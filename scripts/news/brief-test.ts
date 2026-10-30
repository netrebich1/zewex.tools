/**
 * Проверка этапа 2 на живой карточке без записи в кластер: суть, 3 угла и ТЗ по первому углу.
 * Расход пишется в журнал (refId news-brief-test). Запуск: npx tsx scripts/news/brief-test.ts [clusterId]
 */
import { prisma } from "@/lib/db";
import { clusterForAi } from "@/lib/news/work";
import { makeAngles, makeBrief, ourArticles, summarizeClusters } from "@/lib/news/brief";
import { parseSettings } from "@/lib/news/types";
import { hostOf } from "@/lib/news/text";

async function main() {
  const id = process.argv[2] ?? (await prisma.newsCluster.findFirst({ where: { uaCount: { gte: 2 } }, orderBy: { score: "desc" }, select: { id: true } }))?.id;
  const skipSummary = process.argv[3] === "nosum";
  if (!id) throw new Error("нет кластера");
  const { c, row } = await clusterForAi(id);
  const p = await prisma.newsProject.findUniqueOrThrow({ where: { id: row.projectId } });
  const s = parseSettings(p.settings);
  let cost = 0;
  const ctx = { userId: p.createdById!, teamId: p.teamId, projectId: p.id, op: "dev" as const, runId: "news-brief-test", classifyModel: s.classifyModel, embedModel: s.embedModel, onCost: (u: number) => (cost += u) };
  console.log("КЛАСТЕР:", c.title, "| источников", c.sources.length, "| сигналы:", c.signals.slice(0, 3).join(" / "));
  const t0 = Date.now();
  const sum = skipSummary && row.summaryUk ? [{ id, titleUk: row.titleUk ?? "", summaryUk: row.summaryUk, whyUs: row.whyUs ?? "" }] : await summarizeClusters(ctx, s, [c]);
  console.log(`\n== СУТЬ (${Math.round((Date.now() - t0) / 1000)} с)\n`, JSON.stringify(sum, null, 1));
  const ours = await ourArticles(p.siteUrl, c.entity || c.title);
  console.log("\n== НАШИ СТАТЬИ\n", ours);
  const t1 = Date.now();
  const a = await makeAngles(ctx, s, c, ours);
  console.log(`\n== УГЛЫ (${Math.round((Date.now() - t1) / 1000)} с)\n`, JSON.stringify(a, null, 1));
  const t2 = Date.now();
  const md = await makeBrief(ctx, s, hostOf(p.siteUrl), c, a.angles[0], ours, sum[0]?.summaryUk ?? null);
  console.log(`\n== ТЗ (${Math.round((Date.now() - t2) / 1000)} с)\n${md}`);
  console.log(`\nрасход $${cost.toFixed(4)}`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
