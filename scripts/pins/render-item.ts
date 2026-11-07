/**
 * Перерисовать существующий Canvas-пин прогона текущим кодом (для сравнения обрезки/раскладки).
 *   PINS_STORAGE_DIR=/root/zewex-check/storage npx tsx scripts/pins/render-item.ts <outDir> <itemId> [itemId…]
 * Берёт стиль, фото, seed и тексты из базы; ничего не записывает в базу.
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { setDefaultResultOrder } from "dns";
import { prisma } from "@/lib/db";
import { installNodeCanvasHost } from "@/lib/pins/canvas/host.node";
import { guessAccent, renderPin } from "@/lib/pins/canvas";
import { toRecipe } from "@/lib/pins/canvas/styleSpec";
import { approvedStylesForSite } from "@/lib/pins/canvas/catalog";
import { cachedPhoto } from "@/lib/pins/canvas/photos";
import { subjectBoxFor } from "@/lib/pins/canvas/subject";
import { hash32 } from "@/lib/pins/plan/seed";
import { mergeRecipe } from "@/lib/pins/types";

setDefaultResultOrder("ipv4first");

async function main() {
  const [outDir = "/tmp/render-item", ...ids] = process.argv.slice(2);
  if (!ids.length) throw new Error("укажите id пинов");
  installNodeCanvasHost(process.env.PINS_FONTS_DIR || "/var/www/zewex_tools_usr/data/storage/pins/fonts");
  await mkdir(outDir, { recursive: true });
  for (const id of ids) {
    const it = await prisma.pinRunItem.findUnique({ where: { id }, include: { page: true, run: { include: { site: true } } } });
    if (!it || !it.run.site || !it.styleId) { console.log(`skip ${id}`); continue; }
    const settings = it.run.settings as { seed?: number };
    const recipeRun = mergeRecipe(it.run.settings);
    const params = (it.styleParams ?? {}) as { photos?: string[]; hook?: { title?: string; kicker?: string; cta?: string }; ideaCount?: number; tags?: { cta?: boolean; siteName?: boolean } };
    const styles = await approvedStylesForSite(it.run.site.id, [], [it.styleId]);
    const style = styles.find((s) => s.id === it.styleId) ?? styles[0];
    if (!style) { console.log(`no style ${it.styleId}`); continue; }
    const sortOrder = it.sortOrder - 2000;
    const seed = hash32(`${settings.seed ?? 0}|${it.page.id}|${it.styleId}|${sortOrder}`);
    const photos: Buffer[] = [];
    const urls: string[] = [];
    for (const u of params.photos ?? []) { try { photos.push(await cachedPhoto(u)); urls.push(u); } catch { /* битое */ } }
    const accent = guessAccent(it.page.niche || it.run.site.niche, it.page.keyword, it.page.topic, it.page.pageTitle);
    const ai = { userId: it.run.createdById ?? "", teamId: it.run.teamId, runId: it.run.id, siteId: it.run.site.id };
    const subjects = process.env.NO_SUBJECT ? [] : await Promise.all(urls.map((u, i) => subjectBoxFor(ai, u, photos[i], accent, (m) => console.log(m))));
    console.log("subjects:", JSON.stringify(subjects));
    const recipe = { ...toRecipe(style.spec, seed, photos.length), accent };
    const hook = params.hook ?? { title: it.page.keyword };
    const r = await renderPin({ recipe, photos, subjects, texts: { title: hook.title ?? it.page.keyword, kicker: hook.kicker, cta: params.tags?.cta ? hook.cta : undefined, domain: params.tags?.siteName ? recipeRun.text.siteName || "site.com" : undefined, number: params.ideaCount && params.ideaCount >= 3 ? String(params.ideaCount) : undefined }, seed });
    await writeFile(join(outDir, `${id}.jpg`), r.jpeg);
    console.log(`${id}: ${it.styleId} accent=${accent} photos=${photos.length} issues=${r.issues.join("; ") || "-"}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
