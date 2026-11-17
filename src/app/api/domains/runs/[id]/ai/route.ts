import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { aiSelectBrands } from "@/lib/domains/runs";
import { hit, tooMany } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST /api/domains/runs/:id/ai { brands?: string[], balanceZones, balanceSuffixes, take? } → ИИ-отбор по брендам. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const { id } = await ctx.params;
  let body: { brands?: string[]; balanceZones?: boolean; balanceSuffixes?: boolean; take?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса должно быть JSON" }, { status: 400 });
  }
  const retry = hit(`domains-ai:${me.id}`, 60, 600);
  if (retry) return NextResponse.json({ error: tooMany(retry) }, { status: 429 });
  try {
    const results = await aiSelectBrands(me, id, Array.isArray(body.brands) ? body.brands.map(String) : [], {
      balanceZones: Boolean(body.balanceZones),
      balanceSuffixes: Boolean(body.balanceSuffixes),
      take: typeof body.take === "number" ? body.take : undefined,
    });
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
