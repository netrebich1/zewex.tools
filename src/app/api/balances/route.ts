import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { providerBalances } from "@/lib/balances";

export const dynamic = "force-dynamic";

/** Балансы OpenRouter / laozhang / OpenAI для меню — только администраторам. ?refresh=1 сбрасывает кэш. */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  if (me.role !== "ADMIN") return NextResponse.json({ error: "Только для администраторов" }, { status: 403 });
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const rows = await providerBalances(force);
  return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
}
