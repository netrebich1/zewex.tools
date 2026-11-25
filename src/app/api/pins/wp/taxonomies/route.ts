import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { siteTaxonomies } from "@/lib/pins/wp/posts";

export const dynamic = "force-dynamic";

/** Категории и метки WordPress сайта (для фильтра статей на странице «Новый прогон»). */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const siteId = new URL(req.url).searchParams.get("site") ?? "";
  try {
    return NextResponse.json(await siteTaxonomies(me, siteId), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
