import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canSee, loadGeo } from "@/lib/competitors/sites";
import { sortRows, type GeoRow, type GeoSort } from "@/lib/competitors/geo";
import { buildXlsx, type CellValue, type Sheet } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

const SORTS: GeoSort[] = ["deals", "avg", "share", "sites", "strong"];

function sheet(name: string, first: string, inner: string, rows: GeoRow[], currency: string): Sheet {
  const line = (r: GeoRow): CellValue[] => [
    r.name, r.deals, r.sites, r.withDeals, r.sites ? Math.round((r.withDeals / r.sites) * 100) : null, r.sites ? Math.round((r.deals / r.sites) * 10) / 10 : null, r.d5, r.d20, r.medPrice, r.gscSites, r.clicks,
    r.inner.filter((i) => i.deals > 0).map((i) => `${i.name} ${i.deals}`).join(", "),
    r.cats.filter((i) => i.deals > 0).map((i) => `${i.name} ${i.deals}`).join(", "),
    r.top.map((s) => `${s.domain} (${s.deals >= 5 ? `${s.deals}+` : s.deals})`).join(", "),
  ];
  return {
    name,
    widths: [24, 12, 11, 11, 11, 12, 10, 10, 14, 11, 14, 50, 60, 80],
    rows: [[first, "Заказов, не меньше", "Площадок", "С заказами", "С заказами, %", "Заказов на площадку", "С 5+ заказами", "С 20+ заказами", `Цена статьи, медиана (${currency || "валюта кабинета"})`, "Площадок с GSC", "Клики GSC за месяц", inner, "Ниши по заказам", "Площадки с заказами"], ...rows.map(line)],
  };
}

/** GET /api/competitors/geo-export?scope=31|61|92|all&sort= → XLSX: языки и страны по заказам. */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  if (!(await canSee(me))) return NextResponse.json({ error: "Нет доступа" }, { status: 403 });
  const url = new URL(req.url);
  const scope = ["31", "61", "92", "all"].includes(url.searchParams.get("scope") ?? "") ? (url.searchParams.get("scope") as string) : "92";
  const sort = (SORTS.find((s) => s === url.searchParams.get("sort")) ?? "deals") as GeoSort;
  const geo = await loadGeo();
  const block = scope === "all" ? geo?.all : geo?.windows?.[scope];
  if (!block) return NextResponse.json({ error: "Данных по этому срезу пока нет" }, { status: 404 });
  const sheets = [
    sheet("Языки", "Язык", "Страны по заказам", sortRows(block.languages, sort), block.currency),
    sheet("Страны", "Страна", "Языки по заказам", sortRows(block.countries, sort), block.currency),
    ...(block.home ? [sheet("Для сравнения", "Языки", "Страны по заказам", [block.home], block.currency)] : []),
  ];
  const name = `geo_${scope === "all" ? "all" : `${scope}d`}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  return new NextResponse(new Uint8Array(buildXlsx(sheets)), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
}
