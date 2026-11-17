import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { entryScores } from "./entry";
import { hostOf, isBlogLink } from "./hosts";
import { artStats, flags, monthsAgo, pct, positionSignals, profile, score, suggestions, variants, verdict, withYear, yearIn } from "./metrics";
import type { KwMetrics, SerpAgg, TopArt, TopTuple } from "./types";

export const urlHash = (u: string) => createHash("sha1").update(u).digest("hex");

const CHUNK = 200;

/** Значение частотности как в прототипе (`vnum`): «нет данных» = 0, иначе оценка; null — не снята. */
function volNum(v: { estimate: number | null; none: boolean } | undefined): number | null {
  if (!v) return null;
  if (v.none) return 0;
  return v.estimate ?? null;
}

type SnapPin = { pinId: string | null; link: string | null; createdAt: Date | null; saves: number | null; title: string | null; style: string | null };

/** Ключ пина для сравнения снимков: id пина, у старых снимков без id — ссылка + дата + сохранения. */
export const pinKey = (p: { pinId: string | null; link: string | null; createdAt: Date | null; saves: number | null }) =>
  p.pinId ?? `${p.link ?? ""}|${p.createdAt?.toISOString().slice(0, 10) ?? ""}|${p.saves ?? ""}`;

/**
 * Итог снимка для истории: вердикт и оценка (по выдаче и позициям, без данных статей — чтобы снимки сравнивались одинаково),
 * доли рекламы/товаров/свежих/блогов и ключи пинов топ-10.
 */
export type SnapSummary = {
  takenAt: string; account: string | null; verdict: string | null; score: number | null;
  n: number; com: number | null; ad: number | null; prod: number | null; info: number | null; video: number | null; fresh3: number | null;
  blogs: number | null; saves: number | null; volume: number | null; keys: string[];
};
export function snapSummary(agg: SerpAgg, pins: SnapPin[], vol: number | null, takenAt: Date, account: string | null): SnapSummary {
  const n = agg.n || 0;
  const top: TopTuple[] = pins.map((p) => [p.link ?? "", p.createdAt ? p.createdAt.toISOString().slice(0, 10) : "", p.saves ?? ""]);
  const links = pins.filter((p) => p.link?.startsWith("http"));
  return {
    takenAt: takenAt.toISOString(), account, verdict: verdict(vol, agg), score: score(vol, agg, { pos: positionSignals(top, takenAt) }),
    n, com: pct(agg.ad + agg.prod, n), ad: pct(agg.ad, n), prod: pct(agg.prod, n), info: pct(agg.info, n), video: pct(agg.video, n), fresh3: pct(agg.fresh3, n),
    blogs: links.length ? pct(links.filter((p) => isBlogLink(p.link)).length, links.length) : null, saves: agg.med ?? null, volume: vol,
    keys: pins.slice(0, 10).map(pinKey),
  };
}

/** Домены наших сайтов (раздел «Сайты» портала: адрес WordPress и домен ссылок) — для флага «наш сайт в топе». */
async function ownedDomains(): Promise<Set<string>> {
  const rows = await prisma.siteAccess.findMany({ select: { baseUrl: true, linkDomain: true } });
  const out = new Set<string>();
  for (const r of rows) for (const u of [r.baseUrl, r.linkDomain]) {
    const h = hostOf(u && !/^https?:/i.test(u) ? `https://${u}` : u);
    if (h) out.add(h);
  }
  return out;
}

const median = (a: number[]) => (a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : null);
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * Пересчитывает метрики в строках ключей по последнему снимку выдачи и последней частотности, итог снимка (`summary`)
 * и изменения относительно предыдущего снимка. ids не задан — все ключи. Возвращает число обновлённых строк.
 */
export async function recomputeKeywords(ids?: string[], now = new Date()): Promise<number> {
  const all = ids ?? (await prisma.kwKeyword.findMany({ select: { id: true } })).map((k) => k.id);
  let done = 0;
  const pinSelect = { orderBy: { position: "asc" as const }, select: { pinId: true, link: true, createdAt: true, saves: true, title: true, style: true } };
  const owned = await ownedDomains();
  for (let i = 0; i < all.length; i += CHUNK) {
    const rows = await prisma.kwKeyword.findMany({
      where: { id: { in: all.slice(i, i + CHUNK) } },
      select: {
        id: true, phrase: true,
        _count: { select: { snapshots: true } },
        volumes: { orderBy: { takenAt: "desc" }, take: 1, select: { estimate: true, lower: true, upper: true, none: true, takenAt: true } },
        snapshots: { orderBy: { takenAt: "desc" }, take: 2, select: { id: true, takenAt: true, accountId: true, agg: true, typeahead: true, guides: true, summary: true, account: { select: { name: true } }, pins: pinSelect } },
      },
    });
    const urls = new Set<string>();
    for (const r of rows) for (const p of r.snapshots[0]?.pins ?? []) if (p.link?.startsWith("http")) urls.add(p.link);
    const arts = urls.size ? await prisma.kwArticle.findMany({ where: { urlHash: { in: [...urls].map(urlHash) } }, select: { url: true, publishedAt: true, title: true, titleYear: true, words: true, images: true } }) : [];
    const pub = new Map(arts.filter((a) => a.publishedAt).map((a) => [a.url, a.publishedAt!.toISOString().slice(0, 10)]));
    const artBy = new Map(arts.map((a) => [a.url, a]));
    const year = now.getUTCFullYear();

    for (const r of rows) {
      const v = r.volumes[0];
      const snap = r.snapshots[0];
      const prevSnap = r.snapshots[1];
      const ta = (snap?.typeahead as string[] | null) ?? [];
      const s: SerpAgg | null = snap ? { ...(snap.agg as SerpAgg), ta } : null;
      const pinsTop = snap?.pins ?? [];
      const top: TopTuple[] = pinsTop.map((p) => [p.link ?? "", p.createdAt ? p.createdAt.toISOString().slice(0, 10) : "", p.saves ?? ""]);
      const vol = volNum(v);
      // Статьи топа считаются только по блогам: платформы и магазины (Instagram, Amazon…) — не конкуренты владельцу.
      const blogPub = (u: string) => (isBlogLink(u) ? pub.get(u) : undefined);
      const art = s ? artStats(top, blogPub, now) : null;
      const prof = profile(s);
      const dates = top.map(([u]) => blogPub(u)).filter((d): d is string => !!d).map((d) => Date.parse(d)).filter((t) => t <= now.getTime());
      const n = s?.n || 0;
      // Статьи топа: год в заголовке статьи → в заголовке пина → в адресе; устаревший = меньше текущего года.
      const topArt: Array<TopArt | null> = pinsTop.map((p) => {
        if (!p.link?.startsWith("http")) return null;
        const a = artBy.get(p.link);
        let path = "";
        try { path = new URL(p.link).pathname; } catch { /* битая ссылка */ }
        const y = a?.titleYear ?? yearIn(p.title) ?? yearIn(path);
        // Объём считаем только у статей блогов: < 150 слов — страница не отдала текст, > 15 000 — архив или лента, а не статья.
        const blog = isBlogLink(p.link);
        const article = blog && (a?.words ?? 0) >= 150 && (a?.words ?? 0) <= 15000;
        const title = a?.title && !/^(undefined|null)$/i.test(a.title) ? a.title : p.title ?? null;
        return { title, year: y, words: article ? a?.words ?? null : null, images: article ? a?.images ?? null : null, outdated: y != null && y < year, blog };
      });
      const linked = topArt.filter((x): x is TopArt => !!x);
      const blogsArt = linked.filter((x) => x.blog);
      const oldYears = s ? blogsArt.filter((x) => x.outdated).length : null;
      const blogs = s ? {
        links: linked.length, blogs: blogsArt.length, platforms: linked.length - blogsArt.length,
        domains: new Set(pinsTop.filter((p) => isBlogLink(p.link)).map((p) => hostOf(p.link))).size,
        top5: pinsTop.slice(0, 5).filter((p) => isBlogLink(p.link)).length,
      } : null;
      const pos = s ? positionSignals(top, now) : null;
      const extra = { pos, oldYears, withLinks: blogsArt.length };
      // Оформление пинов топ-10 (определяет воркер по картинке): коллаж и фото с надписью — «оформленные», чистое фото — нет.
      const topStyle = pinsTop.map((p) => p.style ?? null);
      const known = topStyle.filter((x): x is string => x === "collage" || x === "text" || x === "photo");
      const style = known.length ? { n: known.length, collage: known.filter((x) => x === "collage").length, text: known.filter((x) => x === "text").length, photo: known.filter((x) => x === "photo").length } : null;
      // Возраст пинов топ-10, месяцев.
      const pinAges = top.map(([, d]) => (d ? monthsAgo(d, now) : null)).filter((x): x is number => x != null && x >= 0);
      const { ul: _ul, ta: _ta, top: _top, guides: _g, ...agg } = s ?? ({} as SerpAgg);

      // История: итог последнего снимка и сравнение с предыдущим.
      const summary = snap && s ? snapSummary(s, pinsTop, vol, snap.takenAt, snap.account?.name ?? null) : null;
      let prev = (prevSnap?.summary as SnapSummary | null) ?? null;
      if (prevSnap && !prev && (prevSnap.agg as SerpAgg)?.n) prev = snapSummary(prevSnap.agg as SerpAgg, prevSnap.pins, vol, prevSnap.takenAt, prevSnap.account?.name ?? null);
      let overlap: number | null = null;
      if (summary && prev) {
        const b = new Set(prev.keys);
        const base = Math.max(summary.keys.length, prev.keys.length);
        overlap = base ? pct(summary.keys.filter((k) => b.has(k)).length, base) : null;
      }

      const d = {
        comPct: s ? pct(s.ad + s.prod, n) : null,
        bizPct: prof ? pct(prof.biz, prof.n) : null,
        blogPct: blogs ? pct(blogs.blogs, blogs.links) : null,
        pinAgeMed: r1(median(pinAges)),
        dvPct: prof ? pct(prof.dv, prof.n) : null, tmatchPct: s ? pct(s.tmatch, s.org) ?? 0 : null,
      };
      // Оценки входа нового и старого блога (docs/keyword-research/01-pinterest-algorithm.md, раздел 3).
      let entry: { entryNew: number | null; entryOld: number | null; redFlags: string[] } = { entryNew: null, entryOld: null, redFlags: [] };
      if (s && n) {
        const org = s.org || 0;
        const ageDays = pinsTop.map((p) => (p.createdAt ? (now.getTime() - p.createdAt.getTime()) / 864e5 : null));
        const t10 = pinsTop.length;
        const lHosts = pinsTop.filter((p) => p.link?.startsWith("http")).map((p) => hostOf(p.link));
        const hostCount = new Map<string, number>();
        for (const h of lHosts) if (h) hostCount.set(h, (hostCount.get(h) ?? 0) + 1);
        const ul = s.ul ?? [];
        const ours = (h: string) => [...owned].some((o) => h === o || h.endsWith(`.${o}`));
        const artAvg = art?.avg ?? null;
        entry = entryScores({
          ad: s.ad / n, prod: s.prod / n, vid: s.video / n,
          link: org ? s.info / org : 0,
          f30: t10 ? ageDays.filter((a) => a != null && a <= 30).length / t10 : null,
          old2y: t10 ? ageDays.filter((a) => a != null && a > 730).length / t10 : null,
          f90: org ? s.fresh3 / org : 0,
          savesMed: median(pinsTop.map((p) => p.saves).filter((x): x is number => x != null)),
          freshLowSave: pinsTop.filter((p, i) => ageDays[i] != null && ageDays[i]! <= 90 && (p.saves ?? 0) < 50).length,
          small: ul.length ? ul.filter((u) => (u[2] != null && u[2] < 5000) || (u[0] != null && u[0] < 100_000)).length / ul.length
            : s.fol != null ? (s.fol < 5000 ? 0.8 : s.fol < 20_000 ? 0.4 : 0.1) : null,
          // Доля одного домена значима от 3 ссылок: при 1–2 ссылках «один сайт держит топ» — случайность выборки.
          topDom: lHosts.length >= 3 ? Math.max(...hostCount.values()) / lHosts.length : null,
          own: s.own != null && s.resaved != null && s.own + s.resaved > 0 ? s.own / (s.own + s.resaved) : null,
          media: s.ndom ? s.big / s.ndom : 0,
          kwTitle: org ? s.tmatch / org : null,
          ourSite: lHosts.some((h) => !!h && ours(h)),
          artGap: artAvg != null ? (artAvg >= 12 || (oldYears ?? 0) >= 1 ? 1 : artAvg >= 6 ? 0.5 : 0.2) : (oldYears ?? 0) >= 1 ? 1 : null,
        });
      }

      const metrics: KwMetrics = {
        agg: s ? agg : null, prof, art, top,
        variants: variants(r.phrase, ta),
        suggestions: suggestions(r.phrase, ta),
        guides: (snap?.guides as string[] | null) ?? [],
        account: snap?.account?.name ?? null,
        computedAt: now.toISOString(),
        pos, topArt, topStyle, style, blogs,
      };
      const ops: Prisma.PrismaPromise<unknown>[] = [prisma.kwKeyword.update({
        where: { id: r.id },
        data: {
          volume: vol, volLower: v?.lower ?? null, volUpper: v?.upper ?? null, volNone: !!v?.none, volAt: v?.takenAt ?? null,
          serpAt: snap?.takenAt ?? null, serpAccountId: snap?.accountId ?? null,
          verdict: verdict(vol, s), score: score(vol, s, extra), flags: [...flags(s, art?.avg ?? null, extra), ...entry.redFlags].join(","),
          freshTopPct: pos?.freshW ?? null, linkTop5: pos?.linkTop5 ?? null, oldYears,
          blogLinks: blogs?.blogs ?? null, blogPct: d.blogPct,
          pinYearPct: s && s.ty != null ? pct(s.ty, s.org) ?? 0 : null,
          designedPct: style ? pct(style.collage + style.text, style.n) : null,
          collagePct: style ? pct(style.collage, style.n) : null, textPct: style ? pct(style.text, style.n) : null, photoPct: style ? pct(style.photo, style.n) : null,
          artWords: median(blogsArt.map((x) => x.words).filter((w): w is number => w != null)),
          artImages: median(blogsArt.map((x) => x.images).filter((w): w is number => w != null)),
          pins: s ? s.n : null,
          comPct: d.comPct,
          comN: s ? s.ad + s.prod : null, adN: s ? s.ad : null, prodN: s ? s.prod : null, infoN: s ? s.info : null, nolinkN: s ? s.nolink : null,
          videoN: s ? s.video : null, tmatchN: s ? s.tmatch : null, ownN: s?.own ?? null, resavedN: s?.resaved ?? null,
          fresh3N: s ? s.fresh3 : null, freshN: s ? s.fresh : null, tyN: s?.ty ?? null,
          bizN: prof?.biz ?? null, dvN: prof?.dv ?? null, merN: prof?.mer ?? null,
          designedN: style ? style.collage + style.text : null, collageN: style?.collage ?? null, textN: style?.text ?? null, photoN: style?.photo ?? null,
          adPct: s ? pct(s.ad, n) : null, prodPct: s ? pct(s.prod, n) : null, infoPct: s ? pct(s.info, n) : null,
          nolinkPct: s ? pct(s.nolink, n) : null,
          videoPct: s ? pct(s.video, n) : null, fresh3Pct: s ? pct(s.fresh3, n) : null, freshPct: s ? pct(s.fresh, n) : null,
          tmatchPct: d.tmatchPct,
          ownPct: s && s.own != null ? pct(s.own, s.org) ?? 0 : null, resavedPct: s && s.resaved != null ? pct(s.resaved, s.org) ?? 0 : null,
          listNum: s?.listn ?? null, linksTop10: s ? s.ndom : null,
          blogDomains: blogs?.domains ?? null, blogTop5: blogs?.top5 ?? null,
          freshTop3: pos?.freshTop3 ?? null, savesTop3: pos?.savesTop3 ?? null,
          pinAgeMin: pinAges.length ? Math.min(...pinAges) : null, pinAgeMed: d.pinAgeMed, pinAgeMax: pinAges.length ? Math.max(...pinAges) : null,
          artAgeMin: art?.newest ?? null, artAgeAvg: art?.avg ?? null, artAgeMax: art?.oldest ?? null,
          bizPct: d.bizPct, bizViewsAvg: prof?.views?.avg ?? null, bizFollowersAvg: prof?.followers?.avg ?? null,
          dvPct: d.dvPct, merPct: prof ? pct(prof.mer, prof.n) : null,
          medSaves: s?.med ?? null, medFollowers: s?.fol ?? null, bigCount: s ? s.big : null, domains: s ? s.udom : null,
          artCount: art?.count ?? (s ? 0 : null),
          artNewestAt: dates.length ? new Date(Math.max(...dates)) : null,
          artOldestAt: dates.length ? new Date(Math.min(...dates)) : null,
          artAvgAt: dates.length ? new Date(dates.reduce((p, q) => p + q, 0) / dates.length) : null,
          withYear: withYear(s),
          entryNew: entry.entryNew, entryOld: entry.entryOld,
          snapCount: r._count.snapshots,
          prevVerdict: prev?.verdict ?? null, prevSerpAt: prevSnap?.takenAt ?? null,
          verdictChanged: !!(summary && prev && summary.verdict !== prev.verdict),
          scoreDelta: summary && prev && summary.score != null && prev.score != null ? summary.score - prev.score : null,
          comDelta: summary && prev && summary.com != null && prev.com != null ? r1(summary.com - prev.com) : null,
          topOverlapPrev: overlap,
          metrics: metrics as unknown as Prisma.InputJsonValue,
        },
      })];
      if (snap && summary) ops.push(prisma.kwSerpSnapshot.update({ where: { id: snap.id }, data: { summary: summary as unknown as Prisma.InputJsonValue } }));
      if (prevSnap && prev && !prevSnap.summary) ops.push(prisma.kwSerpSnapshot.update({ where: { id: prevSnap.id }, data: { summary: prev as unknown as Prisma.InputJsonValue } }));
      await prisma.$transaction(ops);
      done++;
    }
  }
  return done;
}
