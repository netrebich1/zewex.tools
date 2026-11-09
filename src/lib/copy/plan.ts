/**
 * Планировщик Article Copy: вся картина для решений владельца — сколько мешап-статей можно собрать (по нишам и
 * частотности), сколько дописать на каждый сайт, хватит ли банка на новые сайты. Оценка сверху по карте ядер
 * (CopyCore) и бюджету кадров (CopySettings.stats): точная проверка идёт при сборке партии.
 */
import { prisma } from "@/lib/db";
import { copySettings } from "./build";
import { siteNiches } from "./auto";
import { SHARED_TEAM, VOL_CLASSES, groupOf, isSeasonal } from "./keys";

export type ClassKey = (typeof VOL_CLASSES)[number] | "other";
export type Cell = { cores: number; articles: number };
export type NicheCapacity = { niche: string; grp: string; byClass: Record<ClassKey, Cell>; byPhotos: number; photoBudget: number; articles: number };
type CoreLite = { niche: string; core: string; volClass: string | null; volume: number | null; byPhotos: number; siteIds: string[] };

const CLASS_OF = (v: string | null): ClassKey => (v === "hi" || v === "mid" || v === "low" ? v : "other");
const empty = (): Record<ClassKey, Cell> => ({ hi: { cores: 0, articles: 0 }, mid: { cores: 0, articles: 0 }, low: { cores: 0, articles: 0 }, other: { cores: 0, articles: 0 } });

/** Ядра, которые автоматика вообще берёт: ≥ 2 слов, не сезонные, есть кадры. */
export async function usableCores(): Promise<CoreLite[]> {
  const st = await copySettings();
  const rows = await prisma.copyCore.findMany({
    where: { ...(st.sharedBank ? { teamId: SHARED_TEAM } : {}), byPhotos: { gt: 0 }, core: { contains: " " } },
    select: { niche: true, core: true, volClass: true, volume: true, byPhotos: true, siteIds: true },
  });
  return rows.filter((r) => !isSeasonal(r.core)).map((r) => ({ ...r, siteIds: (r.siteIds as string[] | null) ?? [] }));
}

/** Ёмкость по нишам: статьи по темам (Σ byPhotos) против бюджета кадров (осталось использований / фото в статье). */
export async function nicheCapacity(cores: CoreLite[]): Promise<NicheCapacity[]> {
  const st = await copySettings();
  const stats = ((st.stats as { niches?: Record<string, { usesLeft: number }> } | null)?.niches) ?? {};
  const per = Math.max(1, st.photosPerArticle);
  const out = new Map<string, NicheCapacity>();
  for (const c of cores) {
    let n = out.get(c.niche);
    if (!n) out.set(c.niche, (n = { niche: c.niche, grp: groupOf(c.niche), byClass: empty(), byPhotos: 0, photoBudget: Math.floor((stats[c.niche]?.usesLeft ?? 0) / per), articles: 0 }));
    const cell = n.byClass[CLASS_OF(c.volClass)];
    cell.cores++;
    cell.articles += c.byPhotos;
    n.byPhotos += c.byPhotos;
  }
  for (const n of out.values()) {
    n.articles = Math.min(n.byPhotos, n.photoBudget);
    // Когда бюджет кадров меньше суммы по темам — ужимаем классы пропорционально.
    if (n.byPhotos > n.articles && n.byPhotos > 0) {
      const k = n.articles / n.byPhotos;
      for (const cell of Object.values(n.byClass)) cell.articles = Math.floor(cell.articles * k);
    }
  }
  return [...out.values()].sort((a, b) => b.articles - a.articles);
}

export type SiteCapacity = {
  id: string; name: string; team: string; grp: string; articles: number; niches: string[];
  recipient: boolean; donor: boolean; writingOn: boolean;
  /** Темы, которых на сайте ещё нет, по классам (с учётом уже собранных мешапов). */
  topics: Record<ClassKey, number>; topicsTotal: number;
  /** Сколько реально можно дописать: темы, ужатые бюджетом кадров ниш сайта. */
  addable: number;
};

/** По каждому активному сайту: сколько тем ещё свободно и сколько статей можно дописать. */
export async function siteCapacities(cores: CoreLite[], caps: NicheCapacity[]): Promise<SiteCapacity[]> {
  const [sites, copySites, done, teams, g] = await Promise.all([
    prisma.artSite.findMany({ where: { isActive: true }, select: { id: true, name: true, teamId: true, nicheCode: true, settings: true, _count: { select: { articles: true } } }, orderBy: [{ teamId: "asc" }, { name: "asc" }] }),
    prisma.copySite.findMany(),
    prisma.copyArticle.findMany({ select: { siteId: true, niche: true, core: true } }),
    prisma.team.findMany({ select: { id: true, name: true } }),
    prisma.artSettings.findUnique({ where: { id: "main" }, select: { writingMaster: true } }),
  ]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const cs = new Map(copySites.map((c) => [c.artSiteId, c]));
  const doneSet = new Set(done.map((d) => `${d.siteId}|${d.niche}|${d.core}`));
  const capByNiche = new Map(caps.map((c) => [c.niche, c]));
  const out: SiteCapacity[] = [];
  for (const s of sites) {
    const n = await siteNiches(s.id);
    const grp = s.nicheCode || n.size ? groupOf(s.nicheCode ?? [...n.keys()][0]) : null;
    if (!grp) continue;
    const niches = n.size ? [...n.keys()] : caps.filter((c) => c.grp === grp).map((c) => c.niche);
    const topics: Record<ClassKey, number> = { hi: 0, mid: 0, low: 0, other: 0 };
    const perNiche = new Map<string, number>();
    for (const c of cores) {
      if (!niches.includes(c.niche) || c.siteIds.includes(s.id) || doneSet.has(`${s.id}|${c.niche}|${c.core}`)) continue;
      topics[CLASS_OF(c.volClass)]++;
      perNiche.set(c.niche, (perNiche.get(c.niche) ?? 0) + 1);
    }
    let addable = 0;
    for (const [niche, t] of perNiche) addable += Math.min(t, capByNiche.get(niche)?.articles ?? 0);
    const settings = s.settings as { autostart?: { writingEnabled?: boolean } } | null;
    out.push({
      id: s.id, name: s.name, team: teamName.get(s.teamId) ?? "—", grp, articles: s._count.articles, niches,
      recipient: !!cs.get(s.id)?.publish, donor: cs.get(s.id)?.donor ?? true, writingOn: (g?.writingMaster ?? true) && (settings?.autostart?.writingEnabled ?? true),
      topics, topicsTotal: topics.hi + topics.mid + topics.low + topics.other, addable,
    });
  }
  return out.sort((a, b) => b.addable - a.addable);
}

export type NewSitesPlan = {
  requested: number; feasible: boolean; capacity: number;
  /** Рекомендованная раскладка одного сайта: ниша → класс → статей. */
  perSite: Array<{ niche: string; hi: number; mid: number; low: number; total: number }>;
  leftover: Array<{ niche: string; articles: number }>;
};

/**
 * Калькулятор новых сайтов: группы «N сайтов по M статей». Раскладка на сайт — пропорционально ёмкости ниш группы,
 * внутри ниши 30 % ВЧ / 35 % СЧ / 35 % НЧ (правило владельца), с ужатием до того, что есть.
 */
export function planNewSites(caps: NicheCapacity[], grp: string, groups: Array<{ sites: number; articles: number }>): NewSitesPlan {
  const g = caps.filter((c) => c.grp === grp && c.articles > 0);
  const capacity = g.reduce((s, c) => s + c.articles, 0);
  const requested = groups.reduce((s, x) => s + x.sites * x.articles, 0);
  const maxPerSite = Math.max(0, ...groups.map((x) => x.articles));
  const share = (c: NicheCapacity) => (capacity ? c.articles / capacity : 0);
  const perSite = g.map((c) => {
    const total = Math.round(maxPerSite * share(c));
    const want = { hi: Math.round(total * 0.3), mid: Math.round(total * 0.35), low: total - Math.round(total * 0.3) - Math.round(total * 0.35) };
    // Ужимаем до доступного по классу (на один сайт тема берётся один раз).
    const hi = Math.min(want.hi, c.byClass.hi.cores), mid = Math.min(want.mid, c.byClass.mid.cores), low = Math.min(want.low, c.byClass.low.cores + c.byClass.other.cores);
    return { niche: c.niche, hi, mid, low, total: hi + mid + low };
  });
  const used = new Map<string, number>();
  for (const x of groups) for (const p of perSite) used.set(p.niche, (used.get(p.niche) ?? 0) + x.sites * Math.round(x.articles * share(g.find((c) => c.niche === p.niche)!)));
  const leftover = g.map((c) => ({ niche: c.niche, articles: c.articles - (used.get(c.niche) ?? 0) }));
  return { requested, feasible: requested <= capacity && leftover.every((l) => l.articles >= 0), capacity, perSite, leftover };
}
