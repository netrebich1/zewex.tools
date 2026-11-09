import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runEstimate } from "@/lib/pins/runs/estimate";
import { prisma } from "@/lib/db";
import { canAccessPinSite } from "@/lib/sites/access";

export const dynamic = "force-dynamic";

/** Примерная стоимость прогона до запуска: ?site=&pages=&ai=&photos=&canvas=&pinora= — ключи по команде сайта. */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const num = (k: string, max = 20) => Math.min(max, Math.max(0, Math.floor(Number(q.get(k)) || 0)));
  try {
    const siteId = q.get("site") ?? "";
    const site = siteId ? await prisma.pinSite.findUnique({ where: { id: siteId }, select: { teamId: true, wpConnectionId: true } }) : null;
    const teamId = site && (await canAccessPinSite(me, site)) ? site.teamId : null;
    const r = await runEstimate(me, { pages: num("pages", 3000), mix: { ai: num("ai"), photos: num("photos"), canvas: num("canvas"), pinora: num("pinora") }, teamId });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
