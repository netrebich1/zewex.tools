/**
 * Проверка блоговых пинов без прогона:
 *   npx tsx scripts/pins/blog-pins-check.ts photos <url…>        — сколько фото берёт обычный сбор и сбор «все фото статьи»
 *   npx tsx scripts/pins/blog-pins-check.ts prompts <userId> <teamId> <styleId,…> <kind> "<title>" [count] ["point|point|…"]
 *       — промты ИИ-пинов блоговых стилей (настоящий вызов модели, пишет в журнал расхода с refId=blog-pins-check)
 *   npx tsx scripts/pins/blog-pins-check.ts image <userId> <teamId> <outFile.jpg> "<prompt>" — одна картинка (gpt-image-2, low)
 */
import { writeFile } from "fs/promises";
import { extractArticleImages } from "@/lib/pins/stages/photos";
import { generateAiPrompts } from "@/lib/pins/prompts/aiPrompt";
import { ARTICLE_KIND_LABELS, kindFromBlogPost, kindKicker, pointsForStyle, type ArticleKind } from "@/lib/pins/articleKind";
import { getAiStyle } from "@/lib/pins/prompts/aiStyles";
import { aiImage } from "@/lib/pins/ai/client";
import { prisma } from "@/lib/db";

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "photos") {
    for (const url of args) {
      const a = await extractArticleImages(url, { featuredOnly: false });
      const b = await extractArticleImages(url, { featuredOnly: false, all: true });
      const firstPerSection = a.images.filter((i) => i.indexInSection === 0).length;
      console.log(`${url}\n  обычный сбор: ${firstPerSection} (из ${a.images.length} по секциям) · все фото статьи: ${b.images.length}${b.error ? ` · ${b.error}` : ""}`);
    }
    return;
  }
  const ctx = (userId: string, teamId: string) => ({ userId, teamId, runId: "blog-pins-check", siteId: "", signal: new AbortController().signal });
  if (mode === "prompts") {
    // prompts <userId> <teamId> <styleIds> <blogPostId>: пункты и тип — из статьи нашего блога
    const [userId, teamId, styles, postId] = args;
    const post = await prisma.blogPost.findUniqueOrThrow({ where: { id: postId }, select: { recipe: true, brief: true, outline: true, h1: true } });
    const info = kindFromBlogPost(post);
    const k = info.kind as ArticleKind;
    const title = info.title ?? "";
    const res = await generateAiPrompts(ctx(userId, teamId), {
      keyword: title, topic: title, niche: "", language: "en", audience: "women", siteName: "lyntrico.com",
      styles: styles.split(",").map((id) => {
        const p = pointsForStyle(info, getAiStyle(id) ?? {});
        console.log(`${id}: раздел ${p.section ?? "—"}, число ${p.count ?? "—"}, пункты: ${p.points.join(" / ")}`);
        return { id, tags: { season: false, year: false, number: false, siteName: true, cta: true, hashtags: false } as never, article: { kind: k, label: ARTICLE_KIND_LABELS[k], kicker: kindKicker(k, "en"), count: p.count, title, points: p.points, section: p.section } };
      }),
    });
    for (const r of res) console.log(`\n=== ${r.styleId}\n${r.prompt}`);
    return;
  }
  if (mode === "image") {
    const [userId, teamId, out, prompt] = args;
    const img = await aiImage(ctx(userId, teamId), { prompt, size: "1024x1536", quality: "low" });
    await writeFile(out, img.bytes);
    console.log(`saved ${out}, $${img.costUsd ?? "?"}`);
    return;
  }
  console.log("mode: photos | prompts | image");
}

main().then(async () => { await prisma.$disconnect(); process.exit(0); }).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
