import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { todayAllZip } from "@/lib/pins/export/service";

export const dynamic = "force-dynamic";

/** GET /api/pins/export/today → ZIP: файлы на сегодня по всем доступным сайтам (по одному CSV на сайт). */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const r = await todayAllZip(me);
  if (!r) return NextResponse.json({ error: "На сегодня готовых пинов нет ни у одного сайта" }, { status: 404 });
  return new NextResponse(new Uint8Array(r.zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${r.fileName}"; filename*=UTF-8''${encodeURIComponent(r.fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}
