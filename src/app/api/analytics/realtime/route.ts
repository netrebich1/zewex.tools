import { prisma } from "@/lib/db";
import { analyticsUser, propertyWhere } from "@/lib/analytics/access";
import { realtimeActiveUsers } from "@/lib/analytics/google";

export const dynamic = "force-dynamic";

/** GET /api/analytics/realtime?ids=a,b,c → { [id]: активных за 30 минут }. Кэш минута на сайт. */
export async function GET(req: Request) {
  const me = await analyticsUser();
  if (!me) return new Response("Нет доступа", { status: 401 });
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 60);
  if (!ids.length) return Response.json({});
  const props = await prisma.gaProperty.findMany({ where: { id: { in: ids }, enabled: true, ...propertyWhere(me) }, include: { account: true } });
  const out: Record<string, number | null> = {};
  await Promise.all(props.map(async (p) => {
    out[p.id] = p.account.status === "OK" ? await realtimeActiveUsers(p.account, p.propertyId).catch(() => null) : null;
  }));
  return Response.json(out);
}
