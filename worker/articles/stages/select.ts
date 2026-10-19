/**
 * Этап select — «Отбор фото» (оригинал: stage-photo-select/index.ts, шаг 14).
 *
 * Из одобренных кандидатов (keep) собираем N лучших: итоговый ранг `finalPhotoRank` (сравнение кадров + качество +
 * тех. балл + тема), уникальность между сайтами (`ArtPhotoFingerprint`, режим `uniqueMode`), три сеточных vision-вызова
 * (A — слабые из лучших, B — сильные из резерва, final — общий порядок; эталонов `photo_reference_set` нет — 08-plan §2),
 * раскладка по осям профиля ниши (`orderPhotosForVariety`) и разнесение похожих по phash (топ-5 не трогаем).
 * Затем — файлы статьи (`photos/<id>.jpg` через toWpJpeg + миниатюра), строки `ArtPhoto` (position 1..N, подпись источника
 * по рецепту), статусы кандидатов selected/reserve, отпечатки, удаление оригиналов невошедших кандидатов.
 *
 * Нехватка (< min(photoCount, 15)): добор через `search` (`cursor.topup`, пока `cursor.topups` < 6 и `selectCycles` ≤ 7);
 * кольца исчерпаны → при модерации фото и chosen > 0 сохраняем что есть и ждём PHOTO_REVIEW («Мало фото»), иначе
 * WAITING_FOR_PHOTOS. Идемпотентно: повтор удаляет прежние ArtPhoto/файлы и пересобирает по кандидатам.
 */
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { prisma } from "@/lib/db";
import { Prisma, type ArtPhotoCandidate } from "@prisma/client";
import type { ContentPart } from "@/lib/articles/ai";
import { stageModel } from "@/lib/articles/prompts";
import { absPath, articleDir, makeThumb, photoRel, photoThumbRel, publicUrl, purgeCandidateOriginals, removePath, toWpJpeg, writeFileAtomic } from "@/lib/articles/storage";
import { MIN_PHOTOS, PHOTO_LOOPS, type ArticleCursor } from "@/lib/articles/types";
import { getNicheProfile, specializeProfile, type NicheProfile } from "@/lib/articles/photo/profile";
import { orderPhotosForVariety, photoTraits, type DiversityInput } from "@/lib/articles/photo/diversity";
import { NEAR_DUPLICATE_DISTANCE, loadPhotoUsage, recordPhotoFingerprints, type UniqueMode } from "@/lib/articles/photo/fingerprints";
import { buildCaption } from "@/lib/articles/photo/caption";
import { VisionImageCache, imageContent, listFromJson, mustRethrow, numberedTitles, phashDistance, resolveTrendBrief, trendBriefText, visionJson } from "@/lib/articles/photo/vision";
import { candidateRank, readBreakdown, topicOf } from "@/lib/articles/photo/ranking";
import type { ArtStageHandler, ArtStageResult, ArtStageCtx } from "./index";

/** сколько лучших кадров модель видит одной сеткой на финальном отборе (оригинал: :58) */
const GRID_SIZE = 30;
/** верхняя граница списка A (оригинал: :520 — min(45, max(GRID_SIZE, needed))) */
const GRID_A_MAX = 45;
/** параллельных копирований файлов (оригинал: :620 DOWNLOAD_CONCURRENCY) */
const STORE_CONCURRENCY = 6;
/** первые N по рейтингу не сдвигаем при разнесении похожих (оригинал: :37 TOP_FIXED) */
const TOP_FIXED = 5;
/** статусы «одобрен» — после прежнего отбора keep делится на selected/reserve */
const KEEP_STATUSES = ["keep", "selected", "reserve"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Строка пула отбора: кандидат + поля в терминах оригинала для photoTraits/orderPhotosForVariety. */
type PoolRow = DiversityInput & {
  id: string;
  c: ArtPhotoCandidate;
  phash: string | null;
  final_rank: number;
  usedCount: number;
  usedOldest: string;
  sameSite: boolean;
};

/**
 * Разнесение визуально похожих кадров: похожий (phash ≤ 10) не удаляется, а сдвигается дальше по списку
 * (оригинал: :36-56). Топ-5 по рейтингу не трогаем.
 */
function spreadSimilarPhotos<T extends { phash: string | null }>(photos: T[]): T[] {
  if (photos.length <= TOP_FIXED + 1) return photos;
  const out = photos.slice(0, TOP_FIXED);
  const rest = photos.slice(TOP_FIXED);
  while (rest.length) {
    const prev = out[out.length - 1];
    let idx = 0;
    if (prev?.phash) {
      for (let k = 0; k < rest.length; k++) {
        const cand = rest[k];
        if (!cand.phash || phashDistance(prev.phash, cand.phash) > NEAR_DUPLICATE_DISTANCE) {
          idx = k;
          break;
        }
      }
    }
    out.push(rest.splice(idx, 1)[0]);
  }
  return out;
}

type GridStep = { asked: number; picked: string[]; notes: Record<string, string>; costUsd: number; error: string | null };

/** Один запрос «сеткой»: модель видит набор разом и возвращает список номеров (оригинал: :83-142). */
async function gridAsk(ctx: ArtStageCtx, cache: VisionImageCache, model: string | undefined, rows: PoolRow[], system: string, max: number, purpose: string): Promise<GridStep> {
  const step: GridStep = { asked: 0, picked: [], notes: {}, costUsd: 0, error: null };
  try {
    const inlined: Array<{ row: PoolRow; part: ContentPart }> = [];
    for (const row of rows) {
      const img = await cache.get(row.c, "thumb");
      if (img) inlined.push({ row, part: imageContent(img) });
    }
    step.asked = inlined.length;
    if (inlined.length < 2) {
      step.error = "мало загруженных превью";
      return step;
    }
    const parts: ContentPart[] = [
      { type: "text", text: `${inlined.length} photos (numbered in order):\n` + numberedTitles(inlined.map((x) => x.row.c)) },
      ...inlined.map((x) => x.part),
    ];
    // оригинал: temperature 0.1, maxTokens 1500, timeout 120 с (:111-115)
    const r = await visionJson(ctx.ai, { model, system, parts, temperature: 0.1, maxTokens: 1500, timeoutMs: 120_000 });
    step.costUsd = r.costUsd;
    const list = listFromJson(r.json, ["pick", "drop", "order"]);
    const seen = new Set<string>();
    for (const it of list) {
      if (step.picked.length >= max) break;
      const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
      const n = Number(typeof it === "number" ? it : o.n);
      if (!Number.isFinite(n) || n < 1 || n > inlined.length) continue;
      const id = inlined[n - 1].row.id;
      if (seen.has(id)) continue;
      seen.add(id);
      step.picked.push(id);
      const why = String(o.why || "").trim();
      if (why) step.notes[id] = why.slice(0, 120);
    }
    if (!step.picked.length) step.error = `модель ничего не выбрала: ${(r.text || "").slice(0, 300)}`;
  } catch (e) {
    if (mustRethrow(e, ctx.signal)) throw e;
    step.error = `ошибка: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    ctx.log(`${purpose} пропущен: ${step.error}`);
  }
  return step;
}

type GridInfo = {
  priority: Map<string, number>;
  a: GridStep | null;
  b: GridStep | null;
  final: GridStep | null;
  promoted: string[];
  kept_weak: string[];
  dropped: string[];
  skipped: string | null;
  costUsd: number;
};

/**
 * Отбор «сеткой» в три шага (оригинал: :152-245): A — слабые среди лучших; B — сильные из резерва;
 * финал — общий порядок слабых A и сильных B. Возвращает приоритет id (меньше — раньше); число фото не меняется.
 */
async function gridPass(ctx: ArtStageCtx, cache: VisionImageCache, model: string | undefined, opts: { topic: string; needed: number; listA: PoolRow[]; listB: PoolRow[]; trend: string }): Promise<GridInfo> {
  const { topic, needed, listA, listB } = opts;
  const trendLine = opts.trend ? `\n${opts.trend}\n` : "";
  const out: GridInfo = { priority: new Map(), a: null, b: null, final: null, promoted: [], kept_weak: [], dropped: [], skipped: null, costUsd: 0 };
  if (listA.length < 4) {
    out.skipped = "мало кадров для сетки";
    return out;
  }
  const spareA = Math.max(0, listA.length - needed);
  const dropCount = Math.min(Math.floor(listA.length / 2), Math.max(spareA, listB.length ? Math.ceil(listA.length * 0.2) : 0));
  if (dropCount < 1) {
    out.skipped = "нет запаса сверх нужного";
    return out;
  }

  // оригинал: :172-183 (дословно)
  const head = `You are the photo editor for a Pinterest article about "${topic}". Compare photos against each other, not against an absolute scale.${trendLine}`;
  const aSystem = `${head}
Pick EXACTLY ${dropCount} photos to DROP — the weakest in THIS set:
- FIRST: out of trend — looks match the DATED list or an older era (shape, cut, colour, styling, photo style)
- less scroll-stopping or less aspirational than the rest
- generic, catalogue-like, cluttered, dark or badly lit
- true retail catalogue presentation: product-card pose/crop, SKU, price, size variants or isolated listing styling
- clear AI-generation artifacts: fused fingers, impossible garment geometry, repeated details, plastic textures, warped background or impossible shadows
- IMPORTANT: a white or plain studio background alone is acceptable and is NOT catalogue evidence
- near-repeats of another photo in the set (drop the worse one)
- subject hard to read in a small vertical card; visibly off-topic for "${topic}"
Return ONLY JSON: {"drop":[{"n":7,"why":"max 8 words"}]}`;
  out.a = await gridAsk(ctx, cache, model, listA, aSystem, dropCount, "сетка A");
  if (!out.a.picked.length) {
    // модель иногда отдаёт пустой ответ — одна повторная попытка с паузой (оригинал: :185-191)
    await sleep(3000);
    const retry = await gridAsk(ctx, cache, model, listA, aSystem, dropCount, "сетка A (повтор)");
    retry.costUsd += out.a.costUsd;
    out.a = retry;
  }
  const weak = out.a.picked;
  if (!weak.length) {
    out.skipped = out.a.error;
    out.costUsd = out.a.costUsd;
    return out;
  }
  const weakSet = new Set(weak);
  const keptA = listA.filter((p) => !weakSet.has(p.id));

  let ranked: string[] = [];
  if (listB.length >= 2) {
    const k = Math.min(listB.length, weak.length);
    // оригинал: :202-205
    out.b = await gridAsk(ctx, cache, model, listB, `${head}
These are reserve photos. Pick the ${k} STRONGEST — the most save-worthy, fresh, on-topic pins in THIS set.
Avoid true retail catalogue presentation and clear AI-generation artifacts. A white or plain studio background alone is acceptable.
Avoid near-repeats of each other. Return ONLY JSON: {"pick":[{"n":3,"why":"max 8 words"}]} best first.`, k, "сетка B");
    const strong = out.b.picked;
    if (strong.length) {
      const byId = new Map([...listA, ...listB].map((p) => [p.id, p]));
      const rows = [...weak, ...strong].map((id) => byId.get(id)).filter((p): p is PoolRow => !!p);
      // оригинал: :213-216
      out.final = await gridAsk(ctx, cache, model, rows, `${head}
Order ALL these photos from the best pin to the weakest. Every number exactly once.
Put true catalogue listings and photos with clear AI artifacts last. Do not penalize a white background by itself.
Return ONLY JSON: {"order":[{"n":2,"why":"max 8 words"}]}`, rows.length, "сетка final");
      if (out.final.picked.length) {
        const got = new Set(out.final.picked);
        // забытые моделью: сильные из B раньше слабых из A
        ranked = [...out.final.picked, ...strong.filter((id) => !got.has(id)), ...weak.filter((id) => !got.has(id))];
      }
    }
  }

  // оригинал: :226-242
  let i = 0;
  for (const p of keptA) out.priority.set(p.id, i++);
  if (ranked.length) {
    for (const id of ranked) out.priority.set(id, i++);
    const slots = Math.max(0, needed - keptA.length);
    const used = ranked.slice(0, slots);
    out.promoted = used.filter((id) => !weakSet.has(id));
    out.kept_weak = used.filter((id) => weakSet.has(id));
    out.dropped = ranked.slice(slots).filter((id) => weakSet.has(id));
  } else if (spareA > 0) {
    for (const id of weak) out.priority.set(id, 1_000_000 + i++);
    out.dropped = weak;
  } else {
    for (const id of weak) out.priority.set(id, i++);
    out.kept_weak = weak;
  }
  out.costUsd = (out.a?.costUsd || 0) + (out.b?.costUsd || 0) + (out.final?.costUsd || 0);
  return out;
}

/** Скачивание оригинала заново, если файл кандидата уже удалён (оригинал: :634-646 — UA ZewexBot, 30 с). */
async function fetchOriginal(urls: Array<string | null | undefined>): Promise<Buffer | null> {
  for (const url of [...new Set(urls.filter(Boolean))] as string[]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "Mozilla/5.0 (compatible; ZewexBot/1.0)" } });
      if (!r.ok) continue;
      const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
      if (!mime.startsWith("image/")) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 2000) return buf;
    } catch {
      /* следующий url */
    }
  }
  return null;
}

type StoredPhoto = { row: PoolRow; photoId: string; path: string; thumbPath: string; width: number; height: number };

export const select: ArtStageHandler = async (ctx) => {
  const { article, recipe } = ctx;
  const cfg = recipe.photoSearch;
  const niche = recipe.nicheCode;
  const subniche = recipe.subnicheCode ?? null;
  // оригинал: :288-291 needed = max(1, count_outfits || 20); :570-571 minAcceptable = min(needed, 15)
  const needed = Math.max(1, article.photoCount || 20);
  const minAcceptable = Math.min(needed, MIN_PHOTOS);
  const uniqueMode: UniqueMode = cfg.uniqueMode === "strict" || cfg.uniqueMode === "off" ? cfg.uniqueMode : "soft";
  const searchKeyword = topicOf(article);
  // оригинал: :458-460 — тема для раскладки/профиля из всех полей ключа
  const topicText = `${article.focusKeyword || ""} ${article.keyword || ""} ${article.seoKeyword || ""}`.trim();
  const profile: NicheProfile = specializeProfile(await getNicheProfile(niche, subniche), topicText);
  const model = stageModel(recipe, "rp_photo_rate");

  // оригинал: :306-315 — одобренные, по ai_score, до 500
  const poolRaw = await prisma.artPhotoCandidate.findMany({
    where: { articleId: article.id, status: { in: KEEP_STATUSES } },
    orderBy: { aiScore: "desc" },
    take: 500,
  });
  await ctx.tick(`Отбор ${needed} фото из ${poolRaw.length} одобренных`);

  // ── Идемпотентность: прежний результат отбора и всё, что на нём построено, пересобираем (оригинал: :368-384, :616) ──
  const existingPhotos = await prisma.artPhoto.count({ where: { articleId: article.id } });
  if (existingPhotos) {
    await prisma.artPhoto.deleteMany({ where: { articleId: article.id } });
    await removePath(`${articleDir(article.id)}/photos`).catch(() => {});
    ctx.log(`удалён прежний отбор: ${existingPhotos} фото`);
  }
  const existingSections = await prisma.artSection.count({ where: { articleId: article.id } });
  if (existingSections) {
    await prisma.artSection.deleteMany({ where: { articleId: article.id } });
    await prisma.article.update({ where: { id: article.id }, data: { plan: Prisma.DbNull, introHtml: null, outroHtml: null, html: null } });
    ctx.log(`сброшены ${existingSections} секций и план: фото пересобираются`);
  }

  // ── Ранг и уникальность между сайтами (оригинал: :319-323, :386-445) ──
  const pool: PoolRow[] = poolRaw
    .map((c) => ({
      id: c.id,
      c,
      phash: c.phash,
      title: c.title,
      ai_facts: c.aiFacts,
      ai_description: c.aiDescription,
      ai_reason: readBreakdown(c).reason,
      ai_score: c.aiScore,
      final_rank: candidateRank(c),
      usedCount: 0,
      usedOldest: "",
      sameSite: false,
    }))
    .sort((a, b) => b.final_rank - a.final_rank);
  if (pool.length) {
    const usage = await loadPhotoUsage({
      teamId: article.teamId,
      siteId: article.siteId,
      articleId: article.id,
      keywords: [article.keyword, article.focusKeyword, searchKeyword],
      candidates: poolRaw.map((c) => ({ id: c.id, sha256: c.sha256, phash: c.phash, url: c.url })),
    });
    for (const p of pool) {
      const u = usage.get(p.id);
      if (u) Object.assign(p, u);
    }
  }

  // сначала совсем неиспользованные (лучшие по рейтингу), затем самые давние повторы (оригинал: :447-456, :506-511)
  const fresh = pool.filter((p) => p.usedCount === 0).sort((a, b) => b.final_rank - a.final_rank);
  const reused = pool
    .filter((p) => p.usedCount > 0 && !p.sameSite)
    .sort((a, b) => a.usedCount - b.usedCount || a.usedOldest.localeCompare(b.usedOldest) || b.final_rank - a.final_rank);
  const sameSiteReused = pool
    .filter((p) => p.usedCount > 0 && p.sameSite)
    .sort((a, b) => a.usedOldest.localeCompare(b.usedOldest) || b.final_rank - a.final_rank);

  // Внутри статьи не берём почти одинаковые кадры (оригинал: :487-504)
  const dims = (profile.diversity_axes || []).map((ax) => ax.key);
  const takeDistinct = (candidates: PoolRow[], limit: number, acc: PoolRow[]): PoolRow[] => {
    for (const c of candidates) {
      if (acc.length >= limit) break;
      const ct = photoTraits(c, profile);
      const tooSimilar = acc.some((a) => {
        if (c.phash && a.phash && phashDistance(a.phash, c.phash) <= NEAR_DUPLICATE_DISTANCE) return true;
        const at = photoTraits(a, profile);
        const known = dims.filter((d) => ct[d] && at[d]);
        return known.length >= 3 && known.every((d) => ct[d] === at[d]);
      });
      if (!tooSimilar) acc.push(c);
    }
    return acc;
  };

  // ── Финальный отбор «сеткой»: A (лучшие) → B (резерв) → финал (оригинал: :513-548) ──
  const allowReused = uniqueMode !== "strict";
  const allowSameSite = uniqueMode === "soft" || uniqueMode === "off";
  const orderedPool = [...fresh, ...(allowReused ? reused : []), ...(allowSameSite ? sameSiteReused : [])];
  const listA = takeDistinct(orderedPool, Math.min(GRID_A_MAX, Math.max(GRID_SIZE, needed)), []);
  const aIds = new Set(listA.map((p) => p.id));
  const listB = takeDistinct(orderedPool.filter((p) => !aIds.has(p.id)), listA.length + GRID_SIZE, [...listA]).filter((p) => !aIds.has(p.id));

  const cache = new VisionImageCache();
  const trend = trendBriefText(resolveTrendBrief(ctx.facts, niche, article.keyword || searchKeyword));
  const gridInfo: GridInfo = pool.length
    ? await gridPass(ctx, cache, model, { topic: searchKeyword, needed, listA, listB, trend })
    : { priority: new Map<string, number>(), a: null, b: null, final: null, promoted: [], kept_weak: [], dropped: [], skipped: "нет одобренных фото", costUsd: 0 };
  if (gridInfo.priority.size) {
    const reorder = (arr: PoolRow[]) => {
      const key = new Map(arr.map((p, idx) => [p.id, gridInfo.priority.get(p.id) ?? 500_000 + idx]));
      arr.sort((x, y) => key.get(x.id)! - key.get(y.id)!);
    };
    reorder(fresh);
    reorder(reused);
    reorder(sameSiteReused);
  }
  await ctx.tick("Отбор фото: раскладка");

  // оригинал: :550-566
  let chosen: PoolRow[] = takeDistinct(fresh, needed, []);
  if (chosen.length < needed && allowReused) chosen = takeDistinct(reused, needed, chosen);
  if (chosen.length < needed) {
    const usedIds = new Set(chosen.map((c) => c.id));
    const rest = [...fresh, ...(allowReused ? reused : []), ...(allowSameSite ? sameSiteReused : [])].filter((p) => !usedIds.has(p.id));
    chosen = chosen.concat(rest.slice(0, needed - chosen.length));
  }

  const gridDetails = {
    size_a: listA.length,
    size_b: listB.length,
    a: gridInfo.a ? { asked: gridInfo.a.asked, picked: gridInfo.a.picked.length, error: gridInfo.a.error } : null,
    b: gridInfo.b ? { asked: gridInfo.b.asked, picked: gridInfo.b.picked.length, error: gridInfo.b.error } : null,
    final: gridInfo.final ? { asked: gridInfo.final.asked, picked: gridInfo.final.picked.length, error: gridInfo.final.error } : null,
    promoted: gridInfo.promoted.length,
    kept_weak: gridInfo.kept_weak.length,
    dropped: gridInfo.dropped.length,
    skipped: gridInfo.skipped,
    costUsd: Math.round(gridInfo.costUsd * 1e6) / 1e6,
  };
  const baseDetails = { needed, minAcceptable, approved: pool.length, fresh: fresh.length, reused: reused.length, sameSite: sameSiteReused.length, uniqueMode, grid: gridDetails };

  // ── Нехватка (оригинал: :568-607 + direct-pipeline:568-585) ──
  let shortage: string | null = null;
  if (chosen.length < minAcceptable) {
    shortage =
      `Недостаточно подходящих фото: отобрано ${chosen.length} из ${needed} ` +
      `(одобрено ИИ ${pool.length}, свободных ${fresh.length}, повторов с других сайтов ${reused.length}, ` +
      `уже использованы на этом сайте ${sameSiteReused.length}). Минимум для публикации — ${minAcceptable} фото.`;
    const topups = Number(ctx.cursor.topups ?? 0);
    const selectCycles = Number(ctx.cursor.selectCycles ?? 0) + 1;
    if (topups < PHOTO_LOOPS.maxTopups && selectCycles <= PHOTO_LOOPS.selectCycles) {
      await ctx.save({ cursor: { ...ctx.cursor, selectCycles, topup: { from: "select", needed: needed - chosen.length, reason: shortage } } });
      return { next: "search", summary: `Отобрано ${chosen.length} из ${needed} — добор фото (круг ${selectCycles}/${PHOTO_LOOPS.selectCycles})`, details: { ...baseDetails, selected: chosen.length } };
    }
    // Кольца исчерпаны. Модератор сам доберёт на модерации фото — сохраняем, что отобрали (оригинал: :572-575 humanReview).
    if (!(article.photoReview && chosen.length > 0)) {
      return { next: { wait: "WAITING_FOR_PHOTOS", note: shortage }, summary: shortage, details: { ...baseDetails, selected: chosen.length } };
    }
  }

  // ── Раскладка (оригинал: :609-614) ──
  chosen = orderPhotosForVariety(chosen, topicText, profile);
  chosen = spreadSimilarPhotos(chosen);

  // ── Файлы статьи: копия кандидата через toWpJpeg + миниатюра, пул из 6 (оригинал: :618-684) ──
  const stored = new Array<StoredPhoto | null>(chosen.length).fill(null);
  let nextIdx = 0;
  const storeWorker = async () => {
    for (;;) {
      const i = nextIdx++;
      if (i >= chosen.length) return;
      const row = chosen[i];
      try {
        let bytes: Buffer | null = row.c.path ? await readFile(absPath(row.c.path)).catch(() => null) : null;
        if (!bytes) bytes = await fetchOriginal([row.c.url, row.c.thumbUrl]);
        if (!bytes) {
          ctx.log(`фото ${i + 1}: нет файла кандидата и не удалось скачать ${row.c.url}`);
          continue;
        }
        const photoId = randomUUID();
        const jpeg = await toWpJpeg(bytes);
        const path = photoRel(article.id, photoId);
        const thumbPath = photoThumbRel(article.id, photoId);
        await writeFileAtomic(path, jpeg.bytes);
        await writeFileAtomic(thumbPath, await makeThumb(jpeg.bytes));
        stored[i] = { row, photoId, path, thumbPath, width: jpeg.width, height: jpeg.height };
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        ctx.log(`фото ${i + 1}: не удалось сохранить: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STORE_CONCURRENCY, chosen.length) }, () => storeWorker()));
  await ctx.tick("Отбор фото: запись");

  // ── Строки ArtPhoto (оригинал: :686-734) ──
  const ready = stored.filter((s): s is StoredPhoto => !!s);
  const rows: Prisma.ArtPhotoCreateManyInput[] = ready.map((s, i) => {
    const c = s.row.c;
    const position = i + 1;
    return {
      id: s.photoId,
      articleId: article.id,
      candidateId: c.id,
      position,
      path: s.path,
      thumbPath: s.thumbPath,
      publicUrl: publicUrl(s.path),
      sourceUrl: c.url.slice(0, 2000),
      sourcePageUrl: (c.pageUrl || "").slice(0, 2000),
      sourceDomain: c.domain || "",
      width: s.width,
      height: s.height,
      sha256: c.sha256,
      phash: c.phash,
      altText: c.title || "",
      caption: buildCaption(cfg, c.domain || null, c.pageUrl || null) ?? "",
      // оригинал: file_name = "<position>-<fp12>.<ext>" (:655-657, :707)
      fileName: `${position}-${(c.sha256 || "x").slice(0, 12)}.jpg`,
      facts: c.aiFacts === null ? Prisma.DbNull : (c.aiFacts as Prisma.InputJsonValue),
      description: c.aiDescription,
      aiScore: c.aiScore,
    };
  });
  if (rows.length) await prisma.artPhoto.createMany({ data: rows });

  // Статусы кандидатов: вошедшие — selected, остальные одобренные — reserve (нужны модерации).
  const selectedIds = ready.map((s) => s.row.c.id);
  if (selectedIds.length) await prisma.artPhotoCandidate.updateMany({ where: { id: { in: selectedIds } }, data: { status: "selected" } });
  await prisma.artPhotoCandidate.updateMany({
    where: { articleId: article.id, status: { in: KEEP_STATUSES }, ...(selectedIds.length ? { id: { notIn: selectedIds } } : {}) },
    data: { status: "reserve" },
  });

  // Отпечатки выбранных фото (оригинал: :723-732, :772-779) + чистка старых (замена cleanup_photo_data)
  const fingerprints = await recordPhotoFingerprints({
    teamId: article.teamId,
    siteId: article.siteId,
    articleId: article.id,
    uniqueMode,
    rows: ready.map((s) => ({ sha256: s.row.c.sha256, phash: s.row.c.phash, sourceUrl: s.row.c.url })),
  });
  // Старые отпечатки не удаляются (решение 2026-10-19: храним все данные); в поиске повторов действует окно cutoffDate.

  // Оригиналы отклонённых кандидатов больше не нужны; одобренные ИИ (selected + reserve) храним — под будущий мешап статей.
  const cands = await prisma.artPhotoCandidate.findMany({ where: { articleId: article.id }, select: { id: true, status: true } });
  await purgeCandidateOriginals(article.id, new Set(cands.filter((c) => KEEP_STATUSES.includes(c.status)).map((c) => c.id)), cands.map((c) => c.id));

  // Фото отобраны — счётчики колец добора больше не нужны (оригинал: direct-pipeline:588-591).
  const cursor: ArticleCursor = { ...ctx.cursor };
  for (const k of ["filterCycles", "rateTopups", "selectCycles", "topup", "rescuePass", "filterPending"]) delete cursor[k];
  await ctx.save({ cursor });

  const reusedCount = ready.filter((s) => s.row.usedCount > 0).length;
  const reserveCount = Math.max(0, pool.length - selectedIds.length);
  const details = { ...baseDetails, selected: rows.length, reusedSelected: reusedCount, reserve: reserveCount, fingerprints, failedToStore: chosen.length - ready.length };
  const summary = `Отобрано ${rows.length} из ${needed} фото (повторов ${reusedCount}, резерв ${reserveCount})`;

  if (shortage || rows.length < minAcceptable) {
    const note = `Мало фото: ${shortage ?? `сохранено ${rows.length} из ${needed}, минимум ${minAcceptable}`}`;
    if (!article.photoReview || rows.length === 0) {
      return { next: { wait: "WAITING_FOR_PHOTOS", note }, summary: note, details };
    }
    return { next: { wait: "PHOTO_REVIEW", note }, summary: `${summary} — ${note}`, details };
  }
  const result: ArtStageResult = { summary, details };
  return result;
};
