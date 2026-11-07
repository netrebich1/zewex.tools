import { prisma } from "@/lib/db";
import { runFor, uploaderUser } from "@/lib/uploader/access";
import { buildTaskCsv } from "@/lib/uploader/csv";

export const dynamic = "force-dynamic";

/** GET /api/uploader/runs/:id/file?task=… → тот же CSV, что получил бы агент, — для ручной заливки, когда автозаливка не прошла. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await uploaderUser();
  if (!me) return new Response("Не авторизован", { status: 401 });
  const { id } = await ctx.params;
  if (!(await runFor(me, id))) return new Response("Запуск не найден", { status: 404 });
  const taskId = new URL(req.url).searchParams.get("task") ?? "";
  const t = await prisma.uplTask.findUnique({ where: { id: taskId }, select: { runId: true, pinSiteId: true, day: true } });
  if (!t || t.runId !== id) return new Response("Задание не найдено", { status: 404 });
  const f = await buildTaskCsv(t.pinSiteId, t.day);
  if (!f) return new Response("Файл на этот день пуст", { status: 404 });
  return new Response(f.csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${f.fileName}"`, "Cache-Control": "no-store" },
  });
}
