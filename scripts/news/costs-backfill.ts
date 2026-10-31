/**
 * Разовое восстановление журнала расходов NewsCost (30.10) из общего UsageLog портала за всё время до первой записи журнала.
 * Статья — по виду прогона и слоту: плановый/ручной прогон → classify (вместе со склейкой) / embed / summary (слот brief);
 * «углы по кнопке» → angles; «ТЗ по кнопке» → brief; views-* → views; тестовые скрипты (*-test) → dev.
 * Повторный запуск ничего не дублирует: старше первой записи журнала строки уже есть — выходим.
 *   npx tsx scripts/news/costs-backfill.ts
 */
import { prisma } from "@/lib/db";
import { PROJECT_SLUG, SLOT_BRIEF, SLOT_CLASSIFY, SLOT_EMBED } from "@/lib/news/types";

async function main() {
  const proj = await prisma.project.findFirstOrThrow({ where: { slug: PROJECT_SLUG } });
  const first = await prisma.newsCost.findFirst({ where: { NOT: { runId: { startsWith: "backfill:" } } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  const cutoff = first?.createdAt ?? new Date();
  if (await prisma.newsCost.count({ where: { runId: { startsWith: "backfill:" } } })) return console.log("уже восстановлено");
  const logs = await prisma.usageLog.findMany({ where: { projectId: proj.id, createdAt: { lt: cutoff } }, include: { slot: { select: { key: true } }, model: { select: { modelId: true } } } });
  const runs = new Map((await prisma.newsRun.findMany({ select: { id: true, kind: true, projectId: true } })).map((r) => [r.id, r]));
  const projects = await prisma.newsProject.findMany({ select: { id: true } });
  const data = [];
  for (const l of logs) {
    const run = l.refId ? runs.get(l.refId) : undefined;
    const projectId = run?.projectId ?? (projects.length === 1 ? projects[0].id : null);
    if (!projectId) continue;
    const slot = l.slot?.key ?? "";
    const op = run
      ? run.kind === "angles" ? "angles" : run.kind === "brief" ? "brief" : slot === SLOT_EMBED ? "embed" : slot === SLOT_BRIEF ? "summary" : slot === SLOT_CLASSIFY ? "classify" : "other"
      : l.refId?.startsWith("views") ? "views" : l.refId?.includes("test") ? "dev" : "other";
    data.push({ projectId, runId: `backfill:${l.refId ?? ""}`.slice(0, 64), op, model: l.model?.modelId ?? null, inputTokens: l.inputTokens, outputTokens: l.outputTokens, costUsd: l.costUsd ?? 0, ok: l.ok, createdAt: l.createdAt });
  }
  for (let i = 0; i < data.length; i += 1000) await prisma.newsCost.createMany({ data: data.slice(i, i + 1000) });
  const sum = data.reduce((a, r) => a + r.costUsd, 0);
  console.log(`восстановлено ${data.length} вызовов из ${logs.length}, $${sum.toFixed(4)}, до ${cutoff.toISOString()}`);
}

main().finally(() => prisma.$disconnect());
