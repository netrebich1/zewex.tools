/**
 * Этап `ai_images`: ИИ-картинка «по шагам» там, где она нужна — в секциях-инструкциях (kind=steps, в списке ≥3 шагов).
 * Реальные фото статьи остаются; картинка шагов ставится в конец своей секции, после списка.
 *  1) text_fast выбирает 2–4 шага, которые лучше всего показать, и описывает героя/обстановку (один и тот же человек во всех панелях);
 *  2) image_main (gpt-image-2) рисует одну картинку из панелей БЕЗ текста — буквы модели рисуют плохо;
 *  3) номера шагов (как в списке статьи) рисуются на панелях канвой.
 * Режим сценария params.aiImages: off — этап ничего не делает; steps — до max картинок на статью.
 * Нет ключа / сбой генерации — статья идёт дальше без ИИ-картинки (с записью в журнал), это не ошибка поста.
 * Идемпотентен: секция, у которой уже есть фото ai<position>, пропускается.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { AiError } from "@/lib/pins/ai/errors";
import { aiChat, aiChatRetry, aiImage } from "@/lib/blog/ai";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { stageModel } from "@/lib/blog/prompts";
import { SLOTS } from "@/lib/blog/types";
import { makeThumb, photoRel, photoThumbRel, publicUrl, toWpJpeg, writeFileAtomic } from "@/lib/blog/storage";
import { getHost, asImageSource } from "@/lib/pins/canvas/host";
import { cleanHeading } from "@/lib/blog/text";
import type { StageHandler } from "./index";

type Panel = { step: number; shows: string; label: string };
type Plan = { subject: string; setting: string; panels: Panel[] };

/** Шаги из HTML секции: текст пунктов первого <ol> (метка <strong> + первое предложение). */
export function stepsOf(html: string): string[] {
  const ol = String(html ?? "").match(/<ol\b[^>]*>([\s\S]*?)<\/ol>/i)?.[1] ?? "";
  return [...ol.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Раскладка панелей на холсте 1024×1536: 4 — сетка 2×2, 3 и 2 — друг под другом. */
export function panelLayout(n: number, w: number, h: number): Array<{ x: number; y: number; w: number; h: number }> {
  if (n >= 4) return [0, 1, 2, 3].map((i) => ({ x: (i % 2) * (w / 2), y: Math.floor(i / 2) * (h / 2), w: w / 2, h: h / 2 }));
  return Array.from({ length: n }, (_, i) => ({ x: 0, y: (i * h) / n, w, h: h / n }));
}

function layoutWords(n: number): string {
  if (n >= 4) return "exactly four equal panels in a 2x2 grid (top-left, top-right, bottom-left, bottom-right)";
  return `exactly ${n} equal horizontal panels stacked from top to bottom`;
}

const POS4 = ["top-left", "top-right", "bottom-left", "bottom-right"];

export function buildImagePrompt(plan: Plan, topic: string): string {
  const n = plan.panels.length;
  const where = (i: number) => (n >= 4 ? POS4[i] : i === 0 ? "top" : i === n - 1 ? "bottom" : "middle");
  const panels = plan.panels.map((p, i) => `Panel ${i + 1} (${where(i)}): ${p.shows}`).join("\n");
  return `One photorealistic image made of ${layoutWords(n)}, separated by thin white gutters. It shows consecutive steps of "${topic}".
Every panel is a natural, real-looking smartphone photo of the SAME person: ${plan.subject}. Same face, hair and clothes in every panel, same place: ${plan.setting}. Soft natural daylight, close enough that hands and the action are clearly visible, realistic skin and hair texture.
${panels}
Absolutely no text, letters, numbers, arrows, captions, labels, logos or watermarks anywhere in the image. Leave the top-left corner of each panel uncluttered.`;
}

/** Номера панелей 1..N (по порядку на картинке) и короткая подпись действия внизу каждой панели. */
async function drawNumbers(src: Buffer, labels: string[]): Promise<Buffer> {
  const host = getHost();
  // Ответ провайдера → PNG через sharp: canvas не всегда узнаёт формат буфера (иначе «Invalid SVG image»)
  const png = await sharp(src).png().toBuffer();
  const img = await host.loadImage(png);
  const c = host.createCanvas(img.width, img.height);
  const g = c.getContext("2d");
  g.drawImage(asImageSource(img), 0, 0, img.width, img.height);
  const cells = panelLayout(labels.length, img.width, img.height);
  const r = Math.round(Math.min(img.width, img.height) * 0.045);
  cells.forEach((cell, i) => {
    const cx = cell.x + r + 22, cy = cell.y + r + 22;
    g.beginPath(); g.arc(cx, cy, r + 4, 0, Math.PI * 2); g.fillStyle = "#ffffff"; g.fill();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = "#1f1f1f"; g.fill();
    g.fillStyle = "#ffffff"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `700 ${Math.round(r * 1.15)}px "Montserrat", "Inter", sans-serif`;
    g.fillText(String(i + 1), cx, cy + 1);
    const label = (labels[i] ?? "").trim();
    if (label) {
      const fs = Math.round(Math.min(cell.w, cell.h) * 0.07);
      g.font = `700 ${fs}px "Montserrat", "Inter", sans-serif`;
      let text = label;
      while (g.measureText(text).width > cell.w - 60 && text.length > 4) text = text.slice(0, -2).trimEnd() + "…";
      const tw = g.measureText(text).width + fs * 1.4, th = fs * 1.7;
      const bx = cell.x + cell.w / 2 - tw / 2, by = cell.y + cell.h - th - 18;
      g.globalAlpha = 0.92; g.fillStyle = "#ffffff"; g.fillRect(bx, by, tw, th); g.globalAlpha = 1;
      g.fillStyle = "#1f1f1f"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(text, cell.x + cell.w / 2, by + th / 2 + 1);
    }
  });
  return host.encodeJpeg(c, 0.9);
}

export const aiImagesStage: StageHandler = async (ctx) => {
  const { post, recipe, outline } = ctx;
  const cfg = recipe.params.aiImages ?? { mode: "off", max: 2, quality: "medium" };
  if (cfg.mode === "off") return { summary: "ИИ-картинки выключены в сценарии" };
  const sections = await prisma.blogSection.findMany({ where: { postId: post.id, status: "written" }, orderBy: { position: "asc" } });
  const existing = new Set((await prisma.blogPhoto.findMany({ where: { postId: post.id, slotKey: { startsWith: "ai" } }, select: { slotKey: true } })).map((p) => p.slotKey));
  const fit = sections.filter((s) => s.kind === "steps" && stepsOf(s.html ?? "").length >= 3);
  const todo = fit.slice(0, cfg.max).filter((s) => !existing.has(`ai${s.position}`));
  if (!fit.length) return { summary: "Нет секций с пошаговой инструкцией — ИИ-картинка не нужна" };
  if (!todo.length) return { summary: `ИИ-картинки шагов уже есть: ${existing.size}` };

  const h1 = post.h1 || outline?.h1 || post.keyword;
  let made = 0, cost = 0;
  const skipped: string[] = [];
  for (const s of todo) {
    const heading = cleanHeading(s.heading);
    const steps = stepsOf(s.html ?? "");
    await ctx.tick(`ИИ-картинка шагов: ${heading}`);
    // 1) План панелей
    let plan: Plan | null = null;
    try {
      const system = `You plan one step-by-step illustration for a blog article. It will be a single photorealistic image split into 2-4 panels, one panel per step, with NO text in the image (step numbers are added later).
Pick the 2-4 steps from the list that are the most visual and together show the process from start to result, in the list's order (prefer 4 when there are 4 or more visual steps). Panels will be numbered 1-N on the image with your short label, so each label must make sense on its own. For each chosen step describe in one sentence exactly what the camera sees: hands, tool, hair or object, the action in progress. Describe one consistent person and one consistent place for all panels (age range, hair, clothing, room). Only things that really belong to this process; no brands, no text, no screens.
Return ONLY JSON: {"subject":"...","setting":"...","panels":[{"step":1,"label":"2-4 word action, e.g. Clamp and twist","shows":"..."}]} where "step" is the number of the step in the list.`;
      const user = `Article: "${h1}"\nSection: "${heading}"\nSteps:\n${steps.map((t, i) => `${i + 1}. ${t.slice(0, 220)}`).join("\n")}`;
      const r = await aiChatRetry(ctx.ai, { slot: SLOTS.textFast, model: stageModel(recipe, "meta"), system, user, json: true, temperature: 0.6, maxTokens: 700, timeoutMs: 90_000 });
      cost += r.costUsd ?? 0;
      const j = parseModelJsonSafe(r.text) as Partial<Plan> | null;
      const panels = (Array.isArray(j?.panels) ? j!.panels : [])
        .map((p) => ({ step: Math.round(Number(p?.step)), shows: String(p?.shows ?? "").trim().slice(0, 300), label: String((p as { label?: unknown })?.label ?? "").replace(/[.!]+$/, "").trim().slice(0, 32) }))
        .filter((p) => p.step >= 1 && p.step <= steps.length && p.shows.length > 10)
        .filter((p, i, a) => a.findIndex((q) => q.step === p.step) === i)
        .sort((a, b) => a.step - b.step)
        .slice(0, 4);
      if (panels.length >= 2 && j?.subject) plan = { subject: String(j.subject).slice(0, 300), setting: String(j.setting ?? "a bright home bathroom").slice(0, 200), panels: panels.length === 3 || panels.length === 2 || panels.length === 4 ? panels : panels.slice(0, 2) };
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") { skipped.push(`${s.position}: нет ключа текста`); continue; }
      ctx.log(`план ИИ-картинки секции ${s.position}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!plan) { skipped.push(`${s.position}: план не получен`); continue; }

    // 2) Картинка
    const prompt = buildImagePrompt(plan, `${heading} (${post.keyword})`);
    let bytes: Buffer | null = null;
    for (let attempt = 0; attempt < 2 && !bytes; attempt++) {
      try {
        await ctx.tick(`Генерация картинки шагов (${plan.panels.length} панели)`);
        const r = await aiImage(ctx.ai, { prompt, size: "1024x1536", quality: cfg.quality });
        cost += r.costUsd ?? 0;
        bytes = r.bytes;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof AiError && (e.cls.kind === "fatal_run" || e.cls.kind === "permanent")) { skipped.push(`${s.position}: ${msg.slice(0, 160)}`); break; }
        ctx.log(`генерация картинки секции ${s.position}, попытка ${attempt + 1}: ${msg}`);
        if (attempt === 1) skipped.push(`${s.position}: ${msg.slice(0, 160)}`);
      }
    }
    if (!bytes) continue;

    // 3) Номера шагов и файлы
    let numbered: Buffer;
    try {
      numbered = await drawNumbers(bytes, plan.panels.map((p) => p.label));
    } catch (e) {
      const head = bytes.subarray(0, 16).toString("hex");
      ctx.log(`картинка секции ${s.position} не читается (${bytes.length} байт, начало ${head}): ${e instanceof Error ? e.message : String(e)}`);
      skipped.push(`${s.position}: картинка не читается`);
      continue;
    }
    const jpeg = await toWpJpeg(numbered);
    const photoId = randomUUID();
    const path = photoRel(post.id, photoId);
    const thumbPath = photoThumbRel(post.id, photoId);
    await writeFileAtomic(path, jpeg.bytes);
    await writeFileAtomic(thumbPath, await makeThumb(jpeg.bytes));
    const shows = plan.panels.map((p, i) => `${i + 1}. ${p.label || p.shows.replace(/\.$/, "")}`).join("; ");
    await prisma.blogPhoto.create({
      data: {
        id: photoId, postId: post.id, slotKey: `ai${s.position}`, position: 100 + s.position, path, thumbPath, publicUrl: publicUrl(path),
        width: jpeg.width, height: jpeg.height, aiGenerated: true, aiPrompt: prompt,
        altText: `Step-by-step photos: ${heading}`.slice(0, 300), description: `Step-by-step illustration (${plan.panels.length} panels) for "${heading}" — ${shows}`.slice(0, 1000),
        fileName: `ai-${s.position}.jpg`,
      },
    });
    made++;
  }
  return {
    summary: `ИИ-картинки шагов: ${made}${skipped.length ? `, пропущено ${skipped.length} (${skipped.join("; ")})` : ""} · $${cost.toFixed(3)}`,
    details: { made, skipped, sections: todo.map((s) => s.position), costUsd: cost },
  };
};
