import { readFile } from "node:fs/promises";
import { absPath } from "@/lib/pins/storage";
import { uploaderUser } from "@/lib/uploader/access";
import { agentLatestVersion, agentZipExists, agentZipRel } from "@/lib/uploader/release";

export const dynamic = "force-dynamic";

/** GET /api/uploader/agent → ZIP последней сборки агента «Zewex Uploader» (для сотрудника, вход по сессии). */
export async function GET() {
  const me = await uploaderUser();
  if (!me) return new Response("Нет доступа", { status: 401 });
  const v = await agentLatestVersion();
  if (!(await agentZipExists(v))) return new Response("Сборка агента ещё не загружена. Попросите администратора загрузить её на странице «Агенты».", { status: 404 });
  const data = await readFile(absPath(agentZipRel(v)));
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="zewex-uploader-${v}.zip"`, "Cache-Control": "no-store" },
  });
}
