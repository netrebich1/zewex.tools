/**
 * Перенос прогона, запущенного не в тот сайт (2026-10-16: статьи zorvianix.com в сайте my-home-ideas.com).
 *   npx tsx scripts/pins/move-run.ts <runId> <toSiteId> --start=YYYY-MM-DD [--drop-sitename=<домен>] [--delete-old-media] [--apply]
 * Без --apply только печатает план. Шаги (с --apply):
 *  1) резервная копия состояния пинов → storage/pins/runs/<runId>/move-backup-<время>.json;
 *  2) строки-мусор (хост без точки) удаляются вместе с их пинами;
 *  3) пины, где на ИИ-картинке нарисован старый домен (--drop-sitename), → REMOVED;
 *  4) прогон и пины переходят в новый сайт: доски по теме статьи из досок нового сайта, медиатека — WordPress нового сайта;
 *  5) тексты, загрузка и расписание сбрасываются → этап texts в очередь (дальше upload и schedule идут сами);
 *  6) --delete-old-media: файлы этих пинов удаляются из медиатеки старого WordPress (по wpMediaId).
 */
import { setDefaultResultOrder } from "dns";
import { writeFile } from "fs/promises";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { deleteMedia, mapLimited, type WpCreds } from "@/lib/pins/wp/client";
import { enqueueJob } from "@/lib/pins/jobs";
import { absPath } from "@/lib/pins/storage";

setDefaultResultOrder("ipv4first");
const flag = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const has = (k: string) => process.argv.includes(`--${k}`);

/** Доска нового сайта по теме статьи: ищем по словам темы и ключа в названии доски, иначе первая. */
function boardFor(topic: string, keyword: string, boards: string[]): string {
  const t = `${topic} ${keyword}`.toLowerCase();
  const rules: Array<[RegExp, RegExp]> = [
    [/nail|manicure|ногт|маникюр/, /nail|ногт/i],
    [/hair|haircut|bob|pixie|braid|волос|стрижк/, /hair|волос/i],
    [/outfit|dress|jumpsuit|style|fashion|look|образ|плать/, /outfit|fashion|look|образ/i],
  ];
  for (const [topicRe, boardRe] of rules) {
    if (!topicRe.test(t)) continue;
    const b = boards.find((x) => boardRe.test(x));
    if (b) return b;
  }
  return boards.find((x) => /outfit/i.test(x)) ?? boards[0];
}

async function main() {
  const [runId, toSiteId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const start = flag("start");
  const dropSite = flag("drop-sitename");
  const apply = has("apply");
  if (!runId || !toSiteId || !start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("runId, toSiteId и --start=YYYY-MM-DD обязательны");

  const run = await prisma.pinRun.findUniqueOrThrow({ where: { id: runId } });
  const from = await prisma.pinSite.findUniqueOrThrow({ where: { id: run.siteId } });
  const to = await prisma.pinSite.findUniqueOrThrow({ where: { id: toSiteId } });
  if (from.id === to.id) throw new Error("Прогон уже в этом сайте");
  const toConn = to.wpConnectionId ? await prisma.siteAccess.findUnique({ where: { id: to.wpConnectionId } }) : null;
  if (!toConn) throw new Error(`У сайта ${to.name} нет доступа WordPress`);
  const settings = run.settings as Record<string, unknown> & { publishing?: Record<string, unknown>; schedule?: Record<string, unknown> };
  const oldConnId = (settings.publishing?.wpConnectionId as string) || from.wpConnectionId;
  const oldConn = oldConnId ? await prisma.siteAccess.findUnique({ where: { id: oldConnId } }) : null;
  const boards = (await prisma.pinBoard.findMany({ where: { siteId: to.id }, orderBy: { sortOrder: "asc" } })).map((b) => b.name);
  if (!boards.length) throw new Error(`У сайта ${to.name} нет досок`);

  const pages = await prisma.pinRunPage.findMany({ where: { runId } });
  const junk = pages.filter((p) => { try { return !new URL(p.url).hostname.includes("."); } catch { return true; } });
  const items = await prisma.pinRunItem.findMany({ where: { runId }, select: { id: true, pageId: true, engine: true, status: true, moderation: true, prompt: true, title: true, description: true, altText: true, boardName: true, wpMediaUrl: true, wpMediaId: true, targetLink: true, scheduledAt: true, siteId: true } });
  const drop = dropSite ? items.filter((i) => i.engine !== "PHOTO" && i.prompt.includes(dropSite) && i.status !== "REMOVED") : [];
  const media = items.filter((i) => i.wpMediaId);
  const pageBoard = new Map(pages.map((p) => [p.id, boardFor(p.topic, p.keyword, boards)]));
  const boardCount = new Map<string, number>();
  for (const p of pages) boardCount.set(pageBoard.get(p.id)!, (boardCount.get(pageBoard.get(p.id)!) ?? 0) + 1);

  console.log(`прогон ${run.id}: ${from.name} → ${to.name}`);
  console.log(`статей ${pages.length}, мусорных строк ${junk.length} (${junk.map((p) => p.url).join(", ")})`);
  console.log(`пинов ${items.length}; убрать с подписью «${dropSite}»: ${drop.length}; файлов в старой медиатеке: ${media.length} (${oldConn?.baseUrl})`);
  console.log(`доски ${to.name}: ${[...boardCount.entries()].map(([b, n]) => `${b} — ${n} стат.`).join("; ")}`);
  console.log(`новая медиатека: ${toConn.baseUrl}; расписание с ${start}`);
  if (!apply) { console.log("\nэто план; для выполнения добавьте --apply"); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = absPath(`pins/runs/${runId}/move-backup-${stamp}.json`);
  await writeFile(backup, JSON.stringify({ run: { siteId: run.siteId, settings: run.settings, stage: run.stage, status: run.status }, pages: pages.map((p) => ({ id: p.id, url: p.url, boards: p.boards })), items }, null, 0));
  console.log(`резервная копия: ${backup}`);

  await prisma.$transaction(async (tx) => {
    if (junk.length) {
      await tx.pinRunItem.deleteMany({ where: { runId, pageId: { in: junk.map((p) => p.id) } } });
      await tx.pinRunPage.deleteMany({ where: { id: { in: junk.map((p) => p.id) } } });
    }
    if (drop.length) await tx.pinRunItem.updateMany({ where: { id: { in: drop.map((i) => i.id) } }, data: { status: "REMOVED", scheduledAt: null } });
    const byBoard = new Map<string, string[]>();
    for (const p of pages) if (!junk.includes(p)) byBoard.set(pageBoard.get(p.id)!, [...(byBoard.get(pageBoard.get(p.id)!) ?? []), p.id]);
    for (const [board, ids] of byBoard) await tx.pinRunPage.updateMany({ where: { id: { in: ids } }, data: { boards: [board] } });
    await tx.pinRunItem.updateMany({
      where: { runId },
      data: { siteId: to.id, boardName: "", title: "", description: "", altText: "", wpMediaUrl: "", wpMediaId: null, targetLink: "", scheduledAt: null },
    });
    await tx.pinRun.update({
      where: { id: runId },
      data: {
        siteId: to.id,
        stage: "moderation",
        status: "QUEUED",
        blockedReason: null,
        settings: {
          ...settings,
          siteName: to.name,
          publishing: { ...(settings.publishing ?? {}), wpConnectionId: toConn.id },
          schedule: { ...(settings.schedule ?? {}), startFrom: start },
          movedFrom: { siteId: from.id, siteName: from.name, at: new Date().toISOString(), backup },
        } as object,
      },
    });
  });
  await enqueueJob(runId, "texts");
  console.log("прогон перенесён, этап texts в очереди");

  if (has("delete-old-media") && oldConn) {
    const creds: WpCreds = { baseUrl: oldConn.mediaBaseUrl || oldConn.baseUrl, username: oldConn.mediaUsername || oldConn.username, appPassword: decryptSecret(oldConn.mediaAppPasswordEnc || oldConn.appPasswordEnc) };
    let ok = 0, missing = 0, failed = 0;
    await mapLimited(media, 4, async (i) => {
      try { (await deleteMedia(creds, i.wpMediaId!, { timeoutMs: 30_000, maxRetries: 2 })) === "deleted" ? ok++ : missing++; }
      catch (e) { failed++; if (failed <= 5) console.log((e as Error).message); }
      if ((ok + missing + failed) % 200 === 0) console.log(`медиа: ${ok + missing + failed}/${media.length}`);
    });
    console.log(`старая медиатека ${oldConn.baseUrl}: удалено ${ok}, уже не было ${missing}, ошибок ${failed}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
