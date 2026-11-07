import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listCategories, requireSite } from "@/lib/deepl/wp";

export const dynamic = "force-dynamic";

/** GET /api/deepl/categories?site= → рубрики WordPress (по числу записей). */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  try {
    const creds = await requireSite(me, new URL(req.url).searchParams.get("site") ?? "");
    return NextResponse.json({ categories: await listCategories(creds) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
