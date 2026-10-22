/**
 * Этап `photo_select`: на каждый слот — лучший одобренный кадр (aiScore, затем techScore) с учётом уникальности между
 * постами (BlogPhotoFingerprint: sha256/URL за 30 дней; uniqueMode strict — только свежие, soft — свежие, потом повторы)
 * и без одинаковых кадров внутри поста (sha256/phash). Файлы статьи — JPEG ≤1600 px + миниатюра; строки BlogPhoto
 * (position: hero=1, секции по порядку, closing последним); у кандидатов chosen/reserve; отпечатки; чистка файлов отклонённых.
 * Пустой обязательный слот (hero) — фатальная ошибка с подсказкой; пустые необязательные — статья выходит без них.
 * Идемпотентно: прежние BlogPhoto пересоздаются (кроме исключённых модератором, которые не трогаем? — нет: сборка идёт заново).
 */
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { prisma } from "@/lib/db";
import { Prisma, type BlogImageSlot, type BlogPhotoCandidate } from "@prisma/client";
import { absPath, makeThumb, photoRel, photoThumbRel, postDir, publicUrl, purgeCandidateFiles, removePath, toWpJpeg, writeFileAtomic } from "@/lib/blog/storage";
import { phashDistance } from "@/lib/articles/photo/vision";
import { buildCaption } from "@/lib/articles/photo/caption";
import type { StageHandler } from "./index";

const NEAR_DUPLICATE = 10;
const FINGERPRINT_DAYS = 30;
const RESERVE_PER_SLOT = 3;

type Usage = { count: number; sameSite: boolean };

export const photoSelect: StageHandler = async (ctx) => {
  const { post, recipe } = ctx;
  const ps = recipe.photoSearch;
  const slots = await prisma.blogImageSlot.findMany({ where: { postId: post.id }, orderBy: { createdAt: "asc" } });
  if (!slots.length) return { next: "outline", summary: "Нет слотов — возврат к плану" };

  // Порядок в статье: hero, секции по позиции, closing.
  const ordered = [...slots].sort((a, b) => orderKey(a) - orderKey(b));
  const pool = await prisma.blogPhotoCandidate.findMany({ where: { postId: post.id, status: { in: ["keep", "chosen", "reserve"] } }, orderBy: [{ aiScore: "desc" }, { techScore: "desc" }] });
  const bySlot = new Map<string, BlogPhotoCandidate[]>();
  for (const c of pool) bySlot.set(c.slotId, [...(bySlot.get(c.slotId) ?? []), c]);

  // Уникальность между постами команды (как у статей; окно 30 дней)
  const since = new Date(Date.now() - FINGERPRINT_DAYS * 86_400_000);
  const shas = [...new Set(pool.map((c) => c.sha256).filter((v): v is string => !!v))];
  const urls = [...new Set(pool.map((c) => c.url))];
  const prior = shas.length || urls.length
    ? await prisma.blogPhotoFingerprint.findMany({ where: { teamId: post.teamId, createdAt: { gte: since }, OR: [{ postId: null }, { postId: { not: post.id } }], AND: [{ OR: [...(shas.length ? [{ sha256: { in: shas } }] : []), ...(urls.length ? [{ sourceUrl: { in: urls } }] : [])] }] }, select: { sha256: true, sourceUrl: true, siteId: true } })
    : [];
  const usageOf = (c: BlogPhotoCandidate): Usage => {
    const rows = prior.filter((p) => (c.sha256 && p.sha256 === c.sha256) || p.sourceUrl === c.url);
    return { count: rows.length, sameSite: rows.some((p) => p.siteId === post.siteId) };
  };

  // Прежний отбор пересобирается
  const existing = await prisma.blogPhoto.count({ where: { postId: post.id } });
  if (existing) {
    await prisma.blogPhoto.deleteMany({ where: { postId: post.id } });
    await removePath(`${postDir(post.id)}/photos`).catch(() => {});
    await prisma.blogPhotoCandidate.updateMany({ where: { postId: post.id, status: { in: ["chosen", "reserve"] } }, data: { status: "keep" } });
    ctx.log(`удалён прежний отбор: ${existing} фото`);
  }

  const chosenSha = new Set<string>();
  const chosenPhash: string[] = [];
  const picks: Array<{ slot: BlogImageSlot; c: BlogPhotoCandidate; usage: Usage }> = [];
  const empty: string[] = [];
  for (const slot of ordered) {
    const cands = (bySlot.get(slot.id) ?? []).filter((c) => !(c.sha256 && chosenSha.has(c.sha256)) && !(c.phash && chosenPhash.some((p) => phashDistance(p, c.phash!) <= NEAR_DUPLICATE)));
    const scored = cands.map((c) => ({ c, usage: usageOf(c) }));
    const fresh = scored.filter((x) => x.usage.count === 0);
    const reused = scored.filter((x) => x.usage.count > 0 && !x.usage.sameSite);
    const sameSite = scored.filter((x) => x.usage.sameSite);
    let order = ps.uniqueMode === "strict" ? fresh : ps.uniqueMode === "off" ? scored : [...fresh, ...reused, ...sameSite];
    // Главное фото — вертикальное (формат пина 2:3), если такое есть среди одобренных; квадрат и горизонталь — только запасом.
    if (slot.key === "hero" && recipe.params.images.heroOrientation === "tall") {
      const tall = (x: { c: BlogPhotoCandidate }) => !!(x.c.width && x.c.height && x.c.height / x.c.width >= 1.15);
      order = [...order.filter(tall), ...order.filter((x) => !tall(x))];
    }
    const best = order[0];
    if (!best) { empty.push(slot.key); continue; }
    picks.push({ slot, ...best });
    if (best.c.sha256) chosenSha.add(best.c.sha256);
    if (best.c.phash) chosenPhash.push(best.c.phash);
  }

  const hero = slots.find((s) => s.key === "hero");
  if (hero && !picks.some((p) => p.slot.id === hero.id)) {
    // Запасной главный кадр: лучший уже выбранный кадр секции (приятный — appeal ≥ 7, вертикальный — первым);
    // секция остаётся без фото. Так статья по «бытовой» теме с узкой выдачей не падает целиком.
    const appeal = (c: BlogPhotoCandidate) => Number(((c.aiBreakdown ?? {}) as { appeal?: number }).appeal ?? 0);
    const tallOf = (c: BlogPhotoCandidate) => (c.width && c.height && c.height / c.width >= 1.15 ? 1 : 0);
    const byScore = (a: { c: BlogPhotoCandidate }, b: { c: BlogPhotoCandidate }) => tallOf(b.c) - tallOf(a.c) || (b.c.aiScore ?? 0) - (a.c.aiScore ?? 0);
    const donor = picks.filter((p) => p.slot.key !== "closing" && appeal(p.c) >= 7).sort(byScore)[0]
      ?? picks.filter((p) => appeal(p.c) >= 7).sort(byScore)[0];
    if (donor) {
      ctx.log(`hero: годного кадра нет — главным ставим лучший кадр слота ${donor.slot.key} (балл ${donor.c.aiScore}), слот ${donor.slot.key} без фото`);
      empty.push(donor.slot.key);
      donor.slot = hero;
    }
  }
  if (hero && !picks.some((p) => p.slot.id === hero.id)) {
    const why = (bySlot.get(hero.id) ?? []).length ? "все одобренные кадры уже использованы на других статьях" : "ни один кадр не прошёл оценку";
    return { fatal: `Нет главного фото (hero): ${why}. Измените запрос слота «hero» в карточке статьи (вкладка «Фото») и повторите этап «Поиск фото», либо смягчите порог оценки в рецепте.` };
  }

  // Файлы статьи и строки BlogPhoto
  await ctx.tick("Файлы фото статьи");
  const rows: Prisma.BlogPhotoCreateManyInput[] = [];
  let position = 0;
  for (const p of picks) {
    let bytes: Buffer | null = p.c.path ? await readFile(absPath(p.c.path)).catch(() => null) : null;
    if (!bytes) { ctx.log(`${p.slot.key}: файла кандидата нет — слот пропущен`); empty.push(p.slot.key); continue; }
    const photoId = randomUUID();
    const jpeg = await toWpJpeg(bytes);
    const path = photoRel(post.id, photoId);
    const thumbPath = photoThumbRel(post.id, photoId);
    await writeFileAtomic(path, jpeg.bytes);
    await writeFileAtomic(thumbPath, await makeThumb(jpeg.bytes));
    position++;
    rows.push({
      id: photoId, postId: post.id, slotKey: p.slot.key, candidateId: p.c.id, position, path, thumbPath, publicUrl: publicUrl(path),
      sourceUrl: p.c.url.slice(0, 2000), sourcePageUrl: (p.c.pageUrl || "").slice(0, 2000), sourceDomain: p.c.domain || "",
      width: jpeg.width, height: jpeg.height, sha256: p.c.sha256, phash: p.c.phash,
      altText: (p.c.aiDescription || p.slot.query).slice(0, 300),
      caption: buildCaption({ captionMode: ps.captionMode, captionTemplate: ps.captionTemplate }, p.c.domain || null, p.c.pageUrl || null) ?? "",
      description: p.c.aiDescription, fileName: `${position}-${(p.c.sha256 || "x").slice(0, 12)}.jpg`, aiScore: p.c.aiScore,
    });
    await prisma.blogImageSlot.update({ where: { id: p.slot.id }, data: { chosenPhotoId: photoId, status: "chosen" } });
  }
  if (rows.length) await prisma.blogPhoto.createMany({ data: rows });
  for (const key of empty) await prisma.blogImageSlot.updateMany({ where: { postId: post.id, key }, data: { status: "empty", chosenPhotoId: null } });

  // Статусы кандидатов: выбранные — chosen; у каждого слота до RESERVE_PER_SLOT резервных; остальные одобренные — тоже reserve (для замены в проверке)
  const chosenIds = picks.map((p) => p.c.id);
  if (chosenIds.length) await prisma.blogPhotoCandidate.updateMany({ where: { id: { in: chosenIds } }, data: { status: "chosen" } });
  await prisma.blogPhotoCandidate.updateMany({ where: { postId: post.id, status: "keep" }, data: { status: "reserve" } });
  void RESERVE_PER_SLOT;

  // Отпечатки
  await prisma.blogPhotoFingerprint.deleteMany({ where: { postId: post.id } });
  if (ps.uniqueMode !== "off" && rows.length) {
    await prisma.blogPhotoFingerprint.createMany({ data: rows.map((r) => ({ teamId: post.teamId, siteId: post.siteId, postId: post.id, sha256: r.sha256 ?? null, phash: r.phash ?? null, sourceUrl: String(r.sourceUrl ?? "").slice(0, 2000) })) });
  }
  // Файлы отклонённых кандидатов не нужны
  const keepIds = new Set((await prisma.blogPhotoCandidate.findMany({ where: { postId: post.id, status: { in: ["chosen", "reserve"] } }, select: { id: true } })).map((c) => c.id));
  await purgeCandidateFiles(post.id, keepIds).catch(() => {});

  const reusedCount = picks.filter((p) => p.usage.count > 0).length;
  const details = { selected: rows.length, slots: slots.length, empty, reused: reusedCount, uniqueMode: ps.uniqueMode, picks: picks.map((p) => ({ slot: p.slot.key, score: p.c.aiScore, domain: p.c.domain })) };
  return { summary: `Выбрано ${rows.length} из ${slots.length} фото${empty.length ? ` (без фото: ${empty.join(", ")})` : ""}${reusedCount ? `, повторов ${reusedCount}` : ""}`, details };
};

function orderKey(s: BlogImageSlot): number {
  if (s.key === "hero") return 0;
  if (s.key === "closing") return 100_000;
  return (s.sectionPosition ?? 50_000) + 1;
}
