import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canSee, exportSheets, loadState, parseFilter } from "@/lib/competitors/sites";
import { buildXlsx } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

/** GET /api/competitors/export?country=&days=&deals=&status=&sort=&q= → XLSX: площадки, кластеры, ключи по текущему фильтру. */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  if (!(await canSee(me))) return NextResponse.json({ error: "Нет доступа" }, { status: 403 });
  const url = new URL(req.url);
  const { settings } = await loadState();
  const filter = parseFilter((k) => url.searchParams.get(k) ?? undefined, settings);
  const sheets = await exportSheets(filter);
  const data = buildXlsx(sheets);
  const name = `competitors_${filter.days}d_${new Date().toISOString().slice(0, 10)}.xlsx`;
  return new NextResponse(new Uint8Array(data), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
}
