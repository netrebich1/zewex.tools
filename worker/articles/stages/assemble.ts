/**
 * Этап `assemble` (шаг 76 оригинала, stage7-assemble-html/index.ts): HTML статьи из вступления, секций с фото
 * и заключения. Число идей ({{COUNT}} и «живые» цифры) → фактическое число фото в статье. Текст автора в ArtSection
 * не перезаписывается собранным фрагментом (аудит 03, §8) — повторная сборка после модерации всегда чистая.
 * Статус статьи этап не меняет: раннер решает, модерация это или публикация.
 *
 * В конце — та же бесплатная проверка качества, что и перед публикацией (wp/qualityCheck.ts), чтобы проблемы находились
 * ДО модерации, а не после одобрения (аудит 2026-10-14: заключение leather jacket упало уже на publish).
 * Детерминированные исправления (дубли/длина H2, {{COUNT}}, выделения) сохраняются сразу. Если остались только проблемы
 * вступления/заключения — один раз на статью (cursor.qualityAutoFix) этап intro_outro переписывает их и сборка
 * повторяется. Остальное — фатальная ошибка с перечнем проблем на карточке статьи: человек правит текст и жмёт «Повторить».
 */
import { prisma } from "@/lib/db";
import { patchCount } from "@/lib/articles/text/countToken";
import { looksLikeModelThinking, looksLikeRawJson } from "@/lib/articles/text/introOutroParse";
import { stripEmphasis } from "@/lib/articles/text/textGuards";
import { polishHeading, polishHtml, usesUsSpelling } from "@/lib/articles/text/polish";
import { assembleArticleHtml, captionCfgFrom, type AssembleSection } from "@/lib/articles/text/html";
import { focusKeywordOf } from "@/lib/articles/text/vars";
import { applyQualityPatch, checkArticleQuality, isIntroOutroProblem } from "@/lib/articles/wp/qualityCheck";
import { introOutro } from "./introOutro";
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
  // Детерминированная чистка (тире, американское написание, парность <p>) — и для статей, написанных до неё.
  const pol = { usSpelling: usesUsSpelling(recipe.photoSearch?.language, recipe.photoSearch?.country) };

  const sections: AssembleSection[] = active.map((s) => {
    const p = photoById.get(s.photoId!)!;
    return {
      position: s.position,
      heading: polishHeading(stripEmphasis(s.heading), pol),
      html: polishHtml(stripEmphasis(s.html || ""), pol),
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
  const built = assembleArticleHtml({ introHtml: polishHtml(stripEmphasis(introHtml), pol), outroHtml: polishHtml(stripEmphasis(outroHtml), pol), sections, keyword, caption, count });

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

  // ── Проверка качества до модерации ──
  await ctx.tick("Проверка качества");
  const fresh = await prisma.article.findUniqueOrThrow({ where: { id: article.id } });
  const [qSections, qPhotos] = await Promise.all([
    prisma.artSection.findMany({ where: { articleId: article.id }, orderBy: { position: "asc" } }),
    prisma.artPhoto.findMany({ where: { articleId: article.id }, orderBy: { position: "asc" } }),
  ]);
  const quality = await checkArticleQuality(fresh, qSections, qPhotos, { signal: ctx.signal });
  await applyQualityPatch(article.id, quality.patch);
  if (quality.fixed.length) ctx.log(`проверка качества, исправлено: ${quality.fixed.join("; ")}`);
  if (!quality.ok) {
    if (!ctx.cursor.qualityAutoFix && quality.problems.every(isIntroOutroProblem)) {
      ctx.log(`проверка качества: ${quality.problems.join("; ")} — переписываем вступление и заключение`);
      await ctx.save({ cursor: { ...ctx.cursor, qualityAutoFix: true } });
      const badIntro = quality.problems.some((p) => /^(Вступление|Нет вступления|Во вступлении)/.test(p));
      const badOutro = quality.problems.some((p) => /^(Заключение|Нет заключения)/.test(p));
      // intro_outro пишет оба блока, если хотя бы одного нет; хороший блок не трогаем в базе до успешного ответа.
      const cleared = await prisma.article.update({
        where: { id: article.id },
        data: { ...(badIntro ? { introHtml: null } : {}), ...(badOutro ? { outroHtml: null } : {}) },
      });
      const io = await introOutro({ ...ctx, article: cleared });
      if (io.fatal || io.next) return { fatal: io.fatal ?? `Проверка качества: ${quality.problems.join("; ")}` };
      const again = await prisma.article.findUniqueOrThrow({ where: { id: article.id } });
      const r = await assemble({ ...ctx, article: again });
      return { ...r, summary: `${r.summary ?? ""} · вступление/заключение переписаны после проверки качества`.trim() };
    }
    return {
      fatal: `Статья не прошла проверку качества: ${quality.problems.join("; ")}. Исправьте текст в карточке статьи и нажмите «Повторить».`,
      summary: `Собрано: ${count} секций, ${built.wordCount} слов; проверка качества не пройдена`,
      details: { sections: count, wordCount: built.wordCount, problems: quality.problems, fixed: quality.fixed },
    };
  }

  return {
    summary: `Собрано: ${count} секций, ${built.wordCount} слов`,
    details: { sections: count, wordCount: built.wordCount, toc: built.toc.length, excludedSections: all.length - active.length, qualityFixed: quality.fixed },
  };
};
