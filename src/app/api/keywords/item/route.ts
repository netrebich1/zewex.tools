import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { keywordsUser } from "@/lib/keywords/access";
import { snapSummary, type SnapSummary } from "@/lib/keywords/recompute";
import type { SerpAgg } from "@/lib/keywords/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/keywords/item?id= → карточка ключа для боковой панели: строка ключа (с metrics),
 * история снимков выдачи (итог каждого снимка) и история частотности.
 */
export async function GET(req: Request) {
  const me = await keywordsUser();
  if (!me) return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const k = await prisma.kwKeyword.findUnique({ where: { id } });
  if (!k) return NextResponse.json({ error: "Ключ не найден" }, { status: 404 });
  const [snaps, volumes, accounts] = await Promise.all([
    prisma.kwSerpSnapshot.findMany({
      where: { keywordId: id }, orderBy: { takenAt: "desc" }, take: 30,
      select: { takenAt: true, summary: true, agg: true, account: { select: { name: true } }, pins: { orderBy: { position: "asc" }, select: { pinId: true, link: true, createdAt: true, saves: true, title: true, style: true } } },
    }),
    prisma.kwVolume.findMany({ where: { keywordId: id }, orderBy: { takenAt: "desc" }, take: 30, select: { takenAt: true, estimate: true, none: true } }),
    prisma.kwAccount.findMany({ select: { id: true, name: true } }),
  ]);
  const vol = k.volNone ? 0 : k.volume;
  const history: SnapSummary[] = snaps
    .filter((s) => (s.agg as SerpAgg)?.n)
    .map((s) => (s.summary as SnapSummary | null) ?? snapSummary(s.agg as SerpAgg, s.pins, vol, s.takenAt, s.account?.name ?? null));
  // Авторы топ-10 последнего снимка: по пинам (логин, тип сохранения) + профили из кэша KwPinner;
  // у снимков ручного сбора логинов нет — тогда профили по порядку из agg.ul.
  const last = snaps.find((s) => (s.agg as SerpAgg)?.n);
  const lastPins = last ? await prisma.kwPin.findMany({ where: { snapshot: { keywordId: id, takenAt: last.takenAt } }, orderBy: { position: "asc" }, select: { position: true, pinner: true, saveType: true, link: true, domain: true, saves: true, createdAt: true, title: true } }) : [];
  const names = [...new Set(lastPins.map((p) => p.pinner).filter((x): x is string => !!x))];
  const profiles = names.length ? await prisma.kwPinner.findMany({ where: { username: { in: names } } }) : [];
  const prof = new Map(profiles.map((p) => [p.username, p]));
  const authors = lastPins.map((p) => {
    const u = p.pinner ? prof.get(p.pinner) : undefined;
    return {
      position: p.position, username: p.pinner, saveType: p.saveType, domain: p.domain, saves: p.saves, createdAt: p.createdAt, title: p.title,
      followers: u?.followers ?? null, views: u?.views ?? null, reach: u?.reach ?? null, pins: u?.pins ?? null, boards: u?.boards ?? null,
      business: u ? u.business : null, domainVerified: u ? u.domainVerified : null, merchant: u ? u.merchant : null, site: u?.domain ?? null,
    };
  });
  const ul = ((last?.agg as SerpAgg | undefined)?.ul ?? []).map(([views, reach, followers, pins, boards, biz, dv, mer]) => ({ views, reach, followers, pins, boards, business: !!biz, domainVerified: !!dv, merchant: !!mer }));
  const { metrics, ...row } = k;
  return NextResponse.json({
    authors: authors.some((a) => a.username) ? authors : null, ul,
    keyword: { ...row, account: accounts.find((a) => a.id === k.serpAccountId)?.name ?? null },
    metrics, history,
    volumes: volumes.map((v) => ({ takenAt: v.takenAt, value: v.none ? 0 : v.estimate })),
  });
}
