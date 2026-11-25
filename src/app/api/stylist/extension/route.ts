import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentUser } from "@/lib/auth";
import { EXT_DIR, extVersion } from "@/lib/stylist/ext";
import { canSee } from "@/lib/stylist/queries";
import { zip } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

/** GET /api/stylist/extension → ZIP с папкой расширения «Zewex Стилист» (для «Загрузить распакованное» в Chrome). */
export async function GET() {
  const me = await getCurrentUser();
  if (!me || !(await canSee(me))) return new Response("Нет доступа", { status: 401 });
  const names = (await readdir(EXT_DIR, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
  const files = await Promise.all(names.map(async (n) => ({ name: `zewex-stylist/${n}`, data: await readFile(join(EXT_DIR, n)) })));
  return new Response(new Uint8Array(zip(files)), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="zewex-stylist-${await extVersion()}.zip"`, "Cache-Control": "no-store" },
  });
}
