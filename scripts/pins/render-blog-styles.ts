/**
 * Рендер блоговых Canvas-стилей (zxb:*) прямо из кода, с текстами по типу статьи — проверка библиотеки
 * без базы. Тестовые фото — как у превью каталога.
 *   PINS_STORAGE_DIR=/root/zewex-check/storage npx tsx scripts/pins/render-blog-styles.ts <outDir> [--seeds=1]
 * Пишет <outDir>/<style>__<kind>_<фото>_<seed>.jpg; проблемы проверки стиля и раскладки — в консоль.
 */
import { setDefaultResultOrder } from "dns";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { installNodeCanvasHost } from "@/lib/pins/canvas/host.node";
import { renderPin } from "@/lib/pins/canvas";
import { toRecipe, validateStyle } from "@/lib/pins/canvas/styleSpec";
import { testPhotos } from "@/lib/pins/canvas/photos";
import { CURATED_STYLES } from "@/lib/pins/canvas/curated";
import { ARTICLE_KINDS, kindKicker, type ArticleKind } from "@/lib/pins/articleKind";

setDefaultResultOrder("ipv4first");

const SAMPLE: Record<ArticleKind, { title: string; number?: string }> = {
  how_to: { title: "How to Curl Hair with a Flat Iron", number: "7" },
  tips: { title: "Clear Skin Tips That Actually Work", number: "24" },
  checklist: { title: "Whole House Cleaning Checklist", number: "30" },
  fix: { title: "How to Get Rid of Dandruff Fast" },
  explain: { title: "Why Does My Hair Get Greasy So Fast?" },
  compare: { title: "Best Hair Dryer for Fine Hair" },
  recipe: { title: "Easy Homemade Granola Recipe" },
  plan: { title: "Keto Meal Plan for Beginners", number: "7" },
};

async function main() {
  const [outDir = "/tmp/blog-styles"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const seeds = Number(process.argv.find((a) => a.startsWith("--seeds="))?.split("=")[1] ?? 1);
  installNodeCanvasHost(process.env.PINS_FONTS_DIR || "/var/www/zewex_tools_usr/data/storage/pins/fonts");
  await mkdir(outDir, { recursive: true });
  const photos = await testPhotos();
  const styles = CURATED_STYLES.filter((c) => c.spec.tags.includes("blog"));
  console.log(`blog styles: ${styles.length}`);
  for (const c of styles) {
    const problems = validateStyle(c.spec);
    if (problems.length) console.log(`INVALID ${c.id}: ${problems.join("; ")}`);
    const kinds = c.spec.tags.filter((t) => t.startsWith("k:")).map((t) => t.slice(2)).filter((k): k is ArticleKind => (ARTICLE_KINDS as readonly string[]).includes(k));
    const kind = kinds[0] ?? "how_to";
    const sample = SAMPLE[kind];
    for (const n of c.spec.counts.slice(0, 2)) {
      for (let s = 0; s < seeds; s++) {
        const seed = 7 + s * 101;
        try {
          const recipe = toRecipe(c.spec, seed, n);
          const start = (s * 2 + n) % photos.length;
          const pick = [...photos.slice(start), ...photos.slice(0, start)].slice(0, n);
          const r = await renderPin({ recipe, photos: pick, texts: { title: sample.title, kicker: kindKicker(kind, "en"), cta: "Read the guide", domain: "lyntrico.com", number: c.spec.number ? sample.number ?? "5" : undefined }, seed });
          await writeFile(join(outDir, `${c.id.replace(/[^a-z0-9_-]/gi, "_")}__${kind}_${n}_${s}.jpg`), r.jpeg);
          if (r.issues.length) console.log(`${c.id} x${n} s${s}: ${r.issues.join("; ")}`);
        } catch (e) {
          console.log(`FAIL ${c.id} x${n} s${s}: ${(e as Error).message}`);
        }
      }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
