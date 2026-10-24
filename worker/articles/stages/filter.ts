/**
 * Этап filter (оригинал: шаг 12, stage-photo-filter/index.ts) — жёсткий технический фильтр без ИИ.
 * Кандидаты `found` обрабатываются пачками по 4 параллельно: запрещённый/каталожный источник, релевантность по тексту,
 * скачивание (один раз — файл остаётся на диске для rank/rate/select), SHA-256 и dHash-дубли внутри статьи, размер
 * (короткая сторона ≥ 550), ориентация, коллаж/леттербокс/плашка, резкость, метки ИИ. Прошедшие → `downloaded`
 * с миниатюрой и techScore; отбракованные → `rejected` (файл не сохраняется).
 * Резерв ×5 от числа фото: не хватает → cursor.topup и возврат в search (не больше PHOTO_LOOPS.filterCycles кругов).
 */
import { prisma } from "@/lib/db";
import type { ArtPhotoCandidate } from "@prisma/client";
import { PHOTO_LOOPS } from "@/lib/articles/types";
import { candidateRel, candidateThumbRel, makeThumb, removePath, writeFileAtomic } from "@/lib/articles/storage";
import { getNicheProfile, specializeProfile } from "@/lib/articles/photo/profile";
import { buildTopicRelevance, checkTextRelevance } from "@/lib/articles/photo/relevance";
import { hostOf, isBlockedDomain, normalizeSearchConfig, orientationVerdict, sizeVerdict } from "@/lib/articles/photo/search";
import { NEAR_DUPLICATE_DISTANCE, catalogueSourceSignal, downloadImage, imageDims, inspectPhotoBytes, isSoftFailure, phashDistance, sha256, techQualityScore, type DownloadResult, type TechDetails } from "@/lib/articles/photo/download";
import type { ArtStageHandler } from "./index";
import { articleKeyword, reserveTargetFor, topupAvailable, type PhotoCursor } from "./search";

/** Сколько кандидатов проверяем одновременно (оригинал: BATCH = 4, CONCURRENCY = 1 из-за памяти edge-рантайма). */
const BATCH = 4;
/** Попытки скачать один кадр (оригинал: MAX_ATTEMPTS = 3, stage-photo-filter/index.ts:227). */
const MAX_ATTEMPTS = 3;
/** Пауза перед повтором «мягко» отказавшего источника (в оригинале — следующий HTTP-вызов функции). */
const POSTPONE_MS = 5_000;

/** Статусы кандидата, уже прошедшего фильтр (их отпечатки блокируют дубли). */
const PASSED_STATUSES = ["downloaded", "rated", "keep", "selected", "reserve"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const detailsOf = (c: ArtPhotoCandidate): TechDetails => ((c.techDetails ?? {}) as TechDetails);

export const filter: ArtStageHandler = async (ctx) => {
  const { article, recipe } = ctx;
  const cfg = normalizeSearchConfig(recipe.photoSearch);
  const keyword = articleKeyword(article);
  const needed = Math.max(1, article.photoCount || 20);
  const reserveTarget = reserveTargetFor(needed);
  const profile = specializeProfile(await getNicheProfile(recipe.nicheCode, recipe.subnicheCode), keyword);
  const rel = buildTopicRelevance(keyword, recipe.nicheCode, profile);
  // Этап rate вернул нас доделать непроверенных кандидатов (оригинал: needs_filtering → process_pending):
  // резерв уже не повод останавливаться, и добор не запрашиваем — после фильтра снова rank → rate.
  const filterPending = !!(ctx.cursor as PhotoCursor).filterPending;

  // Отпечатки уже принятых кадров статьи — отбракованный коллаж не должен блокировать похожее хорошее фото.
  const accepted = await prisma.artPhotoCandidate.findMany({ where: { articleId: article.id, status: { in: PASSED_STATUSES } }, select: { sha256: true, phash: true } });
  const localSha = new Set(accepted.map((r) => r.sha256).filter((s): s is string => !!s));
  const localPhash: string[] = accepted.map((r) => r.phash).filter((p): p is string => !!p);
  const nearDuplicateOf = (ph?: string | null) => !!ph && localPhash.some((p) => phashDistance(p, ph) <= NEAR_DUPLICATE_DISTANCE);

  let passed = accepted.length;
  let batchPassed = 0, batchRejected = 0, postponed = 0;
  const reasons: Record<string, number> = {};
  const bump = (r: string) => {
    const k = r.split(":")[0].split("(")[0].trim();
    reasons[k] = (reasons[k] || 0) + 1;
  };

  const reject = async (c: ArtPhotoCandidate, reason: string, extra: { sha256?: string | null; phash?: string | null; details?: TechDetails } = {}) => {
    batchRejected++;
    bump(reason);
    await prisma.artPhotoCandidate.update({
      where: { id: c.id },
      data: { status: "rejected", rejectStage: "filter", rejectReason: reason.slice(0, 1000), sha256: extra.sha256 ?? c.sha256, phash: extra.phash ?? c.phash, ...(extra.details ? { techDetails: extra.details as object } : {}) },
    });
    // файл оригинала у отклонённых не хранится
    await removePath(candidateRel(article.id, c.id)).catch(() => {});
    await removePath(candidateThumbRel(article.id, c.id)).catch(() => {});
  };

  const processOne = async (c: ArtPhotoCandidate) => {
    const prev = detailsOf(c);
    const attempt = (prev.attempt ?? 0) + 1;
    if (attempt > MAX_ATTEMPTS) {
      await reject(c, `источник не отдал файл после ${MAX_ATTEMPTS} попыток`);
      return;
    }
    // Счётчик попыток пишем ДО загрузки файла: если воркер умрёт на медленном источнике, кадр не зациклится.
    await prisma.artPhotoCandidate.update({ where: { id: c.id }, data: { techDetails: { ...prev, attempt, retryAfter: undefined } as object } });

    // 1) бесплатные проверки: категория источника, каталог, релевантность по тексту (оригинал :391-409)
    const domain = c.domain || hostOf(c.pageUrl) || hostOf(c.url) || "";
    const blocked = isBlockedDomain(domain, cfg.exclude_domains);
    if (blocked) return reject(c, `запрещённый источник (${blocked})`);
    const catalogue = catalogueSourceSignal({ sourceDomain: domain, sourcePageUrl: c.pageUrl, imageUrl: c.url, title: c.title });
    if (catalogue.reject) return reject(c, catalogue.reason || "каталожная карточка");
    const relCheck = checkTextRelevance(rel, [c.title, c.pageUrl, c.url]);
    if (relCheck.reject) return reject(c, relCheck.reason || "не та тема");

    // 2) скачивание: оригинал → миниатюра Google
    let dl: DownloadResult;
    try {
      dl = await downloadImage([c.url, c.thumbUrl], { signal: ctx.signal });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      dl = { ok: false as const, reason: `недоступно: ${(e as Error).message.slice(0, 80)}`, status: 0, contentType: "" };
    }
    if (!dl.ok) {
      // Источник не отдал файл (429/403/5xx/HTML) — не брак кадра: откладываем и пробуем ещё (всего MAX_ATTEMPTS раз).
      if (isSoftFailure(dl.reason) && attempt < MAX_ATTEMPTS) {
        postponed++;
        await prisma.artPhotoCandidate.update({
          where: { id: c.id },
          data: { rejectReason: `отложено: ${dl.reason.slice(0, 60)} (попытка ${attempt})`, techDetails: { ...prev, attempt, retryAfter: Date.now() + POSTPONE_MS } as object },
        });
        return;
      }
      return reject(c, dl.reason);
    }
    const bytes = dl.bytes;

    // 3) отпечаток файла — дубли внутри статьи (резервируем сразу, пачка идёт параллельно)
    const fp = sha256(bytes);
    if (localSha.has(fp)) return reject(c, "дубликат внутри статьи", { sha256: fp });
    localSha.add(fp);
    const unreserve = () => localSha.delete(fp);

    // 4) размер и ориентация (из байтов, иначе от провайдера)
    const dims = (await imageDims(bytes)) || (c.width && c.height ? { width: c.width, height: c.height, format: "" } : null);
    const sizeIssue = dims ? sizeVerdict(dims.width, dims.height, cfg) : null;
    if (sizeIssue) { unreserve(); return reject(c, sizeIssue, { sha256: fp }); }
    const orientIssue = dims ? orientationVerdict(dims.width, dims.height, cfg) : null;
    if (orientIssue) { unreserve(); return reject(c, orientIssue, { sha256: fp }); }

    // 5) пиксели: метки ИИ, коллаж / леттербокс / плашка, резкость, dHash
    const vision = await inspectPhotoBytes(bytes);
    const details: TechDetails = {
      sharpness: vision.sharpness ?? null,
      contrast: vision.stats?.contrast ?? null,
      colorfulness: vision.stats?.colorfulness ?? null,
      brightness: vision.stats?.brightness ?? null,
      decoded: vision.decoded,
      usedThumbnail: dl.usedThumbnail,
      format: dims?.format || dl.contentType,
      weakText: relCheck.weak || undefined,
      attempt,
    };
    if (vision.reject) { unreserve(); return reject(c, vision.reason || "брак по пикселям", { sha256: fp, phash: vision.phash ?? null, details }); }
    if (nearDuplicateOf(vision.phash)) { unreserve(); return reject(c, "почти такой же кадр уже есть", { sha256: fp, phash: vision.phash ?? null, details }); }
    if (vision.phash) localPhash.push(vision.phash);

    // 6) файл и миниатюра на диск, запись кандидата
    const fileRel = candidateRel(article.id, c.id);
    const thumbRel = candidateThumbRel(article.id, c.id);
    await writeFileAtomic(fileRel, bytes);
    try {
      await writeFileAtomic(thumbRel, await makeThumb(bytes));
    } catch (e) {
      ctx.log(`thumb failed for ${c.id}: ${(e as Error).message}`);
    }
    const techScore = techQualityScore({
      width: dims?.width ?? c.width, height: dims?.height ?? c.height,
      sharpness: vision.sharpness ?? null, contrast: vision.stats?.contrast ?? null,
      colorfulness: vision.stats?.colorfulness ?? null, brightness: vision.stats?.brightness ?? null,
      domain,
    });
    await prisma.artPhotoCandidate.update({
      where: { id: c.id },
      data: {
        status: "downloaded",
        rejectStage: null,
        rejectReason: dl.usedThumbnail ? "миниатюра Google" : null,
        width: dims?.width ?? c.width, height: dims?.height ?? c.height,
        bytes: bytes.length, sha256: fp, phash: vision.phash ?? null,
        path: fileRel, thumbPath: thumbRel,
        techScore: Math.round(techScore),
        techDetails: details as object,
      },
    });
    passed++;
    batchPassed++;
  };

  // ── Пачки по 4, пока есть `found` и резерв не набран ──
  let processedAny = false;
  for (;;) {
    if (passed >= reserveTarget && !filterPending) break; // ранний стоп: резерв собран (оригинал :200-214)
    const found = await prisma.artPhotoCandidate.findMany({ where: { articleId: article.id, status: "found" }, orderBy: [{ queryIndex: "asc" }, { position: "asc" }], take: BATCH * 4 });
    if (!found.length) break;
    const now = Date.now();
    const ready = found.filter((c) => !((detailsOf(c).retryAfter ?? 0) > now)).slice(0, BATCH);
    if (!ready.length) {
      const wake = Math.min(...found.map((c) => detailsOf(c).retryAfter ?? now)) - now;
      await ctx.tick(`Фильтр: ждём повтор ${found.length} отложенных`);
      await sleep(Math.max(250, Math.min(wake, POSTPONE_MS)));
      continue;
    }
    processedAny = true;
    await Promise.all(ready.map((c) => processOne(c)));
    await ctx.tick(`Фильтр: прошло ${passed}/${reserveTarget}, отбраковано ${batchRejected}`);
  }

  const remaining = await prisma.artPhotoCandidate.count({ where: { articleId: article.id, status: "found" } });
  const totalRejected = await prisma.artPhotoCandidate.count({ where: { articleId: article.id, status: "rejected", rejectStage: "filter" } });
  const cursor = ctx.cursor as PhotoCursor;
  const cycles = cursor.filterCycles ?? 0;
  const details = { passed, target: reserveTarget, remaining, batchPassed, batchRejected, postponed, totalRejected, rejectReasons: reasons, filterCycles: cycles, filterPending };
  if (filterPending) await ctx.save({ cursor: { ...cursor, filterPending: false } });

  // ── Резерва нет — просим search добрать (пока есть чем и не исчерпаны круги) ──
  if (!filterPending && passed < reserveTarget && cycles < PHOTO_LOOPS.filterCycles && topupAvailable(cursor)) {
    const reason = `после фильтра ${passed} из ${reserveTarget} годных кадров`;
    await ctx.save({ cursor: { ...cursor, filterCycles: cycles + 1, topup: { from: "filter", needed: reserveTarget - passed, reason } } });
    return { next: "search", summary: `Фильтр: ${passed}/${reserveTarget} годных, добор ${cycles + 1}`, details };
  }

  if (passed === 0) {
    return { fatal: `После технического фильтра не осталось ни одного фото (отбраковано ${totalRejected}: ${Object.entries(reasons).map(([k, v]) => `${k} — ${v}`).join(", ") || "причины не записаны"})`, details };
  }

  return {
    summary: processedAny
      ? `Фильтр: годных ${passed} (цель ${reserveTarget}), отбраковано ${batchRejected}, отложено ${postponed}`
      : `Фильтр: резерв уже собран (${passed}/${reserveTarget})`,
    details,
  };
};
