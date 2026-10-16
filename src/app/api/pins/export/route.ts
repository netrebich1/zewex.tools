import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { dayCsv } from "@/lib/pins/export/service";

export const dynamic = "force-dynamic";

/** GET /api/pins/export?site=<id>&day=YYYY-MM-DD → CSV-файл Pinterest на день. */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const u = new URL(req.url);
  const site = u.searchParams.get("site") || "";
  const day = u.searchParams.get("day") || "";
  if (!site || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NextResponse.json({ error: "Укажите site и day" }, { status: 400 });
  const r = await dayCsv(me, site, day);
  if (!r) return NextResponse.json({ error: "На этот день нет готовых пинов" }, { status: 404 });
  return new NextResponse(r.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${r.fileName}"; filename*=UTF-8''${encodeURIComponent(r.fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}
