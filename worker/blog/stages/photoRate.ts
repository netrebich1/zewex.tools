/**
 * Этап `photo_rate`: vision-оценка кандидатов по слотам. Один промт (из сценария `photo_rate`, иначе встроенный):
 * релевантность описанию слота 0–10, качество 0–10, «настоящее фото» (без коллажа, текста, водяных знаков, ИИ, стока),
 * короткое описание. Балл = 0.6·релевантность + 0.4·качество; keep при verdict keep, relevance ≥ 6, real_photo и балле ≥ minScore.
 * Системная часть промта одинакова для всех постов (кэш провайдера), всё зависящее от поста — первым текстом user.
 * Слот без годных кадров после оценки → ещё один поиск (altQuery), не больше MAX_SLOT_SEARCHES; дальше — слот пустой.
 */
import { prisma } from "@/lib/db";
import { Prisma, type BlogImageSlot, type BlogPhotoCandidate } from "@prisma/client";
import { aiChat, imagePart, type ContentPart } from "@/lib/blog/ai";
import { fillPrompt, resolvePromptOptional, stageModel } from "@/lib/blog/prompts";
import { loadVisionImage, listFromJson, mustRethrow } from "@/lib/articles/photo/vision";
import { parseJsonLenient } from "@/lib/pins/ai/json";
import { AiError } from "@/lib/pins/ai/errors";
import { SLOTS } from "@/lib/blog/types";
import type { StageHandler } from "./index";
import { MAX_SLOT_SEARCHES } from "./photoSearch";
import { RATE_SYSTEM, junkPhotoSignal, offPuttingSignal } from "@/lib/blog/photo/ratePrompt";

const STAGE_KEY = "photo_rate";
const BATCH = 6;
const PARALLEL = 3;
const MAX_BATCH_ATTEMPTS = 2;
/** Столько одобренных на слот достаточно: остальные кандидаты слота не оцениваем (экономия vision-вызовов). */
const ENOUGH_PER_SLOT = 4;

export { RATE_SYSTEM };

type Rated = Record<string, unknown>;

function leadFor(keyword: string, slot: BlogImageSlot): string {
  const hero = slot.key === "hero" ? `\nTHIS IS THE MAIN PHOTO at the top of the article and on Pinterest: it must be inviting and pleasant (the solution in progress or a nice result, a calm person), never the problem at its worst.` : "";
  return `ARTICLE: "${keyword}".\nSLOT "${slot.key}" — the photo must show: ${slot.query}.${slot.mustShow ? `\nMUST BE VISIBLE: ${slot.mustShow}.` : ""}\nMUST NOT SHOW: ${slot.avoid ? `${slot.avoid}; ` : ""}injury, rash, swelling, allergic reaction, distress, gross close-up.${hero}\nWhen in doubt, reject: an off-topic, fake or unpleasant photo is far worse than a missing one.`;
}

export const photoRate: StageHandler = async (ctx) => {
  const { post, recipe } = ctx;
  const minScore = recipe.photoSearch.minScore;
  const model = stageModel(recipe, STAGE_KEY);
  const custom = resolvePromptOptional(recipe, STAGE_KEY);
  const slots = await prisma.blogImageSlot.findMany({ where: { postId: post.id, chosenPhotoId: null, status: { not: "empty" } }, orderBy: { createdAt: "asc" } });
  if (!slots.length) return { summary: "Нет слотов для оценки — пропуск", details: { skipped: true } };

  let cost = 0;
  let kept = 0;
  let rejected = 0;
  let batches = 0;

  const rejectOne = async (c: BlogPhotoCandidate, reason: string, extra: Rated = {}) => {
    rejected++;
    await prisma.blogPhotoCandidate.update({ where: { id: c.id }, data: { status: "rejected", rejectStage: "rate", rejectReason: reason.slice(0, 500), aiScore: 0, aiBreakdown: { ...extra, verdict: "reject", reason } as object } });
  };

  const runBatch = async (slot: BlogImageSlot, rows: BlogPhotoCandidate[], system: string, lead: string, userTpl: string) => {
    const batch: Array<{ c: BlogPhotoCandidate; part: ContentPart }> = [];
    for (const c of rows) {
      const img = await loadVisionImage(c, "full");
      if (img) batch.push({ c, part: imagePart(img.bytes, img.mime) });
      else await rejectOne(c, "фото недоступно для оценки");
    }
    if (!batch.length) return;
    const userText = `${userTpl ? userTpl + "\n\n" : ""}Photos (numbered in order):\n${batch.map((b, n) => `${n + 1}. ${b.c.title || "(no title)"} — ${b.c.domain || ""}`).join("\n")}`;
    const parts: ContentPart[] = [{ type: "text", text: lead }, { type: "text", text: userText }, ...batch.map((b) => b.part)];
    let items: Rated[] | null = null;
    try {
      const r = await aiChat(ctx.ai, { slot: SLOTS.vision, model, system, user: parts, json: true, temperature: 0.2, maxTokens: 4000, timeoutMs: 180_000, cacheSystem: true });
      cost += r.costUsd ?? 0;
      const json = r.json ?? parseJsonLenient(r.text);
      const list = listFromJson(json, ["photos", "results"]).filter((x): x is Rated => !!x && typeof x === "object");
      items = list.length ? list : null;
    } catch (e) {
      // Пустой ответ модели — обычно из-за одного «трудного» кадра в пачке: не повтор всего этапа, а попытка этих фото
      // (повторно они оцениваются по одному, после второй неудачи — отбраковка)
      const empty = e instanceof AiError && e.cls.code === "empty" && !ctx.signal.aborted;
      if (!empty && mustRethrow(e, ctx.signal)) throw e;
      ctx.log(`пачка не оценена: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!items) {
      for (const b of batch) {
        const ex = (b.c.aiBreakdown ?? {}) as Rated;
        const attempts = Number(ex.attempts ?? 0) + 1;
        if (attempts >= MAX_BATCH_ATTEMPTS) await rejectOne(b.c, "модель не оценила фото", { attempts });
        else await prisma.blogPhotoCandidate.update({ where: { id: b.c.id }, data: { aiBreakdown: { ...ex, attempts } as object } });
      }
      return;
    }
    const answered = new Set<string>();
    for (const it of items) {
      const n = Number(it.n ?? it.index ?? 0);
      const row = batch[n - 1];
      if (!row || answered.has(row.c.id)) continue;
      answered.add(row.c.id);
      const relevance = clamp10(it.relevance);
      const quality = clamp10(it.quality);
      // appeal: если модель поле не вернула — берём качество (старые промты сценария без appeal)
      const appeal = it.appeal == null ? quality : clamp10(it.appeal);
      const real = it.real_photo !== false;
      const issues = Array.isArray(it.issues) ? it.issues.map((x) => String(x)).slice(0, 6) : [];
      const score = Math.round((relevance * 0.6 + quality * 0.4) * 10) / 10;
      const verdictKeep = String(it.verdict ?? "").toLowerCase() === "keep";
      const description = String(it.description ?? "").trim().slice(0, 400);
      const unpleasant = offPuttingSignal(`${description} ${issues.join(" ")}`) ?? (issues.some((x) => /off-putting|disturbing|gross/i.test(x)) ? "неприятный кадр" : null)
        ?? junkPhotoSignal(`${description} ${issues.join(" ")}`);
      const appealOk = appeal >= (slot.key === "hero" ? 7 : 6);
      const keep = verdictKeep && real && !unpleasant && appealOk && relevance >= 6 && quality >= 4 && score >= minScore;
      const reason = unpleasant ?? (!appealOk && verdictKeep ? `не вызывает желания сохранить (appeal ${appeal})` : String(it.reason ?? "").slice(0, 200));
      if (keep) kept++; else rejected++;
      await prisma.blogPhotoCandidate.update({
        where: { id: row.c.id },
        data: {
          status: keep ? "keep" : "rejected",
          rejectStage: keep ? null : "rate",
          rejectReason: keep ? null : (issues.length ? `${reason} (${issues.join(", ")})` : reason || `балл ${score} ниже порога ${minScore}`),
          aiScore: score, relevance,
          aiDescription: description || null,
          aiBreakdown: { relevance, quality, appeal, real, issues, verdict: keep ? "keep" : "reject", reason, score, slot: slot.key } as Prisma.InputJsonValue,
        },
      });
    }
    for (const b of batch) {
      if (answered.has(b.c.id)) continue;
      const ex = (b.c.aiBreakdown ?? {}) as Rated;
      const attempts = Number(ex.attempts ?? 0) + 1;
      if (attempts >= MAX_BATCH_ATTEMPTS) await rejectOne(b.c, "модель пропустила фото", { attempts });
      else await prisma.blogPhotoCandidate.update({ where: { id: b.c.id }, data: { aiBreakdown: { ...ex, attempts } as object } });
    }
  };

  const needSearch: string[] = [];
  const emptied: string[] = [];
  for (const slot of slots) {
    const vars = { keyword: post.keyword, slot_query: slot.query, slot_must_show: slot.mustShow ?? "", slot_avoid: slot.avoid ?? "" };
    const filled = custom ? fillPrompt(custom, vars, { allowMissing: true, name: STAGE_KEY }) : null;
    const system = filled?.system?.trim() ? filled.system : RATE_SYSTEM;
    const lead = leadFor(post.keyword, slot);
    const userTpl = filled?.user?.trim() ?? "";
    for (let pass = 0; pass < MAX_BATCH_ATTEMPTS + 1; pass++) {
      const keptNow = await prisma.blogPhotoCandidate.count({ where: { slotId: slot.id, status: { in: ["keep", "chosen", "reserve"] } } });
      if (keptNow >= ENOUGH_PER_SLOT) break;
      const pending = await prisma.blogPhotoCandidate.findMany({ where: { slotId: slot.id, status: "downloaded", aiScore: null }, orderBy: [{ techScore: "desc" }, { position: "asc" }], take: (ENOUGH_PER_SLOT - keptNow) * 4 });
      if (!pending.length) break;
      await ctx.tick(`Оценка ${slot.key}: ${pending.length} фото`);
      const all: BlogPhotoCandidate[][] = [];
      const retried = pending.filter((c) => Number(((c.aiBreakdown ?? {}) as Rated).attempts ?? 0) > 0);
      const fresh = pending.filter((c) => !retried.includes(c));
      for (let i = 0; i < fresh.length; i += BATCH) all.push(fresh.slice(i, i + BATCH));
      for (const c of retried) all.push([c]);
      for (let wi = 0; wi < all.length; wi += PARALLEL) {
        const wave = all.slice(wi, wi + PARALLEL);
        const settled = await Promise.allSettled(wave.map((b) => runBatch(slot, b, system, lead, userTpl)));
        const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
        if (failure) throw failure.reason;
        batches += wave.length;
        const keptSoFar = await prisma.blogPhotoCandidate.count({ where: { slotId: slot.id, status: { in: ["keep", "chosen", "reserve"] } } });
        if (keptSoFar >= ENOUGH_PER_SLOT) break;
      }
    }
    const keptFinal = await prisma.blogPhotoCandidate.count({ where: { slotId: slot.id, status: { in: ["keep", "chosen", "reserve"] } } });
    if (keptFinal === 0) {
      if (slot.searches < MAX_SLOT_SEARCHES) {
        await prisma.blogImageSlot.update({ where: { id: slot.id }, data: { status: "pending" } });
        needSearch.push(slot.key);
      } else if (slot.key === "hero" && slot.orientation === "tall") {
        // Вертикальных кадров по теме нет (часто у «бытовых» тем): главное фото любой ориентации лучше, чем статья без него.
        // Кадры, отсеянные только по ориентации, возвращаются в фильтр; плюс ещё один поиск без iar:t.
        const revived = await prisma.blogPhotoCandidate.updateMany({ where: { slotId: slot.id, status: "rejected", rejectReason: { startsWith: "ориентация" } }, data: { status: "found", rejectReason: null, rejectStage: null } });
        await prisma.blogImageSlot.update({ where: { id: slot.id }, data: { orientation: "any", status: "pending", searches: MAX_SLOT_SEARCHES - 1 } });
        ctx.log(`hero: вертикальных кадров нет — ориентация «любая», возвращено в фильтр ${revived.count}`);
        needSearch.push(slot.key);
      } else {
        await prisma.blogImageSlot.update({ where: { id: slot.id }, data: { status: "empty" } });
        emptied.push(slot.key);
      }
    } else {
      await prisma.blogImageSlot.update({ where: { id: slot.id }, data: { status: "rated" } });
    }
  }

  const details = { kept, rejected, batches, costUsd: Math.round(cost * 1e6) / 1e6, needSearch, emptied, minScore };
  if (needSearch.length) {
    return { next: "photo_search", summary: `Оценка: одобрено ${kept}, отклонено ${rejected}; без годных: ${needSearch.join(", ")} — повторный поиск`, details };
  }
  return { summary: `Оценка: одобрено ${kept}, отклонено ${rejected} (${batches} пачек, $${details.costUsd})${emptied.length ? `; слоты без фото: ${emptied.join(", ")}` : ""}`, details };
};

function clamp10(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}
