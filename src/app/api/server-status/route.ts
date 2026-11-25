import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { serverStatus } from "@/lib/serverStatus";

export const dynamic = "force-dynamic";

/** Диск, процессор и память сервера для плашки в шапке. Видят все вошедшие: цифры не секретные, помогают понять, почему всё медленно. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  try {
    return NextResponse.json(await serverStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
