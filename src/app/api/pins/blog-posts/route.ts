import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canAccessPinSite } from "@/lib/sites/access";
import { mergeRecipe } from "@/lib/pins/types";
import { normUrl } from "@/lib/pins/articleKind";

export const dynamic = "force-dynamic";

/**
 * Статьи нашего сервиса Pin Blog Article для сайта пинов (тот же доступ WordPress), опубликованные и ещё без пинов:
 * адрес статьи не встречался в прогонах этого сайта (PinUrlHistory). Для кнопки в форме нового прогона.
 */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const siteId = new URL(req.url).searchParams.get("site") ?? "";
  const site = await prisma.pinSite.findUnique({ where: { id: siteId } });
  if (!site || !(await canAccessPinSite(me, site))) return NextResponse.json({ error: "Сайт не найден" }, { status: 404 });
  const accessId = site.wpConnectionId || mergeRecipe(site.recipe).publishing.wpConnectionId;
  if (!accessId) return NextResponse.json({ urls: [], total: 0, used: 0 });
  const posts = await prisma.blogPost.findMany({
    where: { site: { accessId }, wpUrl: { not: null }, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    select: { wpUrl: true },
    take: 3000,
  });
  const used = new Set((await prisma.pinUrlHistory.findMany({ where: { siteId }, select: { url: true } })).map((u) => normUrl(u.url)));
  const all = [...new Set(posts.map((p) => p.wpUrl!).filter(Boolean))];
  const fresh = all.filter((u) => !used.has(normUrl(u)));
  return NextResponse.json({ urls: fresh, total: all.length, used: all.length - fresh.length }, { headers: { "Cache-Control": "no-store" } });
}
