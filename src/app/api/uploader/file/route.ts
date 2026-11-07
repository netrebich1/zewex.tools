import { prisma } from "@/lib/db";
import { authAgent, UploaderError } from "@/lib/uploader/agent";
import { buildTaskCsv } from "@/lib/uploader/csv";

export const dynamic = "force-dynamic";

/** GET /api/uploader/file?task=… → CSV файла дня для задания агента (вход по токену агента). */
export async function GET(req: Request) {
  try {
    const ctx = await authAgent(req);
    const id = new URL(req.url).searchParams.get("task") ?? "";
    const t = await prisma.uplTask.findUnique({ where: { id }, include: { run: { select: { agentId: true } } } });
    if (!t || t.run.agentId !== ctx.agent.id) return new Response("Задание не найдено", { status: 404 });
    if (t.status !== "LEASED") return new Response("Задание не в работе", { status: 409 });
    const f = await buildTaskCsv(t.pinSiteId, t.day);
    if (!f) return new Response("Файл пуст", { status: 404 });
    await prisma.uplTask.update({ where: { id: t.id }, data: { fileName: f.fileName, rows: f.count } });
    return new Response(f.csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${f.fileName}"`, "X-File-Name": f.fileName, "X-Rows": String(f.count), "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (e instanceof UploaderError) return new Response(e.message, { status: e.status });
    return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}
