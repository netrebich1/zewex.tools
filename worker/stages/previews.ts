import { prisma } from "@/lib/db";
import { renderPin } from "@/lib/pins/canvas";
import { toRecipe, type StyleSpec } from "@/lib/pins/canvas/styleSpec";
import { CATALOG_LIB, harvestCandidates, seedCuratedStyles, upgradeCatalogSpecs } from "@/lib/pins/canvas/catalog";
import { testPhotos } from "@/lib/pins/canvas/photos";
import { previewRel, writeFileAtomic } from "@/lib/pins/storage";
import { makeThumb } from "@/lib/pins/images";
import type { StageHandler } from "./index";

/**
 * Этап previews: (опционально) собрать кандидатов каталога и отрисовать превью
 * каждого стиля на 1, 2 и 4 фото. Рендер по одному: 2 ядра.
 */
export const previews: StageHandler = async (ctx) => {
  const opts = (ctx.job.options as { harvest?: boolean; force?: boolean } | null) ?? {};
  if (opts.harvest) {
    const h = await harvestCandidates();
    ctx.log(`harvest: groups ${h.groups}, created ${h.created}, skipped ${h.skipped}`);
    const c = await seedCuratedStyles();
    ctx.log(`curated: created ${c.created}${c.invalid.length ? `, invalid: ${c.invalid.join(" | ")}` : ""}`);
    const up = await upgradeCatalogSpecs();
    ctx.log(`specs upgraded: ${up}`);
  }
  const rows = await prisma.pinCanvasStyle.findMany({ where: { libraryId: CATALOG_LIB, isActive: true, ...(opts.force ? {} : { previewPath: null }) }, orderBy: { sortOrder: "asc" } });
  await ctx.tick({ done: 0, total: rows.length, label: "Превью стилей" });
  if (!rows.length) return { summary: "превью готовы" };
  const photos = await testPhotos(ctx.signal);
  let done = 0, failed = 0;
  for (const row of rows) {
    if (ctx.signal.aborted) break;
    const spec = row.data as unknown as StyleSpec;
    const rev = spec.rev ?? 1;
    let firstRel = "";
    for (const count of [1, 2, 4] as const) {
      const n = spec.counts.includes(count) ? count : spec.counts.filter((c) => c <= count).pop() ?? spec.counts[0];
      try {
        const recipe = toRecipe(spec, 7, n);
        const r = await renderPin({ recipe, photos: photos.slice(0, n), texts: { title: "Cozy Fall Living Room Ideas", kicker: "Inspiration", cta: "See all ideas", domain: "example.com", number: n >= 2 ? "12" : undefined }, seed: 7 });
        const rel = previewRel(row.id.replace(/[^a-z0-9_-]/gi, "_"), count, rev);
        await writeFileAtomic(rel, await makeThumb(r.jpeg, 600));
        if (!firstRel) firstRel = rel;
      } catch (e) {
        ctx.log(`preview failed ${row.id} x${count}`, e);
      }
    }
    if (firstRel) await prisma.pinCanvasStyle.update({ where: { id: row.id }, data: { previewPath: firstRel } });
    else failed++;
    done++;
    await ctx.tick({ done, total: rows.length, label: `Превью ${done}/${rows.length}` });
  }
  return { summary: `превью: ${done - failed} ок, ${failed} с ошибкой` };
};
