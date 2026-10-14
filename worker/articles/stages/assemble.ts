/**
 * Этап `assemble` (шаг 76 оригинала, stage7-assemble-html/index.ts): HTML статьи из вступления, секций с фото
 * и заключения. Число идей ({{COUNT}} и «живые» цифры) → фактическое число фото в статье. Текст автора в ArtSection
 * не перезаписывается собранным фрагментом (аудит 03, §8) — повторная сборка после модерации всегда чистая.
 * Статус статьи этап не меняет: раннер решает, модерация это или публикация.
 */
import { prisma } from "@/lib/db";
import { patchCount } from "@/lib/articles/text/countToken";
import { looksLikeModelThinking, looksLikeRawJson } from "@/lib/articles/text/introOutroParse";
import { stripEmphasis } from "@/lib/articles/text/textGuards";
import { assembleArticleHtml, captionCfgFrom, type AssembleSection } from "@/lib/articles/text/html";
import { focusKeywordOf } from "@/lib/articles/text/vars";
import type { ArtStageHandler } from "./index";
import { INTRO_POS, isWritten, loadActivePhotos, loadPhotoSections, OUTRO_POS } from "./plan";

export const assemble: ArtStageHandler = async (ctx) => {
  const { article, recipe, plan } = ctx;
  const photos = await loadActivePhotos(article.id);
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const all = await loadPhotoSections(article.id);

  // Секции, чьё фото исключено модератором, в статью не попадают (оригинал: excludeOutfits).
  const active = all.filter((s) => s.photoId && photoById.has(s.photoId));
  const unwritten = active.filter((s) => !isWritten(s));
  if (unwritten.length) {
    return { fatal: `Секции без текста: ${unwritten.map((s) => s.position).join(", ")} — сборка невозможна. Повторите этап «Тексты секций».` };
  }
  if (!active.length) return { fatal: "Нет ни одной секции с фото — нечего собирать" };

  const introRow = await prisma.artSection.findUnique({ where: { articleId_position: { articleId: article.id, position: INTRO_POS } } });
  const outroRow = await prisma.artSection.findUnique({ where: { articleId_position: { articleId: article.id, position: OUTRO_POS } } });
  const introHtml = (article.introHtml || introRow?.html || "").trim();
  const outroHtml = (article.outroHtml || outroRow?.html || "").trim();
  if (!introHtml) return { fatal: "Нет вступления — статья не собирается. Повторите этап «Вступление и заключение»." };
  if (!outroHtml) return { fatal: "Нет заключения — статья не собирается. Повторите этап «Вступление и заключение»." };
  if (looksLikeRawJson(introHtml) || looksLikeRawJson(outroHtml)) return { fatal: "Вступление или заключение содержит сырой JSON вместо текста — повторите этап «Вступление и заключение»." };
  if (looksLikeModelThinking(introHtml) || looksLikeModelThinking(outroHtml)) return { fatal: "Во вступлении/заключении черновые размышления модели — повторите этап «Вступление и заключение»." };

  const count = active.length;
  const keyword = focusKeywordOf(ctx);
  const caption = captionCfgFrom(recipe.photoSearch?.captionMode, recipe.photoSearch?.captionTemplate);

  const sections: AssembleSection[] = active.map((s) => {
    const p = photoById.get(s.photoId!)!;
    return {
      position: s.position,
      heading: stripEmphasis(s.heading),
      html: stripEmphasis(s.html || ""),
      photo: {
        url: p.wpUrl || p.publicUrl,
        width: p.width,
        height: p.height,
        sourcePageUrl: p.sourcePageUrl,
        sourceDomain: p.sourceDomain,
        altText: p.altText,
        pinDescription: p.caption,
        position: p.position,
      },
    };
  });

  await ctx.tick("Сборка HTML");
  const built = assembleArticleHtml({ introHtml: stripEmphasis(introHtml), outroHtml: stripEmphasis(outroHtml), sections, keyword, caption, count });

  // Мета получает актуальное число; версии с меткой остаются в плане, чтобы пересборка после модерации пересчитала снова.
  const h1Src = plan?.h1 || article.h1;
  const titleSrc = plan?.title || article.metaTitle;
  const descSrc = plan?.metaDescription || article.metaDescription;
  await prisma.article.update({
    where: { id: article.id },
    data: {
      html: built.html,
      h1: patchCount(h1Src, count),
      metaTitle: patchCount(titleSrc, count),
      metaDescription: patchCount(descSrc, count),
    },
  });
  await ctx.save({ plan: { ...(plan ?? { h1: h1Src, title: titleSrc, metaDescription: descSrc, slug: article.slug }), toc: built.toc, totalWordCount: built.wordCount, assembledCount: count } });

  return {
    summary: `Собрано: ${count} секций, ${built.wordCount} слов`,
    details: { sections: count, wordCount: built.wordCount, toc: built.toc.length, excludedSections: all.length - active.length },
  };
};
