import { NextResponse } from "next/server";
import { runFor, uploaderUser } from "@/lib/uploader/access";
import { runView } from "@/lib/uploader/views";

export const dynamic = "force-dynamic";

/** GET /api/uploader/runs/:id → состояние запуска и задания (живая страница опрашивает каждые 5 с). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await uploaderUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await runFor(me, id))) return NextResponse.json({ error: "Запуск не найден" }, { status: 404 });
  const view = await runView(id);
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
