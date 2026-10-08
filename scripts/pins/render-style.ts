/**
 * Отладочный рендер Canvas-стилей каталога на тестовых фото.
 *   PINS_STORAGE_DIR=/root/zewex-check/storage npx tsx scripts/pins/render-style.ts <outDir> [styleId|all|pending|approved] [--seeds=3] [--accent=nails]
 * Пишет <outDir>/<style>_<count>_<seed>.jpg. БД — из DATABASE_URL (.env приложения).
 */
import { setDefaultResultOrder } from "dns";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/db";
import { installNodeCanvasHost } from "@/lib/pins/canvas/host.node";
import { renderPin } from "@/lib/pins/canvas";
import { toRecipe, type StyleSpec } from "@/lib/pins/canvas/styleSpec";
import { CATALOG_LIB } from "@/lib/pins/canvas/catalog";
import { testPhotos } from "@/lib/pins/canvas/photos";
import { attachBoldPalettes } from "@/lib/pins/canvas/paletteLibrary";
import { CURATED_STYLES } from "@/lib/pins/canvas/curated";

setDefaultResultOrder("ipv4first");

async function main() {
  const [outDir = "/tmp/pins-render", which = "pending"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flag = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const seeds = Number(flag("seeds") ?? 2);
  const accent = flag("accent");
  const counts = (flag("counts") ?? "1,2,4").split(",").map(Number);
  installNodeCanvasHost(process.env.PINS_FONTS_DIR || "/var/www/zewex_tools_usr/data/storage/pins/fonts");
  await mkdir(outDir, { recursive: true });
  const where = which === "all" ? {} : which === "pending" ? { isActive: true, isApproved: false } : which === "approved" ? { isApproved: true } : { id: { contains: which } };
  const rows: Array<{ id: string; data: unknown }> = which === "curated"
    ? CURATED_STYLES.map((c) => ({ id: c.id, data: c.spec }))
    : await prisma.pinCanvasStyle.findMany({ where: { libraryId: CATALOG_LIB, ...where }, orderBy: { sortOrder: "asc" } });
  console.log(`styles: ${rows.length}`);
  const photos = await testPhotos();
  for (const row of rows) {
    const spec = flag("upgrade") ? attachBoldPalettes(row.data as unknown as StyleSpec, row.id) : row.data as unknown as StyleSpec;
    const safe = row.id.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
    for (const count of counts) {
      const n = spec.counts.includes(count as 1) ? count : spec.counts.filter((c) => c <= count).pop() ?? spec.counts[0];
      for (let s = 0; s < seeds; s++) {
        const seed = 7 + s * 101;
        try {
          const recipe = { ...toRecipe(spec, seed, n), ...(accent ? { accent } : {}) };
          const start = (s * 2) % photos.length;
          const pick = [...photos.slice(start), ...photos.slice(0, start)].slice(0, n);
          const r = await renderPin({ recipe, photos: pick, texts: { title: "Cozy Fall Living Room Ideas", kicker: "Inspiration", cta: "See all ideas", domain: "example.com", number: n >= 2 ? "12" : undefined }, seed });
          await writeFile(join(outDir, `${safe}__${n}_${s}.jpg`), r.jpeg);
          if (r.issues.length) console.log(`${row.id} x${n} s${s}: ${r.issues.join("; ")}`);
        } catch (e) {
          console.log(`FAIL ${row.id} x${n} s${s}:`, (e as Error).message);
        }
      }
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
