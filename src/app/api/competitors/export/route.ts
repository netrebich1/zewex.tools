import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canSee, exportSheets, loadState, parseFilter } from "@/lib/competitors/sites";
import { themeRows } from "@/lib/competitors/themes";
import { buildXlsx, type Sheet } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

/** GET /api/competitors/export?country=&days=&deals=&status=&sort=&q= → XLSX: площадки, темы, кластеры, ключи по текущему фильтру. */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  if (!(await canSee(me))) return NextResponse.json({ error: "Нет доступа" }, { status: 403 });
  const url = new URL(req.url);
  const { settings } = await loadState();
  const filter = parseFilter((k) => url.searchParams.get(k) ?? undefined, settings);
  const [sheets, themes] = await Promise.all([exportSheets(filter), themeRows(filter)]);
  const themeSheet: Sheet = {
    name: "Темы",
    widths: [36, 11, 14, 16, 11, 70, 70],
    rows: [
      ["Тема", "Площадок", "Оценка трафика всего", "Типичная площадка (медиана)", "Запросов", "Площадки (трафик на теме)", "Примеры запросов"],
      ...themes.rows.map((r) => [r.theme, r.sites, r.etv, r.medianEtv, r.keywords, r.topSites.map((s) => `${s.domain} (${s.etv})`).join(", ") + (r.sites > r.topSites.length ? ` и ещё ${r.sites - r.topSites.length}` : ""), r.examples.join(", ")]),
    ],
  };
  const data = buildXlsx([sheets[0], themeSheet, ...sheets.slice(1)]);
  const name = `competitors_${filter.days}d_${new Date().toISOString().slice(0, 10)}.xlsx`;
  return new NextResponse(new Uint8Array(data), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
}
