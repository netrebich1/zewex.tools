import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { failedCsv, failedXlsx, listFailedKeywords, parseFailedFilters, visibleArtSites } from "@/lib/articles/failedKeywordsView";

export const dynamic = "force-dynamic";

/**
 * GET /api/articles/failed-keywords/export?format=xlsx|csv&site=&reason=&recipe=&days=&min=&q=&ignored=&sort=&dir=
 * → выгрузка списка «Неудачные ключи» с теми же фильтрами, что на странице (все строки, без ограничения).
 */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const u = new URL(req.url);
  const f = parseFailedFilters(u.searchParams);
  const sites = await visibleArtSites(me);
  const { rows } = await listFailedKeywords(f, sites.map((s) => s.id));
  const origin = "https://zewex.tools";
  const date = new Date().toISOString().slice(0, 10);
  const base = `neudachnye-klyuchi_${date}`;
  if (u.searchParams.get("format") === "csv") {
    return new NextResponse(failedCsv(rows, sites, origin), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.csv"; filename*=UTF-8''${encodeURIComponent(`Неудачные ключи ${date}.csv`)}`,
        "Cache-Control": "no-store",
      },
    });
  }
  const buf = failedXlsx(rows, sites, origin);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${base}.xlsx"; filename*=UTF-8''${encodeURIComponent(`Неудачные ключи ${date}.xlsx`)}`,
      "Cache-Control": "no-store",
    },
  });
}
