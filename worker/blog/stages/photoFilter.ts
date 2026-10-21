/**
 * Этап `photo_filter`: технический фильтр без ИИ (порт worker/articles/stages/filter.ts под слоты инфо-статей).
 * Кандидаты `found` пачками по 4: запрещённый/каталожный источник, скачивание, SHA-256 и dHash-дубли внутри поста,
 * размер (короткая сторона ≥ minSide), ориентация слота, коллаж/леттербокс/плашка, резкость, метки ИИ.
 * Прошедшие → `downloaded` с миниатюрой и techScore; отбракованные → `rejected` (файл не хранится).
 * На слот хватает PER_SLOT_PASSED годных кадров — остальные `found` того же слота остаются на случай добора.
 */
import { prisma } from "@/lib/db";
import type { BlogPhotoCandidate } from "@prisma/client";
import { candidateRel, candidateThumbRel, makeThumb, removePath, writeFileAtomic } from "@/lib/blog/storage";
import { hostOf, isBlockedDomain, orientationVerdict, searchCfgFor, sizeVerdict } from "@/lib/blog/photo/search";
import { NEAR_DUPLICATE_DISTANCE, catalogueSourceSignal, downloadImage, imageDims, inspectPhotoBytes, isSoftFailure, phashDistance, sha256, techQualityScore, type DownloadResult, type TechDetails } from "@/lib/articles/photo/download";
import type { StageHandler } from "./index";
import { slotOrientation } from "./photoSearch";

const BATCH = 4;
const MAX_ATTEMPTS = 2;
const POSTPONE_MS = 4_000;
/** Столько годных кадров на слот достаточно для оценки (экономим скачивания и vision-вызовы). */
export const PER_SLOT_PASSED = 14;
const PASSED_STATUSES = ["downloaded", "keep", "chosen", "reserve"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const detailsOf = (c: BlogPhotoCandidate): TechDetails => ((c.techDetails ?? {}) as TechDetails);

export const photoFilter: StageHandler = async (ctx) => {
  const { post, recipe } = ctx;
  const ps = recipe.photoSearch;
  const slots = await prisma.blogImageSlot.findMany({ where: { postId: post.id } });
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const cfgBySlot = new Map(slots.map((s) => [s.id, searchCfgFor(ps, slotOrientation(s))]));

  const accepted = await prisma.blogPhotoCandidate.findMany({ where: { postId: post.id, status: { in: PASSED_STATUSES } }, select: { slotId: true, sha256: true, phash: true } });
  const localSha = new Set(accepted.map((r) => r.sha256).filter((s): s is string => !!s));
  const localPhash: string[] = accepted.map((r) => r.phash).filter((p): p is string => !!p);
  const passedBySlot = new Map<string, number>();
  for (const a of accepted) passedBySlot.set(a.slotId, (passedBySlot.get(a.slotId) ?? 0) + 1);
  const nearDuplicateOf = (ph?: string | null) => !!ph && localPhash.some((p) => phashDistance(p, ph) <= NEAR_DUPLICATE_DISTANCE);

  let batchPassed = 0, batchRejected = 0, postponed = 0;
  const reasons: Record<string, number> = {};
  const bump = (r: string) => { const k = r.split(":")[0].split("(")[0].trim(); reasons[k] = (reasons[k] || 0) + 1; };

  const reject = async (c: BlogPhotoCandidate, reason: string, extra: { sha256?: string | null; phash?: string | null; details?: TechDetails } = {}) => {
    batchRejected++;
    bump(reason);
    await prisma.blogPhotoCandidate.update({
      where: { id: c.id },
      data: { status: "rejected", rejectStage: "filter", rejectReason: reason.slice(0, 1000), sha256: extra.sha256 ?? c.sha256, phash: extra.phash ?? c.phash, ...(extra.details ? { techDetails: extra.details as object } : {}) },
    });
    await removePath(candidateRel(post.id, c.id)).catch(() => {});
    await removePath(candidateThumbRel(post.id, c.id)).catch(() => {});
  };

  const processOne = async (c: BlogPhotoCandidate) => {
    const cfg = cfgBySlot.get(c.slotId);
    if (!cfg) return reject(c, "слот удалён");
    const prev = detailsOf(c);
    const attempt = (prev.attempt ?? 0) + 1;
    if (attempt > MAX_ATTEMPTS) return reject(c, `источник не отдал файл после ${MAX_ATTEMPTS} попыток`);
    await prisma.blogPhotoCandidate.update({ where: { id: c.id }, data: { techDetails: { ...prev, attempt, retryAfter: undefined } as object } });

    const domain = c.domain || hostOf(c.pageUrl) || hostOf(c.url) || "";
    const blocked = isBlockedDomain(domain, cfg.exclude_domains);
    if (blocked) return reject(c, `запрещённый источник (${blocked})`);
    const catalogue = catalogueSourceSignal({ sourceDomain: domain, sourcePageUrl: c.pageUrl, imageUrl: c.url, title: c.title });
    if (catalogue.reject) return reject(c, catalogue.reason || "каталожная карточка");

    let dl: DownloadResult;
    try {
      dl = await downloadImage([c.url, c.thumbUrl], { signal: ctx.signal });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      dl = { ok: false as const, reason: `недоступно: ${(e as Error).message.slice(0, 80)}`, status: 0, contentType: "" };
    }
    if (!dl.ok) {
      if (isSoftFailure(dl.reason) && attempt < MAX_ATTEMPTS) {
        postponed++;
        await prisma.blogPhotoCandidate.update({ where: { id: c.id }, data: { rejectReason: `отложено: ${dl.reason.slice(0, 60)} (попытка ${attempt})`, techDetails: { ...prev, attempt, retryAfter: Date.now() + POSTPONE_MS } as object } });
        return;
      }
      return reject(c, dl.reason);
    }
    const bytes = dl.bytes;
    const fp = sha256(bytes);
    if (localSha.has(fp)) return reject(c, "дубликат внутри статьи", { sha256: fp });
    localSha.add(fp);
    const unreserve = () => localSha.delete(fp);

    const dims = (await imageDims(bytes)) || (c.width && c.height ? { width: c.width, height: c.height, format: "" } : null);
    const sizeIssue = dims ? sizeVerdict(dims.width, dims.height, cfg) : null;
    if (sizeIssue) { unreserve(); return reject(c, sizeIssue, { sha256: fp }); }
    const orientIssue = dims ? orientationVerdict(dims.width, dims.height, cfg) : null;
    if (orientIssue) { unreserve(); return reject(c, orientIssue, { sha256: fp }); }

    const vision = await inspectPhotoBytes(bytes);
    const details: TechDetails = {
      sharpness: vision.sharpness ?? null, contrast: vision.stats?.contrast ?? null, colorfulness: vision.stats?.colorfulness ?? null, brightness: vision.stats?.brightness ?? null,
      decoded: vision.decoded, usedThumbnail: dl.usedThumbnail, format: dims?.format || dl.contentType, attempt,
    };
    if (vision.reject) { unreserve(); return reject(c, vision.reason || "брак по пикселям", { sha256: fp, phash: vision.phash ?? null, details }); }
    if (nearDuplicateOf(vision.phash)) { unreserve(); return reject(c, "почти такой же кадр уже есть", { sha256: fp, phash: vision.phash ?? null, details }); }
    if (vision.phash) localPhash.push(vision.phash);

    const fileRel = candidateRel(post.id, c.id);
    const thumbRel = candidateThumbRel(post.id, c.id);
    await writeFileAtomic(fileRel, bytes);
    try { await writeFileAtomic(thumbRel, await makeThumb(bytes)); } catch (e) { ctx.log(`thumb failed for ${c.id}: ${(e as Error).message}`); }
    const techScore = techQualityScore({ width: dims?.width ?? c.width, height: dims?.height ?? c.height, sharpness: vision.sharpness ?? null, contrast: vision.stats?.contrast ?? null, colorfulness: vision.stats?.colorfulness ?? null, brightness: vision.stats?.brightness ?? null, domain });
    await prisma.blogPhotoCandidate.update({
      where: { id: c.id },
      data: { status: "downloaded", rejectStage: null, rejectReason: dl.usedThumbnail ? "миниатюра Google" : null, width: dims?.width ?? c.width, height: dims?.height ?? c.height, bytes: bytes.length, sha256: fp, phash: vision.phash ?? null, path: fileRel, thumbPath: thumbRel, techScore: Math.round(techScore), techDetails: details as object },
    });
    passedBySlot.set(c.slotId, (passedBySlot.get(c.slotId) ?? 0) + 1);
    batchPassed++;
  };

  for (;;) {
    // Слоты, где годных ещё мало
    const openSlots = slots.filter((s) => (passedBySlot.get(s.id) ?? 0) < PER_SLOT_PASSED).map((s) => s.id);
    if (!openSlots.length) break;
    const found = await prisma.blogPhotoCandidate.findMany({ where: { postId: post.id, status: "found", slotId: { in: openSlots } }, orderBy: [{ position: "asc" }], take: BATCH * 4 });
    if (!found.length) break;
    const now = Date.now();
    const ready = found.filter((c) => !((detailsOf(c).retryAfter ?? 0) > now)).slice(0, BATCH);
    if (!ready.length) {
      const wake = Math.min(...found.map((c) => detailsOf(c).retryAfter ?? now)) - now;
      await ctx.tick(`Фильтр: ждём повтор ${found.length} отложенных`);
      await sleep(Math.max(250, Math.min(wake, POSTPONE_MS)));
      continue;
    }
    await Promise.all(ready.map((c) => processOne(c)));
    await ctx.tick(`Фильтр: прошло ${batchPassed}, отбраковано ${batchRejected}`);
  }

  const perSlot = Object.fromEntries(slots.map((s) => [s.key, passedBySlot.get(s.id) ?? 0]));
  const details = { batchPassed, batchRejected, postponed, rejectReasons: reasons, perSlot };
  const emptyRequired = slots.filter((s) => s.required && !(passedBySlot.get(s.id) ?? 0) && !s.chosenPhotoId);
  if (emptyRequired.length && slots.every((s) => !(passedBySlot.get(s.id) ?? 0))) {
    void slotById;
    return { fatal: `После технического фильтра не осталось ни одного фото (отбраковано ${batchRejected}: ${Object.entries(reasons).map(([k, v]) => `${k} — ${v}`).join(", ") || "причины не записаны"})`, details };
  }
  return { summary: `Фильтр: годных ${batchPassed}, отбраковано ${batchRejected}, отложено ${postponed}; по слотам: ${Object.entries(perSlot).map(([k, v]) => `${k} ${v}`).join(", ")}`, details };
};
