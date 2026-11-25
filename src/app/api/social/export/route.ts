import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { metricoolHeader, requireRun } from "@/lib/social/runs";
import { buildExport } from "@/lib/social/metricool";
import { networkOf, parseSettings, type NetworkKey, type SocialPosts } from "@/lib/social/types";
import { zip } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

/** GET /api/social/export?run=<id>[&net=<сеть>] → CSV для Metricool (один файл) или ZIP (несколько сетей / больше 50 постов). */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const url = new URL(req.url);
  try {
    const run = await requireRun(me, url.searchParams.get("run") ?? "");
    const settings = parseSettings(run.settings);
    const net = url.searchParams.get("net");
    const only = net && networkOf(net) ? (net as NetworkKey) : undefined;
    const items = await prisma.socialItem.findMany({ where: { runId: run.id, status: "done" }, orderBy: { position: "asc" }, select: { id: true, position: true, posts: true } });
    const { header } = await metricoolHeader();
    const slug = run.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
    const files = buildExport(header, items.map((i) => ({ id: i.id, position: i.position, posts: (i.posts ?? {}) as SocialPosts })), settings, slug, only);
    if (!files.length) return NextResponse.json({ error: "Готовых постов для выгрузки нет" }, { status: 404 });
    if (files.length === 1) {
      return new NextResponse(files[0].data, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${files[0].name}"`, "Cache-Control": "no-store" } });
    }
    const data = zip(files.map((f) => ({ name: f.name, data: f.data })));
    return new NextResponse(new Uint8Array(data), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="metricool_${slug}_${files.length}files.zip"`, "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
