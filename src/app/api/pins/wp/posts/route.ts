import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { sitePosts } from "@/lib/pins/wp/posts";

export const dynamic = "force-dynamic";

/** Статьи сайта по REST API WordPress с флагом «уже использовалась». */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const siteId = q.get("site") ?? "";
  const categories = (q.get("categories") ?? "").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
  try {
    const r = await sitePosts(me, siteId, {
      categories: categories.length ? categories : undefined,
      after: q.get("after") || undefined,
      before: q.get("before") || undefined,
      search: q.get("search") || undefined,
      limit: Number.isFinite(Number(q.get("limit"))) && Number(q.get("limit")) > 0 ? Number(q.get("limit")) : 100,
      postType: q.get("type") === "pages" ? "pages" : "posts",
    });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
