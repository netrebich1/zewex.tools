import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { fetchText } from "./fetch";
import { pageRelevant, topicOf } from "./research";
import { KEEP_DAYS, type NewsSettings, type RunStats } from "./types";

/**
 * Метка «є на сайті»: ищем в WordPress сайта проекта статью про это событие — по герою, не раньше чем за 2 дня
 * до первой публикации; совпадение темы по тем же правилам, что у ресёрча (герой в заголовке + слова темы или те же дни).
 */
export type OnSite = { url: string; title: string; at: string };

type Row = { id: string; title: string; titleUk: string | null; mainEntityName: string | null; entities: unknown; firstPublishedAt: Date };

const decode = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&#8217;|&rsquo;/g, "’").replace(/&#8211;/g, "–").replace(/&#8220;|&#8221;|&quot;/g, "\"").replace(/&amp;/g, "&").trim();

export async function findOnSite(siteUrl: string, c: Row): Promise<OnSite | null> {
  const t = topicOf(c);
  if (!siteUrl || !t.hero) return null;
  const base = new URL(/^https?:/i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
  // По фамилии/последнему слову имени: сайт может писать «Періс», а у нас «Паріс».
  const q = t.hero.split(/\s+/).filter((w) => w.length >= 3).slice(-1)[0] ?? t.hero;
  const after = new Date(c.firstPublishedAt.getTime() - 2 * 86_400_000).toISOString().slice(0, 19);
  const u = `${base.origin}/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&after=${after}&per_page=10&_fields=link,title,date`;
  const r = await fetchText(u, { timeoutMs: 12_000, accept: "application/json" });
  if (!r.ok) return null;
  let j: { link?: string; title?: { rendered?: string }; date?: string }[];
  try {
    j = JSON.parse(r.text);
  } catch {
    return null;
  }
  for (const x of Array.isArray(j) ? j : []) {
    const title = decode(String(x.title?.rendered ?? ""));
    const at = x.date ? new Date(x.date) : null;
    if (!x.link || !title) continue;
    const rel = pageRelevant(t, { title, lead: "", publishedAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : undefined }, true);
    if (rel.ok) return { url: String(x.link), title, at: at?.toISOString() ?? new Date().toISOString() };
  }
  return null;
}

/** Проверить и записать метку по одному кластеру (кнопка «В работу», избранное). */
export async function checkOnSite(clusterId: string): Promise<OnSite | null> {
  const c = await prisma.newsCluster.findUniqueOrThrow({ where: { id: clusterId }, select: { id: true, title: true, titleUk: true, mainEntityName: true, entities: true, firstPublishedAt: true, projectId: true, onSite: true } });
  const p = await prisma.newsProject.findUniqueOrThrow({ where: { id: c.projectId }, select: { siteUrl: true } });
  const found = await findOnSite(p.siteUrl, c);
  await prisma.newsCluster.update({ where: { id: clusterId }, data: { onSite: found ? (found as unknown as Prisma.InputJsonValue) : Prisma.DbNull, onSiteAt: new Date() } });
  return found;
}

/** Шаг прогона: кластеры ниши за сутки, ещё не проверенные или проверенные давно (статья выходит через часы после новости). */
export async function onSiteStep(project: { id: string; siteUrl: string }, s: NewsSettings, stats: RunStats, log: (m: string) => void) {
  if (!project.siteUrl) return;
  const rows = await prisma.newsCluster.findMany({
    where: {
      projectId: project.id, lastItemAt: { gte: new Date(Date.now() - 24 * 3600_000) }, firstPublishedAt: { gte: new Date(Date.now() - KEEP_DAYS * 86_400_000) }, score: { gte: s.minScore }, category: { in: s.targetCategories }, status: { not: "rejected" },
      mainEntityName: { not: null }, OR: [{ onSiteAt: null }, { onSiteAt: { lt: new Date(Date.now() - 4 * 3600_000) }, onSite: { equals: Prisma.DbNull } }],
    },
    orderBy: { score: "desc" },
    take: 80,
    select: { id: true, title: true, titleUk: true, mainEntityName: true, entities: true, firstPublishedAt: true },
  });
  if (!rows.length) return;
  let idx = 0;
  let found = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (idx < rows.length) {
      const c = rows[idx++];
      try {
        const hit = await findOnSite(project.siteUrl, c);
        if (hit) found++;
        await prisma.newsCluster.update({ where: { id: c.id }, data: { onSite: hit ? (hit as unknown as Prisma.InputJsonValue) : Prisma.DbNull, onSiteAt: new Date() } });
      } catch (e) {
        log(`є на сайті: ${e instanceof Error ? e.message : e}`);
      }
    }
  }));
  stats.onSite = found;
  if (found) log(`є на сайті: ${found} з ${rows.length} перевірених`);
}
