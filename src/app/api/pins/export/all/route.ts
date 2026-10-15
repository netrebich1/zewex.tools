import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { siteAllZip } from "@/lib/pins/export/service";

export const dynamic = "force-dynamic";

/** GET /api/pins/export/all?site=<id> → ZIP со всеми CSV сайта: по файлу на каждый день с сегодняшнего. */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const site = new URL(req.url).searchParams.get("site") || "";
  if (!site) return NextResponse.json({ error: "Укажите site" }, { status: 400 });
  const r = await siteAllZip(me, site);
  if (!r) return NextResponse.json({ error: "У сайта нет готовых пинов с датами на сегодня и позже" }, { status: 404 });
  return new NextResponse(new Uint8Array(r.zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${r.fileName}"; filename*=UTF-8''${encodeURIComponent(r.fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}
