import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { articlesInWork, workerState } from "@/lib/articles/queries";

export const dynamic = "force-dynamic";

/** Статьи в работе и в очереди (видимость — как у страниц) + состояние воркера; для живой доски на «Обзоре». */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const [rows, worker] = await Promise.all([articlesInWork(me), workerState(me)]);
  return NextResponse.json({ rows, worker }, { headers: { "Cache-Control": "no-store" } });
}
