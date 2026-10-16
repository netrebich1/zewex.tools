import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { parseSettings, requireRun, runDomains } from "@/lib/domains/runs";
import { buildRunCsv, buildRunXlsx, fileBase, type ExportScope } from "@/lib/domains/export";

export const dynamic = "force-dynamic";

/** GET /api/domains/runs/:id/export?format=xlsx|csv&scope=selected|available|all → файл выгрузки. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const { id } = await ctx.params;
  const u = new URL(req.url);
  const format = u.searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const scopeRaw = u.searchParams.get("scope");
  const scope: ExportScope = scopeRaw === "available" || scopeRaw === "all" ? scopeRaw : "selected";
  try {
    const run = await requireRun(me, id);
    const rows = await runDomains(id);
    const base = fileBase(run.name);
    if (format === "csv") {
      const csv = buildRunCsv(rows, scope);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${base}.csv"; filename*=UTF-8''${encodeURIComponent(base + ".csv")}`,
          "Cache-Control": "no-store",
        },
      });
    }
    const buf = buildRunXlsx({ name: run.name, settings: parseSettings(run.settings) }, rows, scope);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${base}.xlsx"; filename*=UTF-8''${encodeURIComponent(base + ".xlsx")}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
