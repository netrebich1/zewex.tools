import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTENSION_DIR, extensionVersion } from "@/lib/keywords/extension";
import { keywordsUser } from "@/lib/keywords/access";
import { zip } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

const DIR = EXTENSION_DIR;

/** GET /api/keywords/extension → ZIP с папкой расширения «Zewex Collector» (для «Загрузить распакованное» на Mac и Windows). */
export async function GET() {
  const me = await keywordsUser();
  if (!me) return new Response("Нет доступа", { status: 401 });
  const names = (await readdir(DIR, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
  const files = await Promise.all(names.map(async (n) => ({ name: `zewex-collector/${n}`, data: await readFile(join(DIR, n)) })));
  return new Response(new Uint8Array(zip(files)), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="zewex-collector-${await extensionVersion()}.zip"`, "Cache-Control": "no-store" },
  });
}
