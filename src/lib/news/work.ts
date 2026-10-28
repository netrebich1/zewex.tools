import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hostOf } from "./text";
import { makeAngles, makeBrief, ourArticles, summarizeClusters, type Angle, type ClusterForAi } from "./brief";
import type { AiCtx } from "./llm";
import { parseSettings, type NewsSettings, type RunStats, type ScorePart } from "./types";

/** Кластер для ИИ: источники (украинские первыми), сигналы балла и причины важности словами. */
export async function clusterForAi(clusterId: string): Promise<{ c: ClusterForAi; row: Prisma.NewsClusterGetPayload<object> }> {
  const row = await prisma.newsCluster.findUniqueOrThrow({ where: { id: clusterId } });
  const items = await prisma.newsItem.findMany({ where: { clusterId }, orderBy: { foundAt: "asc" }, select: { domain: true, title: true, lead: true, url: true, tier: true, publishedAt: true, foundAt: true, extraSources: true } });
  const sources = items.map((it) => ({ domain: it.domain, title: it.title, lead: it.lead ?? "", url: it.url, tier: it.tier, at: it.publishedAt ?? it.foundAt }));
  for (const it of items) {
    for (const x of Array.isArray(it.extraSources) ? (it.extraSources as { domain: string; url: string; tier: string; at: string }[]) : []) {
      if (!sources.some((s) => s.domain === x.domain)) sources.push({ domain: x.domain, title: it.title, lead: "", url: x.url, tier: x.tier, at: new Date(x.at) });
    }
  }
  sources.sort((a, b) => (a.tier === "world" ? 1 : 0) - (b.tier === "world" ? 1 : 0) || a.at.getTime() - b.at.getTime());
  const parts = Array.isArray(row.scoreParts) ? (row.scoreParts as ScorePart[]) : [];
  const why = Array.isArray(row.priorityWhy) ? (row.priorityWhy as string[]) : [];
  return {
    row,
    c: {
      id: row.id, title: row.titleUk || row.title, category: row.category, subcategory: row.subcategory, entity: row.mainEntityName,
      signals: [...why, ...parts.filter((p) => p.points > 0).map((p) => `${p.label}: ${p.why}`)].slice(0, 8), sources,
    },
  };
}

/** Прогон: украинская суть и «почему зайдёт» для топа ленты — новым кластерам и тем, где добавилось 2+ источника. */
export async function summaryStep(project: { id: string }, ctx: AiCtx, s: NewsSettings, stats: RunStats, log: (m: string) => void) {
  if (!s.autoSummaryPerDay) return;
  const dayStart = new Date(new Date().toISOString().slice(0, 10));
  const doneToday = await prisma.newsCluster.count({ where: { projectId: project.id, aiAt: { gte: dayStart } } });
  const left = s.autoSummaryPerDay - doneToday;
  if (left <= 0) return;
  // Все кластеры нашей ниши за сутки (не только топ-N): перевод и «почему зайдёт» нужны и в режиме «Свежее».
  const top = await prisma.newsCluster.findMany({
    where: { projectId: project.id, lastItemAt: { gte: new Date(Date.now() - 24 * 3600_000) }, score: { gte: s.minScore }, category: { in: s.targetCategories }, status: { not: "rejected" } },
    orderBy: { score: "desc" },
    take: 200,
    select: { id: true, aiAt: true, aiSourceCount: true, sourceCount: true },
  });
  const need = top.filter((c) => !c.aiAt || c.sourceCount >= c.aiSourceCount + 2).slice(0, Math.min(left, 60));
  if (!need.length) return;
  const loaded = await Promise.all(need.map((n) => clusterForAi(n.id)));
  const batches: (typeof loaded)[] = [];
  for (let i = 0; i < loaded.length; i += 5) batches.push(loaded.slice(i, i + 5));
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, async () => {
    while (idx < batches.length) {
      const b = batches[idx++];
      try {
        const res = await summarizeClusters(ctx, s, b.map((x) => x.c));
        for (const r of res) {
          const src = b.find((x) => x.c.id === r.id);
          await prisma.newsCluster.update({ where: { id: r.id }, data: { titleUk: r.titleUk || null, summaryUk: r.summaryUk, whyUs: r.whyUs || null, aiAt: new Date(), aiSourceCount: src?.row.sourceCount ?? 0 } });
          stats.summarized = (stats.summarized ?? 0) + 1;
        }
      } catch (e) {
        log(`суть карточек: ${e instanceof Error ? e.message : e}`);
      }
    }
  }));
}

/** Запись расхода кнопок «В работу» и «Сделать ТЗ» — отдельным прогоном, чтобы бюджет и журнал его видели. */
async function withCostRun<T>(projectId: string, userId: string, kind: "angles" | "brief", clusterId: string, teamId: string, fn: (ctx: AiCtx) => Promise<T>, s: NewsSettings): Promise<T> {
  const run = await prisma.newsRun.create({ data: { projectId, kind, scope: `cluster:${clusterId}`, userId, status: "running", startedAt: new Date() } });
  let cost = 0;
  const ctx: AiCtx = { userId, teamId, runId: run.id, classifyModel: s.classifyModel, embedModel: s.embedModel, onCost: (u) => (cost += u) };
  try {
    const out = await fn(ctx);
    await prisma.newsRun.update({ where: { id: run.id }, data: { status: "done", finishedAt: new Date(), costUsd: cost } });
    return out;
  } catch (e) {
    await prisma.newsRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: new Date(), costUsd: cost, error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) } });
    throw e;
  }
}

async function ourFor(project: { siteUrl: string }, c: ClusterForAi): Promise<{ title: string; url: string }[]> {
  const q = c.entity || c.title.split(/[:—–-]/)[0].slice(0, 60);
  return ourArticles(project.siteUrl, q);
}

/** «В работу»: статус in_work и 3 угла (повторно — «другие углы»). */
export async function startWork(userId: string, clusterId: string, regenerate: boolean): Promise<void> {
  const { c, row } = await clusterForAi(clusterId);
  const project = await prisma.newsProject.findUniqueOrThrow({ where: { id: row.projectId } });
  const s = parseSettings(project.settings);
  await prisma.newsCluster.update({ where: { id: clusterId }, data: { status: "in_work", workById: userId } });
  if (row.angles && !regenerate) return;
  const ours = await ourFor(project, c);
  const res = await withCostRun(project.id, userId, "angles", clusterId, project.teamId, (ctx) => makeAngles(ctx, s, c, ours), s);
  await prisma.newsCluster.update({
    where: { id: clusterId },
    data: { angles: { ...res, ours } as unknown as Prisma.InputJsonValue, anglesAt: new Date(), angleIdx: null, brief: null, briefAt: null },
  });
}

/** ТЗ по выбранному углу. */
export async function buildBrief(userId: string, clusterId: string, idx: number): Promise<void> {
  const { c, row } = await clusterForAi(clusterId);
  const project = await prisma.newsProject.findUniqueOrThrow({ where: { id: row.projectId } });
  const s = parseSettings(project.settings);
  const data = (row.angles ?? {}) as { angles?: Angle[]; ours?: { title: string; url: string }[] };
  const angle = data.angles?.[idx];
  if (!angle) throw new Error("Сначала нажмите «В работу» — модуль предложит углы");
  const ours = data.ours ?? (await ourFor(project, c));
  const site = hostOf(project.siteUrl) || project.name;
  let summaryUk = row.summaryUk;
  if (!summaryUk) {
    // Суть ещё не сгенерирована прогоном (мировая новость, низкий балл) — делаем её сейчас, иначе в ТЗ попадёт английский заголовок.
    const sum = await withCostRun(project.id, userId, "brief", clusterId, project.teamId, (ctx) => summarizeClusters(ctx, s, [c]), s);
    if (sum[0]) {
      summaryUk = sum[0].summaryUk;
      await prisma.newsCluster.update({ where: { id: clusterId }, data: { titleUk: sum[0].titleUk || null, summaryUk, whyUs: sum[0].whyUs || null, aiAt: new Date(), aiSourceCount: row.sourceCount } });
      c.title = sum[0].titleUk || c.title;
    }
  }
  const md = await withCostRun(project.id, userId, "brief", clusterId, project.teamId, (ctx) => makeBrief(ctx, s, site, c, angle, ours, summaryUk), s);
  await prisma.newsCluster.update({ where: { id: clusterId }, data: { angleIdx: idx, brief: md, briefAt: new Date(), status: "in_work", workById: userId } });
}
