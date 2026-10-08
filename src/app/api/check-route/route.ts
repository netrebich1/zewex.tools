import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { resolveBinding } from "@/lib/resolve";

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const url = new URL(req.url);
  const slotId = url.searchParams.get("slotId") ?? "";
  let userId = url.searchParams.get("userId") ?? me.id;
  if (me.role !== "ADMIN") userId = me.id;
  if (!slotId) return NextResponse.json({ error: "slotId обязателен" }, { status: 400 });
  try {
    const r = await resolveBinding(userId, slotId);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
