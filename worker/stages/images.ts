import { prisma } from "@/lib/db";
import { aiImage } from "@/lib/pins/ai/client";
import { toCleanJpeg, makeThumb } from "@/lib/pins/images";
import { itemImageRel, itemThumbRel, writeFileAtomic } from "@/lib/pins/storage";
import type { StageHandler } from "./index";
import { failItem, loadRunCtx, notRetryYet, okPatch, runQueue, type ItemOutcome } from "./_shared";

const CONCURRENCY = Number(process.env.PINS_IMAGE_CONCURRENCY || 6);

/** Этап images: картинки по готовым промтам (OpenAI gpt-image-2 через слот image_main). */
export const images: StageHandler = async (ctx) => {
  const rc = await loadRunCtx(ctx);
  const items = await prisma.pinRunItem.findMany({
    where: { runId: rc.run.id, kind: "pin", engine: { in: ["OPENAI", "PINORA"] }, prompt: { not: "" }, imagePath: "", status: "PENDING", moderation: { not: "REJECTED" }, ...notRetryYet() },
    orderBy: { sortOrder: "asc" },
  });
  await ctx.tick({ done: 0, total: items.length, label: "Картинки" });
  if (!items.length) return { summary: "картинки готовы" };
  const acc: ItemOutcome = { retry: 0 };
  let done = 0;

  await runQueue(items, CONCURRENCY, async (it) => {
    if (ctx.signal.aborted || acc.fatal) return;
    try {
      const img = await aiImage(rc.ai, { prompt: it.prompt, size: "1024x1536", quality: "low" });
      const jpeg = await toCleanJpeg(img.bytes, { maxSide: 1536, quality: 92 });
      const rel = itemImageRel(rc.run.id, it.id);
      await writeFileAtomic(rel, jpeg.data);
      const thumbRel = itemThumbRel(rc.run.id, it.id);
      await writeFileAtomic(thumbRel, await makeThumb(jpeg.data));
      await prisma.pinRunItem.update({ where: { id: it.id }, data: { imagePath: rel, thumbPath: thumbRel, imageW: jpeg.width, imageH: jpeg.height, status: "READY", ...okPatch } });
    } catch (e) {
      await failItem(it, "images", e, acc);
    }
    done++;
    await ctx.tick({ done, total: items.length, label: `Картинки ${done}/${items.length}` });
  }, ctx.signal);

  if (acc.fatal) return { fatal: acc.fatal };
  return { retryLater: acc.retry, summary: `картинки: ${done}, отложено ${acc.retry}` };
};
