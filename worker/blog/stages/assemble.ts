/**
 * Этап `assemble`: HTML статьи (src/lib/blog/html.ts) + JSON-LD (schema.ts) + проверка качества (qualityCheck.ts).
 * Детерминированные починки сохраняются сразу. Проблемы секций — одна перепись (write.rewriteSection, cursor.qualityRewritten),
 * затем пересборка; остальное — фатальная ошибка с перечнем проблем. Статус (проверка/публикация) ставит раннер.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { captionCfgFrom } from "@/lib/articles/text/html";
import { usesUsSpelling } from "@/lib/articles/text/polish";
import { assemblePostHtml, type AssembleSection } from "@/lib/blog/html";
import { checkPostQuality, sectionProblemOf } from "@/lib/blog/qualityCheck";
import { buildJsonLd } from "@/lib/blog/schema";
import { cleanHeading, cleanSectionHtml, varyTipLabels } from "@/lib/blog/text";
import { allowedTags } from "@/lib/blog/blocks";
import { publicUrl } from "@/lib/blog/storage";
import { videoEmbedHtml, videoObject, type BlogVideoState } from "@/lib/blog/video";
import { countListItems, fixLeadingNumber } from "@/lib/blog/structure";
import type { StageHandler } from "./index";
import { rewriteSection } from "./write";
import { consistencyProblems } from "./consistency";

export const assemble: StageHandler = async (ctx) => {
  const { post, recipe, outline } = ctx;
  if (!outline) return { next: "outline", summary: "Нет плана — возврат к плану" };
  const fresh = await prisma.blogPost.findUniqueOrThrow({ where: { id: post.id } });
  const [sections, photos] = await Promise.all([
    prisma.blogSection.findMany({ where: { postId: post.id }, orderBy: { position: "asc" } }),
    prisma.blogPhoto.findMany({ where: { postId: post.id, excluded: false }, orderBy: { position: "asc" } }),
  ]);
  if (!sections.length) return { next: "outline", summary: "Нет секций — возврат к плану" };

  await ctx.tick("Проверка качества");
  const quality = checkPostQuality(fresh, outline, recipe.params, sections, photos);
  if (quality.patch.sections.length || quality.patch.photos.length) {
    await prisma.$transaction([
      ...quality.patch.sections.map((p) => prisma.blogSection.update({ where: { id: p.id }, data: { html: p.html, wordCount: p.wordCount } })),
      ...quality.patch.photos.map((p) => prisma.blogPhoto.update({ where: { id: p.id }, data: { altText: p.altText } })),
    ]);
    ctx.log(`починка: ${quality.fixed.join("; ")}`);
  }
  // Согласованность цифр и советов между частями (один раз на пост): находки идут в ту же самопочинку
  // Согласованность — совет, а не стоп: что осталось после одной переписи, статью не останавливает.
  // Для большого списка и чеклиста не проверяем: «пункт лучше в другой группе» и повторы — не противоречия.
  const advisory: string[] = [];
  if (quality.ok && !ctx.cursor.consistencyChecked && recipe.scenario?.structure !== "big_list") {
    await ctx.tick("Проверка согласованности");
    const c = await consistencyProblems(ctx, fresh, sections);
    await ctx.save({ cursor: { ...ctx.cursor, consistencyChecked: true } });
    if (c.problems.length) {
      ctx.log(`согласованность: ${c.problems.join("; ")} ($${c.costUsd.toFixed(4)})`);
      quality.problems.push(...c.problems);
      advisory.push(...c.problems);
      quality.ok = false;
    }
  }
  if (!quality.ok) {
    const bad = new Map<number, string[]>();
    for (const p of quality.problems) {
      const n = sectionProblemOf(p);
      if (n != null) bad.set(n, [...(bad.get(n) ?? []), p.replace(/^Секция \d+:\s*/, "")]);
    }
    const other = quality.problems.filter((p) => sectionProblemOf(p) == null);
    const tried = new Set((ctx.cursor.qualityRewritten ?? []) as number[]);
    const todo = [...bad.entries()].filter(([n]) => !tried.has(n));
    if (todo.length && !other.length) {
      let cost = 0;
      const fixedPos: number[] = [];
      const failed: string[] = [];
      for (const [n, probs] of todo) {
        const sec = sections.find((s) => s.position === n);
        if (!sec) continue;
        const r = await rewriteSection(ctx, sec, probs);
        cost += r.costUsd;
        if (r.ok) fixedPos.push(n); else failed.push(`${n} (${r.why})`);
      }
      ctx.log(`самопочинка: переписано ${fixedPos.join(", ") || "—"}${failed.length ? `; не вышло: ${failed.join(", ")}` : ""}; $${cost.toFixed(4)}`);
      const cursor = { ...ctx.cursor, qualityRewritten: [...tried, ...todo.map(([n]) => n)] };
      await ctx.save({ cursor });
      const again = await prisma.blogPost.findUniqueOrThrow({ where: { id: post.id } });
      const r = await assemble({ ...ctx, cursor, post: again });
      return { ...r, summary: `${r.summary ?? ""} · самопочинка: переписано ${fixedPos.length} из ${todo.length}`.trim() };
    }
    if (other.length && other.every((p) => /^(Нет вступления|Вступление|Нет заключения|Заключение|Выводы|Дисклеймер|FAQ|Нет дисклеймера)/.test(p)) && !ctx.cursor.wrapRewritten) {
      // Проблемы обвязки — один раз переписать её (этап wrap) и собрать снова
      ctx.log(`проверка качества: ${other.join("; ")} — переписываем вступление/заключение`);
      await ctx.save({ cursor: { ...ctx.cursor, wrapRewritten: true } });
      await prisma.blogPost.update({ where: { id: post.id }, data: { introHtml: null, conclusionHtml: null } });
      return { next: "wrap", summary: `Проверка качества: ${other.join("; ")} — обвязка пишется заново` };
    }
    const hard = quality.problems.filter((x) => !advisory.includes(x));
    if (hard.length) {
      return {
        fatal: `Статья не прошла проверку качества: ${hard.join("; ")}. Исправьте текст в карточке статьи и нажмите «Повторить этап» → «Сборка HTML».`,
        details: { problems: hard, advisory, fixed: quality.fixed },
      };
    }
    ctx.log(`согласованность: осталось после переписи, статья идёт дальше: ${advisory.join("; ").slice(0, 600)}`);
  }

  // ── Сборка ──
  await ctx.tick("Сборка HTML");
  const ps = recipe.photoSearch;
  const caption = captionCfgFrom(ps.captionMode, ps.captionTemplate);
  const pol = { usSpelling: usesUsSpelling(recipe.params.language, recipe.params.country) };
  const photoBySlot = new Map(photos.map((p) => [p.slotKey, p]));
  const ovMode = recipe.params.overlay?.mode ?? "off";
  const shownUrl = (p: (typeof photos)[number]) => (ovMode === "article" && p.overlayPath ? p.overlayWpUrl || publicUrl(p.overlayPath) : p.wpUrl || p.publicUrl);
  const img = (slotKey: string | null | undefined) => {
    const p = slotKey ? photoBySlot.get(slotKey) : null;
    if (!p) return null;
    const base = { url: p.wpUrl || p.publicUrl, width: p.width, height: p.height, sourcePageUrl: p.sourcePageUrl, sourceDomain: p.sourceDomain, altText: p.altText, pinDescription: p.pinDescription, position: p.position };
    if (!p.overlayPath || ovMode === "off") return base;
    const overlayUrl = p.overlayWpUrl || publicUrl(p.overlayPath);
    return ovMode === "article" ? { ...base, url: overlayUrl, width: p.overlayWidth, height: p.overlayHeight } : { ...base, pinMedia: overlayUrl };
  };
  const rows = await prisma.blogSection.findMany({ where: { postId: post.id, status: "written" }, orderBy: { position: "asc" } });
  const cleaned = varyTipLabels(rows.map((s) => cleanSectionHtml(s.html ?? "", allowedTags(s.kind), pol, { allowLinks: true })));
  const chosenVideo = ((fresh.video ?? null) as BlogVideoState | null)?.chosen ?? null;
  let videoPos = chosenVideo ? (outline.videoSection ?? rows.find((r) => r.kind === "steps")?.position ?? null) : null;
  // Видео не ставим в секцию с ИИ-картинкой шагов (два больших блока подряд) — в следующую секцию без неё и не таблицу
  const hasStepsImg = (pos: number) => photoBySlot.has(`ai${pos}`);
  if (videoPos != null && hasStepsImg(videoPos)) {
    const next = rows.find((r) => r.position > videoPos! && !hasStepsImg(r.position) && r.kind !== "comparison_table");
    if (next) videoPos = next.position;
  }
  // Формат: пункты списка/подборки/тренировки нумеруются по порядку; в подборке рецептов — ссылка на рецепт автора фото
  const fmtKey = recipe.scenario?.key;
  let itemNo = 0;
  const numbered = (kind: string, heading: string) => (kind === "list_item" ? `${++itemNo}. ${heading.replace(/^\s*\d+[.)]\s*/, "")}` : heading);
  const recipeLink = (slotKey: string | null | undefined) => {
    const p = slotKey ? photoBySlot.get(slotKey) : null;
    if (fmtKey !== "roundup_recipes" || !p?.sourcePageUrl) return null;
    const domain = (p.sourceDomain || p.sourcePageUrl.replace(/^https?:\/\//, "").split("/")[0]).replace(/^www\./, "");
    return `<p class="zx-source"><strong>Get the recipe:</strong> <a href="${p.sourcePageUrl.replace(/"/g, "&quot;")}" target="_blank" rel="nofollow noopener noreferrer">${domain}</a></p>\n`;
  };
  const secs: AssembleSection[] = rows.map((s, i) => ({ videoHtml: chosenVideo && s.position === videoPos ? videoEmbedHtml(chosenVideo, post.id) : null, position: s.position, kind: s.kind, heading: numbered(s.kind, cleanHeading(s.heading)), html: cleaned[i], photo: img(s.slotKey), stepsPhoto: img(`ai${s.position}`), afterHtml: s.kind === "list_item" ? recipeLink(s.slotKey) : null }));
  const faq = Array.isArray(fresh.faq) ? (fresh.faq as Array<{ question: string; answer: string }>).filter((f) => f?.question && f?.answer) : [];
  const jsonLd = recipe.publish.schema === "off" ? null : buildJsonLd({
    h1: fresh.h1 || outline.h1 || post.keyword, description: fresh.metaDescription || outline.metaDescription,
    images: photos.map(shownUrl).filter(Boolean), faq, sections: secs.map((s) => ({ kind: s.kind, heading: s.heading, html: s.html })),
    video: chosenVideo && videoPos ? videoObject(chosenVideo) : null,
    recipe: recipe.scenario?.structure === "recipe",
  });
  const built = assemblePostHtml({
    introHtml: fresh.introHtml ?? "", hero: img("hero"), takeawaysHtml: fresh.takeawaysHtml, sections: secs, faq,
    conclusionHtml: fresh.conclusionHtml ?? "", disclaimerHtml: fresh.disclaimerHtml, closing: img("closing"),
    keyword: post.keyword, caption, jsonLd,
  });
  // Число в H1/title/description = реальному числу пунктов (после самопочинки групп оно могло измениться)
  const itemCount = countListItems(recipe.scenario?.structure, rows);
  const numberFix = itemCount && itemCount >= 3 ? { h1: fixLeadingNumber(fresh.h1, itemCount), metaTitle: fixLeadingNumber(fresh.metaTitle, itemCount), metaDescription: fixLeadingNumber(fresh.metaDescription, itemCount) } : {};
  await prisma.blogPost.update({ where: { id: post.id }, data: { html: built.html, wordCount: built.wordCount, schema: jsonLd ? (jsonLd as Prisma.InputJsonValue) : Prisma.DbNull, ...numberFix } });
  return {
    summary: `Собрано: ${secs.length} секций, ${photos.length} фото, ${built.wordCount} слов${faq.length ? `, FAQ ${faq.length}` : ""}${quality.fixed.length ? `; починено: ${quality.fixed.length}` : ""}`,
    details: { sections: secs.length, photos: photos.length, wordCount: built.wordCount, toc: built.toc, faq: faq.length, schema: jsonLd ? (jsonLd as { "@graph": unknown[] })["@graph"].map((g) => (g as { "@type": string })["@type"]) : [], fixed: quality.fixed },
  };
};
