/**
 * Этап `pin_images`: фото статьи с плашкой текста (src/lib/blog/pinOverlay.ts) — как Canvas-пин, но кадр целиком.
 * 1) Текст плашки на каждое фото: один вызов text_fast (заголовок по секции + кикер), сбой → заголовок секции.
 * 2) Рендер недостающих картинок в blog/<postId>/photos/<photoId>.pin.jpg.
 * Режим сценария params.overlay.mode: article — в статье стоит картинка с плашкой; pin_only — в статье оригинал,
 * а картинка с плашкой уходит в пин при сохранении (data-pin-media); off — этап ничего не делает.
 * Идемпотентен: готовые тексты и файлы не трогает; новое фото после замены из резерва получает плашку при повторе этапа.
 */
import { readFile } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AiError } from "@/lib/pins/ai/errors";
import { aiChatRetry } from "@/lib/blog/ai";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { fixDashesText } from "@/lib/articles/text/polish";
import { stageModel } from "@/lib/blog/prompts";
import { SLOTS } from "@/lib/blog/types";
import { absPath, exists, pinOverlayRel, writeFileAtomic } from "@/lib/blog/storage";
import { normalizeOverlayText, renderPinOverlay } from "@/lib/blog/pinOverlay";
import { cleanHeading } from "@/lib/blog/text";
import { titleCase } from "./meta";
import type { StageHandler } from "./index";

const KICKER_BY_KIND: Record<string, string> = {
  steps: "Step by step", methods: "How to", mistakes: "Avoid this", tips: "Pro tips", troubleshooting: "Quick fix",
  what_you_need: "You will need", comparison_table: "Compare", why_it_happens: "Why it happens", prevention: "Prevent it",
  aftercare: "Aftercare", myths: "Myth vs fact", when_to_see_pro: "Know when", timeline_cost: "Time and cost", quick_answer: "Quick answer",
};

export function siteDomain(access: { linkDomain?: string | null; baseUrl?: string | null } | null): string {
  const raw = access?.linkDomain || access?.baseUrl || "";
  return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
}

export const pinImages: StageHandler = async (ctx) => {
  const { post, recipe, outline } = ctx;
  const ov = recipe.params.overlay ?? { mode: "article", photos: "all" };
  if (ov.mode === "off") return { summary: "Плашки на фото выключены в сценарии" };
  const all = await prisma.blogPhoto.findMany({ where: { postId: post.id, excluded: false }, orderBy: { position: "asc" } });
  const photos = ov.photos === "hero" ? all.filter((p) => p.slotKey === "hero") : all;
  if (!photos.length) return { summary: "Нет фото для плашек" };
  const h1 = post.h1 || outline?.h1 || post.keyword;
  const sectionOf = (slotKey: string) => {
    const pos = Number(slotKey.replace(/^(?:s|ai)/, ""));
    return /^(?:s|ai)\d/.test(slotKey) ? outline?.sections.find((s) => s.position === pos) ?? null : null;
  };
  const headingOf = (slotKey: string) => (slotKey === "hero" ? h1 : slotKey === "closing" ? `${h1}: the result` : cleanHeading(sectionOf(slotKey)?.heading ?? h1));

  // 1) Тексты плашек
  const needText = photos.filter((p) => !p.overlayText);
  let aiTexts = 0, fallbackTexts = 0, textError: string | undefined;
  if (needText.length) {
    await ctx.tick("Тексты плашек");
    const list = needText.map((p, i) => `${i + 1}. ${p.slotKey === "hero" ? "MAIN IMAGE (top of the article)" : p.slotKey === "closing" ? "LAST IMAGE (end of the article)" : p.aiGenerated ? `STEP-BY-STEP PANELS (${(p.description ?? "").match(/\((\d) panels\)/)?.[1] ?? "4"} panels) for section type ${sectionOf(p.slotKey)?.kind ?? "-"} (if the title has a number of steps it must be exactly ${(p.description ?? "").match(/\((\d) panels\)/)?.[1] ?? "4"}, e.g. "${(p.description ?? "").match(/\((\d) panels\)/)?.[1] ?? "4"} Steps to …")` : `section type ${sectionOf(p.slotKey)?.kind ?? "-"}`}; section heading: "${headingOf(p.slotKey)}"; photo shows: ${p.description || p.altText || "-"}`).join("\n");
    const system = `You write the text that is printed on a band above or below a photo from a blog article, so the image works as a Pinterest pin when someone saves it. Each image gets:
- "title": 3-8 words, the hook people search and save for. It must match THIS section and what the photo shows, and make the reader want the article (a clear benefit, a fix, a mistake to avoid, a how-to). The MAIN IMAGE title must contain the article keyword "${post.keyword}" or its core words. Use a number only when the section really has that many items. No clickbait promises, no question marks unless it is a real search question, no emoji, no quotes, no final period.
- "kicker": 1-3 words above the title that label the content (e.g. "Step by step", "Beginner guide", "Avoid these", "Quick fix", "Hair care"). Never repeat the title words.
Tone: calm, benefit-first, inviting. Never alarmist: no "Important warning", "Danger", "Warning", "Avoid this", "Stop" on the MAIN IMAGE or the LAST IMAGE. Only a section about mistakes or safety may hint at caution, in neutral words ("Skin-safe tips", "Common slip-ups").
Every title must be different from the others and from the section heading wording where possible. American English.
Return ONLY JSON: {"items":[{"n":1,"title":"...","kicker":"..."}]}`;
    try {
      const r = await aiChatRetry(ctx.ai, { slot: SLOTS.textFast, model: stageModel(recipe, "meta"), system, user: `Article: "${h1}"\nKeyword: "${post.keyword}"\nImages:\n${list}`, json: true, temperature: 0.9, maxTokens: 900, timeoutMs: 90_000 });
      const parsed = parseModelJsonSafe(r.text) as { items?: Array<{ n?: unknown; title?: unknown; kicker?: unknown }> } | null;
      for (const it of parsed?.items ?? []) {
        const ph = needText[Number(it.n) - 1];
        const t = normalizeOverlayText({ title: fixDashesText(String(it.title ?? "")), kicker: it.kicker });
        if (!ph || !t || ph.overlayText) continue;
        const text = { title: titleCase(t.title), kicker: t.kicker, source: "ai" };
        await prisma.blogPhoto.update({ where: { id: ph.id }, data: { overlayText: text as Prisma.InputJsonValue } });
        ph.overlayText = text;
        aiTexts++;
      }
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
      textError = e instanceof Error ? e.message.slice(0, 200) : String(e);
      ctx.log(`тексты плашек не получены: ${textError}`);
    }
    for (const ph of needText.filter((p) => !p.overlayText)) {
      const heading = headingOf(ph.slotKey).replace(/:.*$/, "").slice(0, 60);
      const text = { title: titleCase(heading), kicker: ph.slotKey === "hero" ? "Complete guide" : ph.aiGenerated ? "Step by step" : KICKER_BY_KIND[sectionOf(ph.slotKey)?.kind ?? ""] ?? "", source: "fallback" };
      await prisma.blogPhoto.update({ where: { id: ph.id }, data: { overlayText: text as Prisma.InputJsonValue } });
      ph.overlayText = text;
      fallbackTexts++;
    }
  }

  // 2) Рендер
  const domain = siteDomain(ctx.access);
  let rendered = 0, failed = 0;
  for (const p of photos) {
    if (p.overlayPath && (await exists(p.overlayPath))) continue;
    await ctx.tick(`Плашка ${p.slotKey}`);
    const t = (p.overlayText ?? {}) as { title?: string; kicker?: string };
    if (!t.title || !p.path) { failed++; continue; }
    try {
      const src = await readFile(absPath(p.path));
      const out = await renderPinOverlay(src, { title: t.title, kicker: t.kicker, domain }, p.id);
      const rel = pinOverlayRel(post.id, p.id);
      await writeFileAtomic(rel, out.bytes);
      await prisma.blogPhoto.update({ where: { id: p.id }, data: { overlayPath: rel, overlayWidth: out.width, overlayHeight: out.height, overlayWpMediaId: null, overlayWpUrl: null, overlayText: { ...t, variant: out.variant } as Prisma.InputJsonValue } });
      rendered++;
    } catch (e) {
      failed++;
      ctx.log(`плашка ${p.slotKey}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    summary: `Плашки: ${rendered} новых${failed ? `, не вышло ${failed}` : ""}${aiTexts || fallbackTexts ? ` · тексты ИИ ${aiTexts}${fallbackTexts ? `, запасные ${fallbackTexts}` : ""}` : ""} · режим ${ov.mode === "article" ? "в статье" : "только в пине"}`,
    details: { mode: ov.mode, rendered, failed, aiTexts, fallbackTexts, textError },
  };
};
