import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runEstimate } from "@/lib/pins/runs/estimate";

export const dynamic = "force-dynamic";

/** Примерная стоимость прогона до запуска: ?pages=&ai=&photos=&canvas=&pinora= */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const num = (k: string, max = 20) => Math.min(max, Math.max(0, Math.floor(Number(q.get(k)) || 0)));
  try {
    const r = await runEstimate(me, { pages: num("pages", 3000), mix: { ai: num("ai"), photos: num("photos"), canvas: num("canvas"), pinora: num("pinora") } });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
