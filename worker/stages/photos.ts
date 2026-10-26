import { prisma } from "@/lib/db";
import { extractArticleImages, frequentImages, isLikelyAuthorPhoto, type ArticleImage } from "@/lib/pins/stages/photos";
import { planPhotos } from "@/lib/pins/plan/photoPlan";
import { hash32 } from "@/lib/pins/plan/seed";
import { decryptSecret } from "@/lib/crypto";
import { featuredImageByUrl, type WpCreds } from "@/lib/pins/wp/client";
import { featuredOnlyFor } from "@/lib/pins/types";
import { articleKindsFor } from "@/lib/pins/articleKind";
import type { StageHandler } from "./index";
import { loadRunCtx, runQueue } from "./_shared";

/**
 * Этап photos: фото статей. Часть публикуется (status READY), остальное — пул для Canvas (POOL).
 * Берётся только первое фото каждой H2-секции (как в старом автопилоте: дальше обычно коллажи и дубли);
 * фото автора и фото, встречающиеся на многих страницах сайта, отбрасываются.
 */
export const photos: StageHandler = async (ctx) => {
  const rc = await loadRunCtx(ctx);
  const perPage = rc.recipe.mix.photos;
  const wantPool = rc.recipe.mix.canvas > 0;
  const todo = rc.pages.filter((p) => !p.photosAt && p.keyword);
  await ctx.tick({ done: 0, total: todo.length, label: "Фото из статей" });
  if (!todo.length) return { summary: "фото уже собраны" };
  if (perPage <= 0 && !wantPool) {
    await prisma.pinRunPage.updateMany({ where: { id: { in: todo.map((p) => p.id) } }, data: { photosAt: new Date() } });
    return { summary: "фото выключены в рецепте" };
  }

  // Доступ WordPress сайта — чтобы брать миниатюру записи прямо из WordPress (REST API), а не угадывать по странице.
  const connId = rc.site.wpConnectionId || rc.recipe.publishing.wpConnectionId;
  const conn = connId ? await prisma.siteAccess.findUnique({ where: { id: connId } }) : null;
  let creds: WpCreds | null = null;
  if (conn?.username && conn.appPasswordEnc) {
    try { creds = { baseUrl: conn.baseUrl, username: conn.username, appPassword: decryptSecret(conn.appPasswordEnc) }; } catch { creds = null; }
  }

  // Блоговые статьи (lib/pins/articleKind.ts): все фото тела статьи, а не только первое фото каждого H2,
  // и без режима «только миниатюра» (рецепт из нашего блога тоже отдаёт все свои фото).
  const kinds = await articleKindsFor(rc.site.wpConnectionId, todo);
  const isBlogPage = (id: string) => !!kinds.get(id)?.kind;
  let blogPages = 0;
  const found = new Map<string, ArticleImage[]>();
  const featuredPages = new Set<string>();
  let done = 0;
  let failed = 0;
  let fromWp = 0;
  await runQueue(todo, 4, async (p) => {
    try {
      const url = p.finalUrl || p.url;
      const blog = isBlogPage(p.id) && rc.recipe.photosMode !== "featured_only";
      if (blog) blogPages++;
      const featuredOnly = !blog && featuredOnlyFor(rc.recipe.photosMode, p.niche, rc.site.niche);
      const r = await extractArticleImages(url, { featuredOnly, signal: ctx.signal, all: blog });
      const imgs = r.images.filter((i) => (blog || i.indexInSection === 0) && !isLikelyAuthorPhoto(i.url));
      if (featuredOnly) {
        // Миниатюра: сначала из WordPress (featured image записи), затем og:image страницы, затем первое фото статьи.
        let featured = "";
        if (creds) {
          try { featured = (await featuredImageByUrl(creds, url, { signal: ctx.signal, timeoutMs: 25_000, maxRetries: 1 })) ?? ""; if (featured) fromWp++; }
          catch (e) { ctx.log(`featured via WP failed ${url}: ${(e as Error).message}`); }
        }
        featured = featured || r.featured || p.featuredImage || r.images[0]?.url || "";
        featuredPages.add(p.id);
        found.set(p.id, featured ? [{ url: featured, alt: "", section: "", indexInSection: 0 }] : []);
      } else found.set(p.id, imgs);
      if (r.error) ctx.log(`photos ${p.url}: ${r.error}`);
    } catch (e) {
      failed++;
      found.set(p.id, []);
      ctx.log(`photos failed ${p.url}`, e);
    }
    await ctx.tick({ done: ++done, total: todo.length, label: `Фото из статей ${done}/${todo.length}` });
  }, ctx.signal);

  // фото, повторяющиеся на многих страницах (логотипы, баннеры, автор)
  // Миниатюры в подсчёт «частых» не идут: у статей без своей картинки она может совпадать, это не баннер.
  const frequent = frequentImages([...found.entries()].filter(([id]) => !featuredPages.has(id)).map(([, l]) => l.map((i) => i.url)));
  const existing = await prisma.pinRunItem.findMany({ where: { runId: rc.run.id, engine: "PHOTO" }, select: { pageId: true, sourceImageUrl: true } });
  const have = new Set(existing.map((e) => `${e.pageId}|${e.sourceImageUrl}`));

  let created = 0;
  for (const p of todo) {
    const imgs = (found.get(p.id) || []).filter((i) => featuredPages.has(p.id) || !frequent.has(i.url));
    const plan = planPhotos({ images: imgs.map((i) => i.url), perPage, linkPercent: rc.recipe.publishing.photoLinkPercent, seed: hash32(`${rc.settings.seed}|${p.id}|photos`) });
    const rows = plan
      .filter((x) => !have.has(`${p.id}|${x.url}`))
      .filter((x) => x.publish || wantPool)
      .map((x, k) => ({
        runId: rc.run.id,
        pageId: p.id,
        siteId: rc.site.id,
        kind: "photo",
        engine: "PHOTO" as const,
        sourceImageUrl: x.url,
        targetLink: x.withLink ? (p.finalUrl || p.url) : "",
        status: x.publish ? ("READY" as const) : ("POOL" as const),
        sortOrder: 1000 + k,
      }));
    if (rows.length) {
      await prisma.pinRunItem.createMany({ data: rows });
      created += rows.filter((r) => r.status === "READY").length;
    }
    await prisma.pinRunPage.update({ where: { id: p.id }, data: { photosAt: new Date(), imageCount: Math.max(p.imageCount, imgs.length) } });
  }
  return { summary: `фото: ${created} к публикации, страниц без фото: ${failed}${blogPages ? `; блоговых статей (все фото): ${blogPages}` : ""}${featuredPages.size ? `; только миниатюра: ${featuredPages.size} стр. (из WordPress: ${fromWp})` : ""}` };
};
