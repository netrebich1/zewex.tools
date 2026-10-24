/**
 * Публикация инфо-статьи в WordPress — основной поток этапа `publish` (порт src/lib/articles/wp/publish.ts под Blog*).
 * Порядок: slug → поиск записи по адресу (своя — по метке в тексте) → категория → фото в медиатеку по 2 → подмена ссылок
 * → создание/обновление записи с Yoast-мета, featured = главное фото. Идемпотентно: загруженные фото ищутся по маркеру
 * в имени файла, запись обновляется, а не дублируется. Классы ошибок — общие со статьями.
 */
import { readFile } from "fs/promises";
import { Prisma, type BlogPhoto, type BlogPost, type BlogSite } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { AiCtx } from "@/lib/blog/ai";
import { absPath, publicUrl, toWpJpeg } from "@/lib/blog/storage";
import type { BlogRecipeSnapshot, PublishMode } from "@/lib/blog/types";
import { WpError, mapLimited, safeFilename, uploadMedia, type WpCreds } from "@/lib/pins/wp/client";
import { slugify } from "@/lib/utils";
import { articleMarker, createPost, findMediaBySlug, lookupPostSlug, pickFreeSlug, updatePost, type WpPostInput, type WpPostStatus } from "@/lib/articles/wp/posts";
import { MediaDownError, PartialUploadError, UPLOAD_CONCURRENCY, UPLOAD_TIMEOUT_MS, MEDIA_DOWN_STREAK } from "@/lib/articles/wp/publish";
import { resolveBlogCategory, type CategoryResolution } from "./categories";

export { MediaDownError, PartialUploadError };

export type PublishCtx = { post: BlogPost; site: BlogSite; creds: () => WpCreds; recipe: BlogRecipeSnapshot; ai: AiCtx; signal: AbortSignal; tick: (label?: string) => Promise<void>; log: (msg: string, extra?: unknown) => void };
export type PublishOutcome = { postId: number; url: string; status: string; created: boolean; uploaded: number; reused: number; failedUploads: number; photosTotal: number; category: CategoryResolution | null };

export function mediaFilename(slug: string, photo: Pick<BlogPhoto, "id" | "position">): string {
  return safeFilename(`${slug.slice(0, 60)}-${photo.position}-${photo.id.slice(0, 8)}.jpg`, "jpg");
}

async function loadPhotoBytes(photo: BlogPhoto, signal: AbortSignal): Promise<Buffer | null> {
  if (photo.path) { try { return await readFile(absPath(photo.path)); } catch { /* по ссылке */ } }
  const url = photo.publicUrl;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: "follow" });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.byteLength ? buf : null;
  } catch { return null; }
}

const isAuthError = (e: unknown) => e instanceof WpError && (e.status === 401 || e.status === 403);

export async function publishPost(ctx: PublishCtx): Promise<PublishOutcome> {
  const { signal } = ctx;
  const creds = ctx.creds();
  let post = ctx.post;
  if (!post.html?.trim()) throw new Error("HTML статьи пуст — сначала этап «Сборка HTML»");
  const photos = await prisma.blogPhoto.findMany({ where: { postId: post.id }, orderBy: { position: "asc" } });

  let slug = post.slug.trim();
  if (!slug) {
    slug = slugify(post.focusKeyword || post.keyword);
    await prisma.blogPost.update({ where: { id: post.id }, data: { slug } });
    post = { ...post, slug };
  }
  let targetId: number | null = post.wpPostId;
  if (!targetId) {
    await ctx.tick("поиск записи по адресу");
    const look = await lookupPostSlug(creds, slug, post.id, { signal });
    if (look.own) {
      targetId = look.own.id;
      ctx.log(`запись этой статьи уже есть (#${look.own.id}, ${look.own.status}) — обновляем`);
      await prisma.blogPost.update({ where: { id: post.id }, data: { wpPostId: look.own.id, wpUrl: look.own.url || undefined, wpStatus: look.own.status || undefined } });
    } else if (look.foreign) {
      const free = pickFreeSlug(slug, look.taken);
      ctx.log(`адрес /${slug} занят чужой записью #${look.foreign.id} — публикуем как /${free}`);
      slug = free;
      await prisma.blogPost.update({ where: { id: post.id }, data: { slug } });
      post = { ...post, slug };
    }
  }
  const h1 = post.h1.trim() || post.keyword;
  let html = post.html ?? "";

  await ctx.tick("категория");
  let category: CategoryResolution | null = null;
  let categoryId: number | null = post.wpCategoryId;
  if (!categoryId) {
    try {
      category = await resolveBlogCategory({ site: ctx.site, ai: ctx.ai, creds: ctx.creds, signal, log: (m) => ctx.log(m) }, { keyword: post.keyword, title: h1 });
      categoryId = category.id;
      ctx.log(`категория: ${categoryId ?? "—"} (${category.source}${category.detail ? `, ${category.detail}` : ""})`);
      if (categoryId) await prisma.blogPost.update({ where: { id: post.id }, data: { wpCategoryId: categoryId } });
    } catch (e) {
      ctx.log(`категория не выбрана: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Фото в медиатеку. Задания: оригинал и/или картинка с плашкой (pin_images) — по режиму сценария:
  // article — в статье картинка с плашкой (оригинал не нужен), pin_only — оба (плашка уходит в data-pin-media), off — оригинал.
  const live = photos.filter((p) => !p.excluded).sort((a, b) => a.position - b.position);
  const ovMode = ctx.recipe.params.overlay?.mode ?? "off";
  type Job = { photo: BlogPhoto; kind: "orig" | "pin" };
  const jobs: Job[] = [];
  for (const p of live) {
    const hasPin = ovMode !== "off" && !!p.overlayPath;
    if (!(hasPin && ovMode === "article")) jobs.push({ photo: p, kind: "orig" });
    if (hasPin) jobs.push({ photo: p, kind: "pin" });
  }
  const isDone = (j: Job) => (j.kind === "orig" ? !!(j.photo.wpMediaId && j.photo.wpUrl) : !!(j.photo.overlayWpMediaId && j.photo.overlayWpUrl));
  const todo = jobs.filter((j) => !isDone(j));
  const priorRuns = todo.length && !(post.publishAttempts > 0 || post.wpPostId) ? await prisma.blogStageLog.count({ where: { postId: post.id, stage: "publish" } }).catch(() => 2) : 0;
  const retrying = post.publishAttempts > 0 || !!post.wpPostId || priorRuns > 1;
  let uploaded = 0, reused = 0, failed = 0, done = 0, serverErrorsInRow = 0;
  let mediaDown = false;
  await mapLimited(todo, UPLOAD_CONCURRENCY, async ({ photo, kind }) => {
    if (mediaDown || signal.aborted) return;
    const filename = kind === "pin" ? mediaFilename(slug, photo).replace(/\.jpg$/, "-pin.jpg") : mediaFilename(slug, photo);
    const mediaSlug = filename.replace(/\.jpg$/, "");
    const label = `${photo.slotKey}${kind === "pin" ? " (с текстом)" : ""}`;
    const save = async (id: number, url: string) => {
      if (kind === "pin") {
        await prisma.blogPhoto.update({ where: { id: photo.id }, data: { overlayWpMediaId: id, overlayWpUrl: url } });
        photo.overlayWpMediaId = id; photo.overlayWpUrl = url;
      } else {
        await prisma.blogPhoto.update({ where: { id: photo.id }, data: { wpMediaId: id, wpUrl: url, fileName: filename } });
        photo.wpMediaId = id; photo.wpUrl = url;
      }
    };
    try {
      if (retrying) {
        const found = await findMediaBySlug(creds, mediaSlug, { signal }).catch((e) => { if (isAuthError(e)) throw e; return null; });
        if (found) { await save(found.id, found.url); reused++; serverErrorsInRow = 0; return; }
      }
      const src = kind === "pin" ? await readFile(absPath(photo.overlayPath)).catch(() => null) : await loadPhotoBytes(photo, signal);
      if (!src) { failed++; ctx.log(`фото ${label}: файла нет ни локально, ни по ссылке`); return; }
      const jpeg = await toWpJpeg(src);
      const title = kind === "pin" ? String((photo.overlayText as { title?: string } | null)?.title ?? "") || photo.altText : photo.altText;
      const r = await uploadMedia(creds, { data: jpeg.bytes, filename, mime: "image/jpeg" }, { altText: photo.altText || "", title: (title || mediaSlug).slice(0, 200), caption: photo.caption || "" }, { signal, timeoutMs: UPLOAD_TIMEOUT_MS, maxRetries: 1 });
      await save(r.id, r.url);
      uploaded++;
      serverErrorsInRow = 0;
      if (r.warning) ctx.log(`фото ${label}: ${r.warning}`);
    } catch (e) {
      if (isAuthError(e) || signal.aborted) throw e;
      failed++;
      if (e instanceof WpError && e.status >= 500) { serverErrorsInRow++; await new Promise((r) => setTimeout(r, 3_000)); }
      if (serverErrorsInRow >= MEDIA_DOWN_STREAK && uploaded === 0 && reused === 0) mediaDown = true;
      ctx.log(`фото ${label}: загрузка не удалась: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      done++;
      await ctx.tick(`фото ${done}/${todo.length}`);
    }
  });
  if (mediaDown) throw new MediaDownError();
  const onSite = jobs.filter(isDone).length;
  if (todo.length && failed > 0 && onSite === 0) throw new WpError(`Сайт не принимает фото: не загружено ни одного из ${todo.length} (ошибок ${failed})`, 503);
  ctx.log(`фото: загружено ${uploaded}, найдено по маркеру ${reused}, уже на сайте ${jobs.length - todo.length}, ошибок ${failed}`);
  if (failed > 0) throw new PartialUploadError(failed, jobs.length, onSite);

  for (const p of live) {
    if (p.wpUrl && p.publicUrl && p.publicUrl !== p.wpUrl) html = html.split(p.publicUrl).join(p.wpUrl);
    if (p.overlayPath && p.overlayWpUrl) html = html.split(publicUrl(p.overlayPath)).join(p.overlayWpUrl);
  }
  if (html !== (post.html ?? "")) await prisma.blogPost.update({ where: { id: post.id }, data: { html } });

  await ctx.tick("запись на сайте");
  const mode: PublishMode = ctx.recipe.run?.publishMode ?? (ctx.recipe.publish.mode as PublishMode);
  const approved = !!post.reviewedAt;
  const status: WpPostStatus = mode === "moderate_first" && !approved ? "draft" : "publish";
  const mediaOf = (p: BlogPhoto) => (ovMode === "article" && p.overlayWpMediaId ? p.overlayWpMediaId : p.wpMediaId);
  const featuredPhoto = live.find((p) => p.slotKey === "hero" && mediaOf(p)) ?? live.find((p) => mediaOf(p));
  const featured = (featuredPhoto && mediaOf(featuredPhoto)) || undefined;
  const focusKw = post.focusKeyword || post.keyword;
  const meta: Record<string, string> = {};
  if (post.metaTitle) meta._yoast_wpseo_title = post.metaTitle;
  if (post.metaDescription) meta._yoast_wpseo_metadesc = post.metaDescription;
  if (focusKw) meta._yoast_wpseo_focuskw = focusKw;
  const body: WpPostInput = {
    title: h1, content: `${articleMarker(post.id)}\n${html}`, slug, status, excerpt: post.metaDescription || undefined,
    ...(categoryId ? { categories: [categoryId] } : {}), ...(featured ? { featured_media: featured } : {}), ...(Object.keys(meta).length ? { meta } : {}),
  };
  let created = false;
  let result: Awaited<ReturnType<typeof createPost>> | null = null;
  if (targetId) {
    try { result = await updatePost(creds, targetId, body, { signal }); }
    catch (e) { if (e instanceof WpError && e.status === 404) { ctx.log(`запись #${targetId} удалена на сайте — создаём заново`); targetId = null; } else throw e; }
  }
  if (!result) { result = await createPost(creds, body, { signal }); created = true; }
  const now = new Date();
  await prisma.blogPost.update({
    where: { id: post.id },
    data: { wpPostId: result.id, wpUrl: result.url, wpStatus: result.status || status, slug: result.slug || slug, publishedAt: result.status === "publish" ? post.publishedAt ?? now : post.publishedAt, ...(categoryId ? { wpCategoryId: categoryId } : {}) },
  });
  void Prisma;
  return { postId: result.id, url: result.url, status: result.status || status, created, uploaded, reused, failedUploads: failed, photosTotal: jobs.length, category };
}
