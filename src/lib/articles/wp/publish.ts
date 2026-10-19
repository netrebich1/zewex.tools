/**
 * Публикация статьи в WordPress — основной поток этапа `publish` (78).
 * Порт supabase/functions/stage7-publish-wordpress/index.ts без костылей под лимит функции
 * (phase prepare, PARTIAL_UPLOAD, бюджеты 45/75 с, www/без-www второй базовый адрес — адрес сайта у нас нормализует SiteAccess).
 *
 * Порядок: проверка качества (+ детерминированная починка) → категория → загрузка фото в медиатеку (по 2 параллельно,
 * wpMediaId/wpUrl пишутся сразу после ответа на каждый файл) → подмена ссылок в HTML → поиск записи по slug ДО создания →
 * создание или обновление записи → wpPostId/wpUrl/wpStatus сразу после ответа WP (08-plan §3 п.9).
 * Повтор публикации (есть wpPostId или нашлась запись с меткой этой статьи) обновляет запись, дубль не создаётся.
 * Чужая запись с тем же адресом не трогается: статья получает свободный адрес slug-2, slug-3 … (аудит 2026-10-14).
 * Идемпотентно: уже загруженные фото пропускаются, медиа ищется по маркеру id фото в имени файла.
 */
import { readFile } from "fs/promises";
import { Prisma, type Article, type ArtPhoto, type ArtSite } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { AiCtx } from "@/lib/articles/ai";
import { absPath, toWpJpeg } from "@/lib/articles/storage";
import type { ArticleRecipeSnapshot, PublishMode } from "@/lib/articles/types";
import { WpError, mapLimited, safeFilename, uploadMedia, type WpCreds } from "@/lib/pins/wp/client";
import { slugify } from "@/lib/utils";
import { resolveCategory, type CategoryResolution } from "./categories";
import { articleMarker, createPost, findMediaBySlug, lookupPostSlug, pickFreeSlug, updatePost, type WpPostInput, type WpPostStatus } from "./posts";
import { applyQualityPatch, checkArticleQuality } from "./qualityCheck";

/** Загрузок в медиатеку одновременно. Оригинал :317 — 2 (больше → общий хостинг WP отвечает 500). */
export const UPLOAD_CONCURRENCY = 2;
/** Таймаут одной загрузки. Оригинал: 25 с на запрос внутри бюджета 45/75 с (:264, :319); у нас бюджетов нет. */
export const UPLOAD_TIMEOUT_MS = 90_000;
/** Столько подряд 5xx от медиатеки при нуле загруженных = медиатека сайта сломана (оригинал :320 mediaDown). */
export const MEDIA_DOWN_STREAK = 4;
/** Скачивание своей же публичной ссылки, если локального файла уже нет. */
const FETCH_TIMEOUT_MS = 30_000;

/** Статья не прошла проверку качества — чинить нечем, статья останавливается с перечнем проблем. */
export class QualityError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Статья не прошла проверку качества: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (и ещё ${problems.length - 5})` : ""}`);
    this.name = "QualityError";
  }
}

/** Медиатека сайта отвечает ошибкой сервера на каждое фото (оригинал :333 WP_MEDIA_DOWN) — ждём хостинг, попытки не тратим. */
/**
 * Часть фото не загрузилась в медиатеку (сайт перегружен, 503 и т.п.). Запись НЕ создаётся/не обновляется со ссылками
 * на наше хранилище: этап повторяется позже и догружает только недостающие (владелец 2026-10-16, zorvianix: 175 статей
 * вышли с ~790 фото по ссылке на zewex.tools).
 */
export class PartialUploadError extends Error {
  constructor(public readonly failed: number, public readonly total: number, public readonly onSite: number) {
    super(`WordPress не принял ${failed} из ${total} фото (на сайте ${onSite}) — публикация отложена, догрузим недостающие`);
    this.name = "PartialUploadError";
  }
}

export class MediaDownError extends Error {
  readonly code = "WP_MEDIA_DOWN";
  constructor() {
    super(
      "Сайт не принимает загрузку фото: медиатека WordPress отвечает ошибкой сервера 500 на каждое фото. Нужно исправить на хостинге (место на диске, права папки uploads, лимиты PHP). Статья ждёт и повторится автоматически.",
    );
    this.name = "MediaDownError";
  }
}

export type PublishCtx = {
  article: Article;
  site: ArtSite;
  creds: () => WpCreds;
  recipe: ArticleRecipeSnapshot;
  ai: AiCtx;
  signal: AbortSignal;
  tick: (label?: string) => Promise<void>;
  log: (msg: string, extra?: unknown) => void;
};

export type PublishOutcome = {
  postId: number;
  url: string;
  /** Статус записи на сайте: publish | draft */
  status: string;
  /** Запись создана (false — обновлена существующая) */
  created: boolean;
  uploaded: number;
  reused: number;
  failedUploads: number;
  photosTotal: number;
  category: CategoryResolution | null;
  fixed: string[];
};

/** Имя файла в медиатеке с маркером id фото: <slug>-<pos>-<photoId8>.jpg (slug ≤60, чтобы маркер не обрезался). */
export function mediaFilename(slug: string, photo: Pick<ArtPhoto, "id" | "position">): string {
  return safeFilename(`${slug.slice(0, 60)}-${photo.position}-${photo.id.slice(0, 8)}.jpg`, "jpg");
}

async function loadPhotoBytes(photo: ArtPhoto, signal: AbortSignal): Promise<Buffer | null> {
  if (photo.path) {
    try {
      return await readFile(absPath(photo.path));
    } catch {
      /* файла нет — пробуем по ссылке */
    }
  }
  const url = photo.publicUrl;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), FETCH_TIMEOUT_MS);
  const onOuter = () => ac.abort(signal.reason ?? new Error("aborted"));
  signal.addEventListener("abort", onOuter, { once: true });
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: "follow" });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.byteLength ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onOuter);
  }
}

function isAuthError(e: unknown): boolean {
  return e instanceof WpError && (e.status === 401 || e.status === 403);
}

export async function publishArticle(ctx: PublishCtx): Promise<PublishOutcome> {
  const { signal } = ctx;
  const creds = ctx.creds();
  let article = ctx.article;

  const [sections, photos] = await Promise.all([
    prisma.artSection.findMany({ where: { articleId: article.id }, orderBy: { position: "asc" } }),
    prisma.artPhoto.findMany({ where: { articleId: article.id }, orderBy: { position: "asc" } }),
  ]);

  // ── 1. Качество + починка (оригинал :72-118) ────────────────
  await ctx.tick("проверка качества");
  const quality = await checkArticleQuality(article, sections, photos, { signal });
  await applyQualityPatch(article.id, quality.patch);
  article = { ...article, ...quality.patch.article };
  if (quality.fixed.length) ctx.log(`починка: ${quality.fixed.join("; ")}`);
  if (!quality.ok) throw new QualityError(quality.problems);

  // Slug фиксируем в базе до любых обращений к сайту: между попытками он не должен меняться (аудит 04 §10 п.3).
  let slug = article.slug.trim();
  if (!slug) {
    slug = slugify(article.focusKeyword || article.keyword);
    await prisma.article.update({ where: { id: article.id }, data: { slug } });
    article = { ...article, slug };
  }
  // Своя запись — только по wpPostId или по метке статьи в тексте; адрес, занятый чужой записью, меняем на свободный
  // до загрузки фото (имена файлов медиа строятся от slug). Ошибка поиска не глушится — повтор позже.
  let targetId: number | null = article.wpPostId;
  if (!targetId) {
    await ctx.tick("поиск записи по адресу");
    const look = await lookupPostSlug(creds, slug, article.id, { signal });
    if (look.own) {
      targetId = look.own.id;
      ctx.log(`запись этой статьи уже есть (#${look.own.id}, ${look.own.status}, /${look.own.slug}) — обновляем`);
      await prisma.article.update({ where: { id: article.id }, data: { wpPostId: look.own.id, wpUrl: look.own.url || undefined, wpStatus: look.own.status || undefined } });
    } else if (look.foreign) {
      const free = pickFreeSlug(slug, look.taken);
      ctx.log(`адрес /${slug} занят чужой записью #${look.foreign.id} («${look.foreign.title.slice(0, 80)}») — не трогаем её, публикуем как /${free}`);
      slug = free;
      await prisma.article.update({ where: { id: article.id }, data: { slug } });
      article = { ...article, slug };
    }
  }
  const h1 = article.h1.trim() || article.keyword;
  let html = article.html ?? "";

  // ── 2. Категория (оригинал :161-193): уже выбранная → правила → ИИ → по умолчанию ──
  await ctx.tick("категория");
  let category: CategoryResolution | null = null;
  let categoryId: number | null = article.wpCategoryId;
  if (!categoryId) {
    try {
      category = await resolveCategory({ site: ctx.site, ai: ctx.ai, creds: ctx.creds, signal, log: (m) => ctx.log(m) }, { keyword: article.keyword || article.focusKeyword, title: h1 || article.metaTitle || null });
      categoryId = category.id;
      ctx.log(`категория: ${categoryId ?? "—"} (${category.source}${category.detail ? `, ${category.detail}` : ""})`);
      if (categoryId) await prisma.article.update({ where: { id: article.id }, data: { wpCategoryId: categoryId } });
    } catch (e) {
      ctx.log(`категория не выбрана: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 3. Фото в медиатеку (оригинал :206-348) ─────────────────
  const livePhotos = photos.filter((p) => !p.excluded).sort((a, b) => a.position - b.position);
  const todo = livePhotos.filter((p) => !(p.wpMediaId && p.wpUrl));
  // Искать уже загруженные фото по метке в имени, если публикация этой статьи уже запускалась хоть раз: прошлая попытка
  // могла загрузить файл и не успеть записать wpMediaId (рестарт воркера посреди загрузки). Признак — запись этапа
  // publish в журнале кроме текущей, а не publishAttempts (он растёт только на классифицированной ошибке) — аудит §2.4.
  const priorRuns = todo.length && !(article.publishAttempts > 0 || article.wpPostId)
    ? await prisma.artStageLog.count({ where: { articleId: article.id, stage: "publish" } }).catch(() => 2)
    : 0;
  const retrying = article.publishAttempts > 0 || !!article.wpPostId || priorRuns > 1;
  let uploaded = 0;
  let reused = 0;
  let failed = 0;
  let done = 0;
  let serverErrorsInRow = 0;
  let mediaDown = false;
  const isMediaDown = () => serverErrorsInRow >= MEDIA_DOWN_STREAK && uploaded === 0 && reused === 0;

  await mapLimited(todo, UPLOAD_CONCURRENCY, async (photo) => {
    if (mediaDown || signal.aborted) return;
    const filename = mediaFilename(slug, photo);
    const mediaSlug = filename.replace(/\.jpg$/, "");
    const save = async (id: number, url: string) => {
      await prisma.artPhoto.update({ where: { id: photo.id }, data: { wpMediaId: id, wpUrl: url, fileName: filename } });
      photo.wpMediaId = id;
      photo.wpUrl = url;
    };
    try {
      // Повторная попытка: файл мог загрузиться, а запись в базу — не успеть. Ищем по маркеру в имени.
      if (retrying) {
        const found = await findMediaBySlug(creds, mediaSlug, { signal }).catch((e) => {
          if (isAuthError(e)) throw e;
          ctx.log(`поиск медиа ${mediaSlug} не удался: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        if (found) {
          await save(found.id, found.url);
          reused++;
          serverErrorsInRow = 0;
          return;
        }
      }
      const src = await loadPhotoBytes(photo, signal);
      if (!src) {
        failed++;
        ctx.log(`фото ${photo.position}: файла нет ни локально, ни по ссылке — остаётся публичная ссылка`);
        return;
      }
      // Сжатие перед загрузкой — всегда (оригинал _shared/compressImage.ts: ≤1600 px, JPEG 90; у нас sharp в toWpJpeg)
      const jpeg = await toWpJpeg(src);
      const r = await uploadMedia(
        creds,
        { data: jpeg.bytes, filename, mime: "image/jpeg" },
        { altText: photo.altText || "", title: (photo.altText || mediaSlug).slice(0, 200), caption: photo.caption || "" },
        { signal, timeoutMs: UPLOAD_TIMEOUT_MS, maxRetries: 1 }, // оригинал :287-296: одна повторная попытка при 5xx/обрыве
      );
      await save(r.id, r.url);
      uploaded++;
      serverErrorsInRow = 0;
      if (r.warning) ctx.log(`фото ${photo.position}: ${r.warning}`);
    } catch (e) {
      if (isAuthError(e) || signal.aborted) throw e;
      failed++;
      if (e instanceof WpError && e.status >= 500) {
        serverErrorsInRow++;
        await new Promise((r) => setTimeout(r, 3_000)); // сайт перегружен — не добиваем его следующими загрузками сразу
      }
      if (isMediaDown()) mediaDown = true;
      // Фолбэк оригинала (:342-346): фото остаётся с публичной ссылкой хранилища, wpMediaId пуст
      ctx.log(`фото ${photo.position}: загрузка не удалась, остаётся публичная ссылка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      done++;
      await ctx.tick(`фото ${done}/${todo.length}`);
    }
  });

  if (mediaDown) throw new MediaDownError();
  const onSite = livePhotos.filter((p) => p.wpUrl).length;
  if (todo.length && failed > 0 && onSite === 0) {
    // оригинал :336: ни одного фото за попытку — это сбой сайта, попытка засчитывается, повтор с паузой
    throw new WpError(`Сайт не принимает фото: не загружено ни одного из ${todo.length} (ошибок ${failed})`, 503);
  }
  ctx.log(`фото: загружено ${uploaded}, найдено по маркеру ${reused}, пропущено (уже на сайте) ${livePhotos.length - todo.length}, ошибок ${failed}`);
  // Не все фото в медиатеке — не публикуем со ссылками на наше хранилище; загруженные уже сохранены (wpUrl), повтор догрузит остальные.
  if (failed > 0) throw new PartialUploadError(failed, livePhotos.length, onSite);

  // ── 4. HTML: публичные ссылки → ссылки сайта (оригинал :236-239, :307) ──
  for (const p of livePhotos) {
    if (p.wpUrl && p.publicUrl && p.publicUrl !== p.wpUrl) html = html.split(p.publicUrl).join(p.wpUrl);
  }
  if (html !== (article.html ?? "")) await prisma.article.update({ where: { id: article.id }, data: { html } });

  // ── 5. Запись (оригинал :120-159, :355-404) ─────────────────
  await ctx.tick("запись на сайте");
  const mode: PublishMode = ctx.recipe.run?.publishMode ?? (article.publishMode as PublishMode);
  // moderate_first: черновик до одобрения; одобрение в модерации статей ставит reviewedAt и возвращает статью на этап publish
  const approved = !!article.reviewedAt;
  const wantsDraft = mode === "moderate_first" && !approved;
  const status: WpPostStatus = wantsDraft ? "draft" : "publish";
  const featured = livePhotos.find((p) => p.wpMediaId)?.wpMediaId ?? undefined;
  const focusKw = article.focusKeyword || article.keyword;
  const meta: Record<string, string> = {};
  if (article.metaTitle) meta._yoast_wpseo_title = article.metaTitle;
  if (article.metaDescription) meta._yoast_wpseo_metadesc = article.metaDescription;
  if (focusKw) meta._yoast_wpseo_focuskw = focusKw;
  const body: WpPostInput = {
    title: h1,
    content: `${articleMarker(article.id)}\n${html}`,
    slug,
    status,
    excerpt: article.metaDescription || undefined,
    ...(categoryId ? { categories: [categoryId] } : {}),
    ...(featured ? { featured_media: featured } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
  };

  let created = false;
  let result: Awaited<ReturnType<typeof createPost>> | null = null;
  if (targetId) {
    try {
      result = await updatePost(creds, targetId, body, { signal });
    } catch (e) {
      if (e instanceof WpError && e.status === 404) {
        ctx.log(`запись #${targetId} удалена на сайте — создаём заново`);
        targetId = null;
      } else throw e;
    }
  }
  if (!result) {
    result = await createPost(creds, body, { signal });
    created = true;
  }

  // wpPostId/wpUrl/wpStatus — сразу после ответа WP, до любых других шагов (08-plan §3 п.9)
  const now = new Date();
  await prisma.article.update({
    where: { id: article.id },
    data: {
      wpPostId: result.id,
      wpUrl: result.url,
      wpStatus: result.status || status,
      slug: result.slug || slug,
      publishedAt: result.status === "publish" ? article.publishedAt ?? now : article.publishedAt,
      ...(categoryId ? { wpCategoryId: categoryId } : {}),
    },
  });
  await prisma.artModerationEvent
    .create({
      data: {
        articleId: article.id,
        action: "publish",
        payload: { wpPostId: result.id, wpUrl: result.url, status: result.status, created, uploaded, reused, failedUploads: failed } as Prisma.InputJsonValue,
      },
    })
    .catch(() => {});

  return { postId: result.id, url: result.url, status: result.status || status, created, uploaded, reused, failedUploads: failed, photosTotal: livePhotos.length, category, fixed: quality.fixed };
}
