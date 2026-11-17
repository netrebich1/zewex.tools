import { readFile } from "fs/promises";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { uploadMedia, rewriteLinkDomain, mediaUrlOnDomain, safeFilename, type WpCreds } from "@/lib/pins/wp/client";
import { toCleanJpeg } from "@/lib/pins/images";
import { safeFetch } from "@/lib/pins/fetch";
import { absPath, itemImageRel, writeFileAtomic } from "@/lib/pins/storage";
import type { StageHandler } from "./index";
import { failItem, loadRunCtx, notRetryYet, okPatch, runQueue, type ItemOutcome } from "./_shared";

/**
 * Этап upload: одобренные пины с картинкой и текстами → медиатека WordPress (чистый JPEG).
 * Фото статьи сначала скачиваются и пересобираются в JPEG. До 3 загрузок одновременно.
 */
export const upload: StageHandler = async (ctx) => {
  const rc = await loadRunCtx(ctx);
  const connId = rc.recipe.publishing.wpConnectionId || rc.site.wpConnectionId;
  if (!connId) return { fatal: "У сайта не выбрано подключение WordPress. Откройте сайт → Рецепт → «WordPress для медиатеки»." };
  const conn = await prisma.siteAccess.findUnique({ where: { id: connId } });
  if (!conn) return { fatal: "Подключение WordPress не найдено. Выберите другое в рецепте сайта." };
  const creds: WpCreds = { baseUrl: conn.mediaBaseUrl || conn.baseUrl, username: conn.mediaUsername || conn.username, appPassword: decryptSecret(conn.mediaAppPasswordEnc || conn.appPasswordEnc) };

  const items = await prisma.pinRunItem.findMany({
    where: { runId: rc.run.id, status: "READY", moderation: "APPROVED", wpMediaUrl: "", title: { not: "" }, AND: [{ OR: [{ imagePath: { not: "" } }, { sourceImageUrl: { not: "" } }] }, notRetryYet()] },
    orderBy: { sortOrder: "asc" },
    include: { page: { select: { url: true, finalUrl: true, keyword: true } } },
  });
  await ctx.tick({ done: 0, total: items.length, label: "Загрузка в WordPress" });
  if (!items.length) return { summary: "всё загружено" };
  const acc: ItemOutcome = { retry: 0 };
  let done = 0;

  await runQueue(items, 3, async (it) => {
    if (ctx.signal.aborted || acc.fatal) return;
    try {
      let data: Buffer;
      if (it.imagePath) {
        data = await readFile(absPath(it.imagePath));
      } else {
        // фото статьи: скачать, пересобрать, сохранить рядом с остальными
        const res = await safeFetch(it.sourceImageUrl, { accept: "image/*", timeoutMs: 25_000, signal: ctx.signal });
        if (!res.ok) throw new Error(`Фото статьи недоступно (HTTP ${res.status})`);
        const jpeg = await toCleanJpeg(res.body, { maxSide: 2000, quality: 88 });
        const rel = itemImageRel(rc.run.id, it.id);
        await writeFileAtomic(rel, jpeg.data);
        await prisma.pinRunItem.update({ where: { id: it.id }, data: { imagePath: rel, imageW: jpeg.width, imageH: jpeg.height } });
        data = jpeg.data;
      }
      const filename = safeFilename(`${it.page.keyword || "pin"}-${it.id.slice(0, 8)}.jpg`);
      const r = await uploadMedia(creds, { data, filename, mime: "image/jpeg" }, { title: it.title.slice(0, 120), altText: it.altText.slice(0, 480) }, { signal: ctx.signal });
      const url = mediaUrlOnDomain(r.url, conn.mediaDomain);
      const link = it.targetLink || (it.kind === "pin" ? it.page.finalUrl || it.page.url : "");
      await prisma.pinRunItem.update({ where: { id: it.id }, data: { wpMediaUrl: url, wpMediaId: String(r.id), targetLink: link ? rewriteLinkDomain(link, rc.recipe.publishing.linkDomain || conn.linkDomain) : "", ...okPatch } });
    } catch (e) {
      await failItem(it, "upload", e, acc);
    }
    done++;
    await ctx.tick({ done, total: items.length, label: `WordPress ${done}/${items.length}` });
  }, ctx.signal);

  if (acc.fatal) return { fatal: acc.fatal };
  return { retryLater: acc.retry, summary: `загружено ${done - acc.retry}, отложено ${acc.retry}` };
};
