import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listPosts, requireSite } from "@/lib/deepl/wp";

export const dynamic = "force-dynamic";

/** GET /api/deepl/posts?site=&status=&after=&before=&categories=1,2&search=&limit= → посты сайта по статусу и дате. */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  try {
    const creds = await requireSite(me, q.get("site") ?? "");
    const categories = (q.get("categories") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const r = await listPosts(creds, {
      status: q.get("status") || "draft",
      after: q.get("after") || undefined,
      before: q.get("before") || undefined,
      categories,
      search: q.get("search") || undefined,
      limit: Number(q.get("limit")) || 500,
    });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
