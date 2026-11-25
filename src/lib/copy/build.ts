/**
 * Article Copy, этап 1: пересборка карты ключей (CopyCore) из таблиц сервиса «Статьи». Статьи только читаются.
 * По каждому ядру считает: формулировки и сайты, где оно уже стоит, уникальные опубликованные кадры и кадры резерва,
 * сколько новых статей выходит по правилам владельца (CopySettings) и на сколько привязанных сайтов.
 * Запускает воркер: по кнопке «Пересчитать» (rebuildRequestedAt) и раз в 6 часов (copyTick из worker/cron.ts).
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { FORMULATIONS, SHARED_TEAM, capacityByPhotos, groupOf, splitKeyword, volClassOf } from "./keys";

const REBUILD_EVERY_MS = 6 * 60 * 60_000;
let running = false;

export async function copySettings() {
  return prisma.copySettings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
}

type Pool = { articles: number; published: Set<string>; reserve: Set<string> };
export type CoreForm = { k: string; m: string; s: string; a: string; u: string | null };

export async function rebuildCopy(): Promise<{ cores: number; ms: number }> {
  const started = Date.now();
  const st = await copySettings();
  const [arts, copySitesAll, mashups] = await Promise.all([
    prisma.article.findMany({ select: { id: true, teamId: true, siteId: true, keyword: true, wpUrl: true, publishedAt: true, recipeRef: { select: { nicheCode: true } }, site: { select: { nicheCode: true } } } }),
    prisma.copySite.findMany(),
    prisma.copyArticle.findMany({ select: { articleId: true } }),
  ]);
  const copySites = copySitesAll.filter((s) => s.publish);
  // Доноры фото: все сайты, кроме отмеченных «не донор»; сами мешап-статьи кадров в банк не добавляют.
  const notDonor = new Set(copySitesAll.filter((s) => !s.donor).map((s) => s.artSiteId));
  const mashupIds = new Set(mashups.map((m) => m.articleId));
  const isDonor = (a: { id: string; siteId: string }) => !mashupIds.has(a.id) && !notDonor.has(a.siteId);
  const artSites = await prisma.artSite.findMany({ where: { id: { in: copySites.map((s) => s.artSiteId) }, isActive: true }, select: { id: true, teamId: true, nicheCode: true } });

  type Row = { teamId: string; niche: string; core: string; forms: CoreForm[]; sites: Set<string> };
  const rows = new Map<string, Row>();
  const used = new Map<string, Set<string>>();
  const pools = new Map<string, Pool>();
  const poolOfArticle = new Map<string, Pool>();
  const poolKey = (teamId: string, niche: string, core: string) => `${st.sharedBank ? "*" : teamId}|${niche}|${core}`;

  for (const a of arts) {
    const { core, modifier } = splitKeyword(a.keyword);
    if (!core) continue;
    const niche = a.recipeRef?.nicheCode || a.site.nicheCode || "other";
    const rowTeam = st.sharedBank ? SHARED_TEAM : a.teamId;
    const rk = `${rowTeam}|${niche}|${core}`;
    let r = rows.get(rk);
    if (!r) rows.set(rk, (r = { teamId: rowTeam, niche, core, forms: [], sites: new Set() }));
    r.forms.push({ k: a.keyword, m: modifier, s: a.siteId, a: a.id, u: a.wpUrl });
    r.sites.add(a.siteId);
    const uk = `${niche}|${core}`;
    let u = used.get(uk);
    if (!u) used.set(uk, (u = new Set()));
    u.add(modifier);
    if (a.publishedAt && a.wpUrl && isDonor(a)) {
      const pk = poolKey(a.teamId, niche, core);
      let p = pools.get(pk);
      if (!p) pools.set(pk, (p = { articles: 0, published: new Set(), reserve: new Set() }));
      p.articles++;
      poolOfArticle.set(a.id, p);
    }
  }

  // Кадры: хватает начала отпечатка — экономит память на ~650 тыс. строк.
  const photos = await prisma.$queryRaw<Array<{ a: string; s: string }>>`SELECT p.articleId a, LEFT(p.sha256, 16) s FROM ArtPhoto p JOIN Article x ON x.id = p.articleId WHERE x.publishedAt IS NOT NULL AND x.wpUrl IS NOT NULL AND p.excluded = 0 AND p.sha256 IS NOT NULL`;
  // Сводка по кадрам: сколько раз каждый опубликованный кадр уже стоит в статьях (донорских и мешап) и ниша кадра.
  const nicheOf = new Map<string, string>();
  for (const a of arts) nicheOf.set(a.id, a.recipeRef?.nicheCode || a.site.nicheCode || "other");
  const uses = new Map<string, number>();
  const shaNiche = new Map<string, string>();
  for (const p of photos) {
    poolOfArticle.get(p.a)?.published.add(p.s);
    uses.set(p.s, (uses.get(p.s) ?? 0) + 1);
    if (!shaNiche.has(p.s) && poolOfArticle.has(p.a)) shaNiche.set(p.s, nicheOf.get(p.a) ?? "other");
  }
  const reserve = await prisma.$queryRaw<Array<{ a: string; s: string }>>`SELECT c.articleId a, LEFT(c.sha256, 16) s FROM ArtPhotoCandidate c JOIN Article x ON x.id = c.articleId WHERE x.publishedAt IS NOT NULL AND x.wpUrl IS NOT NULL AND c.status IN ('reserve', 'keep') AND c.sha256 IS NOT NULL AND COALESCE(c.aiScore, 0) >= ${st.minReserveScore}`;
  for (const c of reserve) poolOfArticle.get(c.a)?.reserve.add(c.s);

  // Частотность: ключи «Подбора ключей» (Ads Manager) сводятся к тем же ядрам, берётся максимум по ядру.
  const volumes = new Map<string, number>();
  for (const k of await prisma.kwKeyword.findMany({ where: { volume: { not: null } }, select: { phrase: true, volume: true } })) {
    const { core } = splitKeyword(k.phrase);
    if (core) volumes.set(core, Math.max(volumes.get(core) ?? 0, k.volume!));
  }

  type NicheStat = { published: number; reserve: number; uses1: number; uses2: number; uses3: number; usesLeft: number };
  const stats: Record<string, NicheStat> = {};
  const statOf = (n: string) => (stats[n] ??= { published: 0, reserve: 0, uses1: 0, uses2: 0, uses3: 0, usesLeft: 0 });
  for (const [s, n] of shaNiche) {
    const st0 = statOf(n);
    const u = uses.get(s) ?? 1;
    st0.published++;
    if (u <= 1) st0.uses1++; else if (u === 2) st0.uses2++; else st0.uses3++;
    st0.usesLeft += Math.max(0, st.maxUsesTotal - u);
  }
  const reserveSeen = new Set<string>();
  for (const c of reserve) {
    const p = poolOfArticle.get(c.a);
    if (!p || p.published.has(c.s) || uses.has(c.s) || reserveSeen.has(c.s)) continue;
    reserveSeen.add(c.s);
    const st0 = statOf(nicheOf.get(c.a) ?? "other");
    st0.reserve++;
    st0.usesLeft += st.maxUsesTotal;
  }

  const builtAt = new Date();
  const data: Prisma.CopyCoreCreateManyInput[] = [];
  for (const r of rows.values()) {
    const p = pools.get(poolKey(r.teamId, r.niche, r.core));
    let reserveOnly = 0;
    if (p) for (const s of p.reserve) if (!p.published.has(s)) reserveOnly++;
    const grp = groupOf(r.niche);
    const usedMods = [...(used.get(`${r.niche}|${r.core}`) ?? [])];
    const freeSites = artSites.filter((s) => (st.sharedBank || s.teamId === r.teamId) && groupOf(s.nicheCode) === grp && !r.sites.has(s.id)).length;
    const byPhotos = p ? capacityByPhotos({ published: p.published.size, reserve: reserveOnly, articles: p.articles, perArticle: st.photosPerArticle, maxOverlapPct: st.maxOverlapPct }) : 0;
    data.push({
      id: randomUUID(), teamId: r.teamId, grp, niche: r.niche, core: r.core, articles: p?.articles ?? 0,
      formulations: r.forms, siteIds: [...r.sites], usedModifiers: usedMods, freeModifiers: FORMULATIONS.filter((m) => !usedMods.includes(m)).length,
      photosPublished: p?.published.size ?? 0, photosReserve: reserveOnly, byPhotos, freeSites, capacity: Math.min(byPhotos, freeSites), builtAt,
      volume: volumes.get(r.core) ?? null, volClass: volClassOf(volumes.get(r.core)),
    });
  }
  const ops: Prisma.PrismaPromise<unknown>[] = [prisma.copyCore.deleteMany({})];
  for (let i = 0; i < data.length; i += 500) ops.push(prisma.copyCore.createMany({ data: data.slice(i, i + 500) }));
  await prisma.$transaction(ops);
  const ms = Date.now() - started;
  await prisma.copySettings.update({ where: { id: "main" }, data: { builtAt, buildMs: ms, buildError: null, stats: { niches: stats } as unknown as Prisma.InputJsonValue } });
  return { cores: data.length, ms };
}

/** Тик воркера: пересчёт по запросу с экрана или если карта старше 6 часов. */
export async function copyTick(): Promise<{ rebuilt: boolean; cores?: number; ms?: number }> {
  if (running) return { rebuilt: false };
  const st = await copySettings();
  const due = !st.builtAt || (st.rebuildRequestedAt && st.rebuildRequestedAt > st.builtAt) || Date.now() - st.builtAt.getTime() > REBUILD_EVERY_MS;
  if (!due) return { rebuilt: false };
  running = true;
  try {
    return { rebuilt: true, ...(await rebuildCopy()) };
  } catch (e) {
    await prisma.copySettings.update({ where: { id: "main" }, data: { buildError: (e instanceof Error ? e.message : String(e)).slice(0, 2000), builtAt: new Date() } }).catch(() => {});
    throw e;
  } finally {
    running = false;
  }
}
