/**
 * Примеры для ИИ-стилей: промт через штатный конвейер (generateAiPrompts) → картинка (aiImage)
 * → PinExample + файл pins/examples/<id>.jpg. Ключи и расход — через портал (правила пользователя).
 *
 *   npx tsx scripts/pins/gen-style-examples.ts --user=<userId> --team=<teamId> --category=modern2027 \
 *     --keyword="trendy outfits 2027" --niche=outfit [--styles=id1,id2] [--force] [--concurrency=4] [--dry]
 *
 * Варианты, у которых пример уже есть, пропускаются (кроме --force).
 */
import { setDefaultResultOrder } from "dns";
import { prisma } from "@/lib/db";
import { listAiStyles } from "@/lib/pins/prompts/aiStyles";
import { generateAiPrompts } from "@/lib/pins/prompts/aiPrompt";
import { aiImage, type AiCtx } from "@/lib/pins/ai/client";
import { toCleanJpeg } from "@/lib/pins/images";
import { exampleRel, writeFileAtomic } from "@/lib/pins/storage";

setDefaultResultOrder("ipv4first");

const flag = (k: string, def = "") => (process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? (process.argv.includes(`--${k}`) ? "1" : def));

async function main() {
  const userId = flag("user"), teamId = flag("team");
  const category = flag("category", "modern2027");
  const keyword = flag("keyword", "trendy outfits 2027");
  const niche = flag("niche", "outfit");
  const only = flag("styles").split(",").map((s) => s.trim()).filter(Boolean);
  const force = flag("force") === "1";
  const dry = flag("dry") === "1";
  const concurrency = Number(flag("concurrency", "4"));
  if (!userId || !teamId) throw new Error("--user и --team обязательны");

  let styles = listAiStyles(category || undefined);
  if (only.length) styles = styles.filter((s) => only.includes(s.id) || only.includes(s.variantOf ?? ""));
  if (!force) {
    const have = new Set((await prisma.pinExample.findMany({ where: { styleId: { in: styles.map((s) => s.id) }, imagePath: { not: "" } }, select: { styleId: true } })).map((e) => e.styleId));
    styles = styles.filter((s) => !have.has(s.id));
  }
  console.log(`styles to render: ${styles.length}`);
  if (!styles.length) return;

  const ctx: AiCtx = { userId, teamId };
  const prompts = await generateAiPrompts(ctx, {
    keyword, topic: keyword, niche, language: "en", audience: "women", siteName: "",
    year: "2027", season: "fall", seasonWord: "fall", ideaCount: 12,
    styles: styles.map((s) => ({ id: s.id, tags: { season: false, year: true, number: s.type === "listicle", siteName: false, cta: true } })),
  });
  console.log(`prompts: ${prompts.length}/${styles.length}`);
  if (dry) { for (const p of prompts) console.log(`\n--- ${p.styleId}\n${p.prompt}`); return; }

  let ok = 0, fail = 0, i = 0;
  const queue = [...prompts];
  const worker = async () => {
    for (;;) {
      const p = queue.shift();
      if (!p) return;
      const n = ++i;
      try {
        const img = await aiImage(ctx, { prompt: p.prompt, size: "1024x1536", quality: "medium" });
        const jpeg = await toCleanJpeg(img.bytes, { maxSide: 1536, quality: 90 });
        const ex = await prisma.pinExample.create({ data: { niche, styleId: p.styleId, topic: keyword, caption: p.prompt, sortOrder: 0 } });
        const rel = exampleRel(ex.id, "jpg");
        await writeFileAtomic(rel, jpeg.data);
        await prisma.pinExample.update({ where: { id: ex.id }, data: { imagePath: rel } });
        ok++;
        console.log(`[${n}/${prompts.length}] ok ${p.styleId}`);
      } catch (e) {
        fail++;
        console.log(`[${n}/${prompts.length}] FAIL ${p.styleId}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`done: ok ${ok}, fail ${fail}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
