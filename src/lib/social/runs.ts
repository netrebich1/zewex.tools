/**
 * Прогоны «Соцсетей»: доступ, создание, очередь статей для воркера, обработка статьи, повтор, правка поста, шаблон Metricool.
 * Прогон видят автор, участники команды WexOra и админы. Очередь — по статьям (SocialItem).
 */
import { Prisma, type SocialItem, type SocialRun } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { loadArticle } from "./article";
import { assertSocialKey, generatePosts, socialKeyTeamId } from "./generate";
import { hostedImages, removeRunFiles } from "./images";
import { addDays, DEFAULT_HEADER } from "./metricool";
import { ITEM_LEASE_SECONDS, MAX_RUN_ITEMS, networkOf, parseSettings, type NetworkKey, type SocialPosts, type SocialSettings } from "./types";

/* ---------- Доступ ---------- */

export function runWhere(me: CurrentUser): Prisma.SocialRunWhereInput {
  if (me.role === "ADMIN") return {};
  return { OR: [{ createdById: me.id }, ...(me.teamIds.length ? [{ teamId: { in: me.teamIds } }] : [])] };
}

export async function requireRun(me: CurrentUser, id: string): Promise<SocialRun> {
  const run = await prisma.socialRun.findFirst({ where: { id, ...runWhere(me) } });
  if (!run) throw new Error("Прогон не найден");
  return run;
}

export async function requireItem(me: CurrentUser, id: string): Promise<SocialItem & { run: SocialRun }> {
  const item = await prisma.socialItem.findUnique({ where: { id }, include: { run: true } });
  if (!item) throw new Error("Статья не найдена");
  await requireRun(me, item.runId);
  return item;
}

/* ---------- Создание ---------- */

/** Ссылки из текста: по одной в строке (или через пробел), без повторов; строки без адреса — в ошибки. */
export function parseUrls(text: string): { urls: string[]; bad: string[] } {
  const urls: string[] = [];
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    let u: URL | null = null;
    try {
      u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      u = null;
    }
    if (!u || !u.hostname.includes(".")) {
      bad.push(raw.slice(0, 80));
      continue;
    }
    u.hash = "";
    const key = u.toString().replace(/\/$/, "");
    if (!seen.has(key)) {
      seen.add(key);
      urls.push(u.toString());
    }
  }
  return { urls, bad };
}

export async function createRun(me: CurrentUser, name: string, urlsText: string, settings: SocialSettings): Promise<string> {
  const { urls, bad } = parseUrls(urlsText);
  if (bad.length) throw new Error(`Не похоже на ссылки: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` и ещё ${bad.length - 5}` : ""}`);
  if (!urls.length) throw new Error("Вставьте хотя бы одну ссылку на статью");
  if (urls.length > MAX_RUN_ITEMS) throw new Error(`В одном прогоне не больше ${MAX_RUN_ITEMS} статей (вставлено ${urls.length})`);
  if (!settings.networks.length) throw new Error("Отметьте хотя бы одну соцсеть");
  await assertSocialKey(me.id);
  const host = new URL(urls[0]).hostname.replace(/^www\./, "");
  const run = await prisma.socialRun.create({
    data: {
      teamId: await socialKeyTeamId(),
      createdById: me.id,
      name: name.trim().slice(0, 120) || `${host} · ${new Date().toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Kyiv" })}`,
      settings: settings as unknown as Prisma.InputJsonValue,
      total: urls.length,
    },
    select: { id: true },
  });
  await prisma.socialItem.createMany({ data: urls.map((url, i) => ({ runId: run.id, position: i, url })) });
  return run.id;
}

/* ---------- Очередь (воркер) ---------- */

export async function claimItem(workerId: string): Promise<(SocialItem & { run: SocialRun }) | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; runId: string }>>`
    SELECT i.id, i.runId FROM SocialItem i JOIN SocialRun r ON r.id = i.runId
    WHERE i.status = 'pending' AND r.status IN ('QUEUED', 'RUNNING')
    ORDER BY r.createdAt ASC, i.position ASC LIMIT 8`;
  for (const r of rows) {
    const n = await prisma.$executeRaw`UPDATE SocialItem SET status = 'processing', workerId = ${workerId}, attempts = attempts + 1,
      leaseUntil = DATE_ADD(NOW(3), INTERVAL ${ITEM_LEASE_SECONDS} SECOND) WHERE id = ${r.id} AND status = 'pending'`;
    if (n !== 1) continue;
    await prisma.$executeRaw`UPDATE SocialRun SET status = 'RUNNING', startedAt = COALESCE(startedAt, NOW(3)) WHERE id = ${r.runId} AND status = 'QUEUED'`;
    return prisma.socialItem.findUniqueOrThrow({ where: { id: r.id }, include: { run: true } });
  }
  return null;
}

/** Статьи, чей воркер умер (аренда истекла) или остались от прошлого процесса этого хоста, — снова в очередь. */
export async function requeueStaleItems(hostPrefix?: string): Promise<number> {
  return prisma.$executeRaw`UPDATE SocialItem SET status = 'pending', workerId = NULL, leaseUntil = NULL
    WHERE status = 'processing' AND (leaseUntil < NOW(3) ${hostPrefix ? Prisma.sql`OR workerId LIKE ${hostPrefix + "-%"}` : Prisma.empty})`;
}

export async function refreshRunStatus(runId: string): Promise<void> {
  const groups = await prisma.socialItem.groupBy({ by: ["status"], where: { runId }, _count: { _all: true }, _sum: { costUsd: true } });
  const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
  const costUsd = groups.reduce((a, g) => a + (g._sum.costUsd ?? 0), 0);
  if (n("pending") + n("processing") > 0) {
    await prisma.socialRun.update({ where: { id: runId }, data: { costUsd } }).catch(() => undefined);
    return;
  }
  const errors = n("error");
  await prisma.socialRun.update({
    where: { id: runId },
    data: { status: n("done") === 0 && errors > 0 ? "FAILED" : "DONE", finishedAt: new Date(), costUsd, error: errors ? `${errors} статей с ошибкой` : null },
  }).catch(() => undefined);
}

/** Одна статья: загрузка → посты всех сетей прогона. Ошибка статьи не останавливает прогон. */
export async function processItem(item: SocialItem & { run: SocialRun }): Promise<void> {
  const settings = parseSettings(item.run.settings);
  try {
    const article = await loadArticle(item.url);
    const { posts, costUsd } = await generatePosts({ userId: item.run.createdById, runId: item.runId, url: item.url, article, settings, nets: settings.networks, prepareImages: (net, images) => hostedImages(item.runId, net, images) });
    await prisma.socialItem.update({
      where: { id: item.id },
      data: { status: "done", title: article.title.slice(0, 1000), posts: posts as unknown as Prisma.InputJsonValue, imageCount: article.images.length, costUsd: { increment: costUsd }, error: null, workerId: null, leaseUntil: null, finishedAt: new Date() },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.socialItem.update({ where: { id: item.id }, data: { status: "error", error: msg.slice(0, 2000), workerId: null, leaseUntil: null, finishedAt: new Date() } });
  }
}

/* ---------- Управление ---------- */

export async function retryItems(me: CurrentUser, runId: string, which: "failed" | string): Promise<number> {
  const run = await requireRun(me, runId);
  const where: Prisma.SocialItemWhereInput = which === "failed" ? { runId, status: "error" } : { runId, id: which, status: { in: ["error", "done"] } };
  const r = await prisma.socialItem.updateMany({ where, data: { status: "pending", error: null, attempts: 0 } });
  if (r.count) await prisma.socialRun.update({ where: { id: run.id }, data: { status: "QUEUED", finishedAt: null, error: null } });
  return r.count;
}

export async function deleteRun(me: CurrentUser, id: string): Promise<void> {
  const run = await requireRun(me, id);
  if (await prisma.socialItem.count({ where: { runId: id, status: "processing" } })) throw new Error("Прогон ещё пишет посты — дождитесь окончания");
  await prisma.socialRun.delete({ where: { id: run.id } });
  await removeRunFiles(run.id);
}

/** Сколько дней после последней публикации прогона хранить его фото (Metricool берёт фото по ссылке). */
export const FILES_KEEP_DAYS = 14;

/** Уборка раз в сутки: фото прогонов, у которых последняя публикация была больше FILES_KEEP_DAYS назад. Посты и тексты остаются. */
export async function purgeOldFiles(): Promise<number> {
  const runs = await prisma.socialRun.findMany({ where: { filesPurgedAt: null, status: { in: ["DONE", "FAILED"] } }, select: { id: true, settings: true, total: true } });
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const r of runs) {
    const s = parseSettings(r.settings);
    const lastDay = addDays(s.schedule.startDate, Math.floor(Math.max(0, r.total - 1) / s.schedule.perDay));
    if (addDays(lastDay, FILES_KEEP_DAYS) >= today) continue;
    await removeRunFiles(r.id);
    await prisma.socialRun.update({ where: { id: r.id }, data: { filesPurgedAt: new Date() } });
    n++;
  }
  return n;
}

/** Ручная правка текста поста одной сети. Лимит сети проверяется: длиннее Metricool не примет. */
export async function savePostText(me: CurrentUser, itemId: string, net: string, text: string): Promise<void> {
  const item = await requireItem(me, itemId);
  const spec = networkOf(net);
  if (!spec) throw new Error("Неизвестная сеть");
  const clean = text.replace(/\r\n/g, "\n").trim();
  const urls = clean.match(/https?:\/\/\S+/g) ?? [];
  const len = spec.key === "x" ? clean.length - urls.reduce((a, u) => a + u.length - 23, 0) : clean.length;
  if (len > spec.maxChars) throw new Error(`${spec.label}: ${len} знаков, лимит ${spec.maxChars}`);
  const posts = ((item.posts ?? {}) as SocialPosts) || {};
  const post = posts[spec.key as NetworkKey];
  if (!post) throw new Error("У статьи нет поста для этой сети");
  posts[spec.key as NetworkKey] = { ...post, text: clean, trimmed: undefined, edited: true };
  await prisma.socialItem.update({ where: { id: itemId }, data: { posts: posts as unknown as Prisma.InputJsonValue } });
}

/** Сдвиг расписания готового прогона: первый день, статей в день, окно. Время считается при выгрузке. */
export async function saveSchedule(me: CurrentUser, runId: string, patch: Partial<SocialSettings["schedule"]> & { brand?: string; draft?: boolean }): Promise<void> {
  const run = await requireRun(me, runId);
  const cur = parseSettings(run.settings);
  const { brand, draft, ...sch } = patch;
  const next = parseSettings({ ...cur, brand: brand ?? cur.brand, draft: draft ?? cur.draft, schedule: { ...cur.schedule, ...sch } });
  // Новые даты — фото снова нужны: если их уже убрали, уборка не должна считать прогон обработанным (файлы вернёт «Написать заново»).
  await prisma.socialRun.update({ where: { id: runId }, data: { settings: next as unknown as Prisma.InputJsonValue } });
}

/* ---------- Списки ---------- */

export async function listRuns(me: CurrentUser, take = 100) {
  const runs = await prisma.socialRun.findMany({ where: runWhere(me), orderBy: { createdAt: "desc" }, take });
  if (!runs.length) return [];
  const groups = await prisma.socialItem.groupBy({ by: ["runId", "status"], where: { runId: { in: runs.map((r) => r.id) } }, _count: { _all: true } });
  return runs.map((r) => {
    const n = (s: string) => groups.find((g) => g.runId === r.id && g.status === s)?._count._all ?? 0;
    return { ...r, counts: { pending: n("pending"), processing: n("processing"), done: n("done"), error: n("error") } };
  });
}

/* ---------- Шаблон Metricool ---------- */

const TEMPLATE_ID = "metricool";

export async function metricoolHeader(): Promise<{ header: string[]; custom: boolean; updatedAt: Date | null }> {
  const row = await prisma.socialTemplate.findUnique({ where: { id: TEMPLATE_ID } });
  const header = Array.isArray(row?.header) ? (row!.header as unknown[]).map(String) : [];
  return header.length ? { header, custom: true, updatedAt: row!.updatedAt } : { header: DEFAULT_HEADER, custom: false, updatedAt: null };
}

export async function saveMetricoolHeader(me: CurrentUser, header: string[] | null): Promise<void> {
  if (!header) {
    await prisma.socialTemplate.deleteMany({ where: { id: TEMPLATE_ID } });
    return;
  }
  await prisma.socialTemplate.upsert({ where: { id: TEMPLATE_ID }, update: { header, updatedById: me.id }, create: { id: TEMPLATE_ID, header, updatedById: me.id } });
}
