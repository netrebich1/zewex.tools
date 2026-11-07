/**
 * Article Copy, партии: владелец задаёт «сколько статей по нишам и частотности на какие сайты», планировщик
 * раскладывает темы по сайтам (CopyBatchItem), воркер собирает пункты по порядку (copyBatchTick), текст и
 * публикацию делает очередь сервиса «Статьи». Партия — основной способ запуска; суточная автосборка — побочный.
 */
import { prisma } from "@/lib/db";
import { copySettings } from "./build";
import { buildCopyArticle, copySitesToday, siteNiches } from "./auto";
import { SHARED_TEAM, VOL_CLASSES, VOL_LABEL, clusterWords, groupOf, isSeasonal, nicheLabel } from "./keys";

const ITEMS_PER_TICK = 15;
let running = false;

export type QuotaClass = (typeof VOL_CLASSES)[number] | "any";
export type Quotas = Record<string, Partial<Record<QuotaClass, number>>>;
export type BatchInput = { name: string; siteIds: string[]; quotas: Quotas; word: string; /** Только эти ядра (точное совпадение), в этом порядке — для ручных и тестовых партий. */ cores?: string[]; photos: number; photosMax?: number | null; maxPerWord?: number; review: boolean; noSeason: boolean; year: number | null; createdById: string };
export const QUOTA_CLASSES: QuotaClass[] = [...VOL_CLASSES, "any"];

type CoreRow = { id: string; niche: string; core: string; volClass: string | null; volume: number | null; byPhotos: number; siteIds: unknown };

/** Сколько ядер есть в каждой клетке «ниша × класс» (без учёта сайтов) — для формы новой партии. */
export async function availability(word = "", noSeason = true): Promise<Record<string, Record<string, number>>> {
  const st = await copySettings();
  const w = word.trim().toLowerCase();
  const rows = await prisma.copyCore.findMany({
    where: { ...(st.sharedBank ? { teamId: SHARED_TEAM } : {}), byPhotos: { gt: 0 }, core: { contains: w || " " } },
    select: { niche: true, core: true, volClass: true },
  });
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    if (!r.core.includes(" ") || (noSeason && isSeasonal(r.core))) continue;
    const n = (out[r.niche] ??= { hi: 0, mid: 0, low: 0, any: 0 });
    n.any++;
    if (r.volClass && r.volClass in n) n[r.volClass]++;
  }
  return out;
}

/** Создать партию: выбрать темы под квоты и разложить по сайтам. */
export async function planBatch(input: BatchInput): Promise<{ id: string; planned: number; note: string }> {
  const st = await copySettings();
  const sites = await prisma.artSite.findMany({ where: { id: { in: input.siteIds }, isActive: true }, select: { id: true, teamId: true, name: true, nicheCode: true } });
  if (!sites.length) throw new Error("Не выбран ни один сайт");
  const siteInfo = await Promise.all(sites.map(async (s) => {
    const niches = await siteNiches(s.id);
    const grp = s.nicheCode || niches.size ? groupOf(s.nicheCode ?? [...niches.keys()][0]) : null;
    return { ...s, grp, niches, count: 0 };
  }));
  const unknown = siteInfo.filter((s) => !s.grp).map((s) => s.name);
  const usable = siteInfo.filter((s) => s.grp);
  if (!usable.length) throw new Error(`У сайтов ${unknown.join(", ")} нет статей и не указана ниша — неизвестно, какие темы им подходят`);

  const teamIds = [...new Set(usable.map((s) => s.teamId))];
  const word = input.word.trim().toLowerCase();
  const only = input.cores?.map((c) => c.trim().toLowerCase()).filter(Boolean);
  let cores: CoreRow[] = await prisma.copyCore.findMany({
    where: { teamId: st.sharedBank ? SHARED_TEAM : { in: teamIds }, byPhotos: { gt: 0 }, ...(only?.length ? { core: { in: only } } : { core: { contains: word || " " } }) },
    orderBy: [{ photosReserve: "desc" }, { photosPublished: "desc" }],
    select: { id: true, niche: true, core: true, volClass: true, volume: true, byPhotos: true, siteIds: true },
  });
  if (only?.length) cores = only.map((c) => cores.find((r) => r.core === c)).filter((r): r is CoreRow => !!r);
  // Темы, уже собранные мешапом (карта может отставать на часы): ядро на сайте — больше не ставим.
  const done = new Set((await prisma.copyArticle.findMany({ select: { siteId: true, niche: true, core: true } })).map((a) => `${a.siteId}|${a.niche}|${a.core}`));

  const items: Array<{ niche: string; core: string; volClass: string | null; volume: number | null; siteId: string }> = [];
  const usedCores = new Set<string>();
  // Разнообразие семантики: слово ядра («almond», «bob», «linen») — не чаще maxPerWord раз на партию.
  const maxPerWord = Math.max(1, input.maxPerWord ?? 3);
  const wordCount = new Map<string, number>();
  const diverse = (core: string) => clusterWords(core).every((w) => (wordCount.get(w) ?? 0) < maxPerWord);
  const takeWords = (core: string) => { for (const w of clusterWords(core)) wordCount.set(w, (wordCount.get(w) ?? 0) + 1); };
  const shortfalls: string[] = [];
  const fits = (s: (typeof usable)[number], c: CoreRow) =>
    s.grp === groupOf(c.niche) && (!s.niches.size || s.niches.has(c.niche)) && !((c.siteIds as string[] | null) ?? []).includes(s.id) && !done.has(`${s.id}|${c.niche}|${c.core}`);

  for (const [niche, q] of Object.entries(input.quotas)) {
    for (const cls of QUOTA_CLASSES) {
      const want = Math.max(0, Math.floor(q[cls] ?? 0));
      if (!want) continue;
      let got = 0;
      for (const c of cores) {
        if (got >= want) break;
        if (c.niche !== niche || !c.core.includes(" ") || (input.noSeason && isSeasonal(c.core)) || usedCores.has(`${c.niche}|${c.core}`)) continue;
        if (cls !== "any" && c.volClass !== cls) continue;
        if (!diverse(c.core)) continue;
        // Сайт с наименьшим числом статей в партии, которому тема подходит, — раскладка получается ровной.
        const site = usable.filter((s) => fits(s, c)).sort((a, b) => a.count - b.count)[0];
        if (!site) continue;
        site.count++;
        usedCores.add(`${c.niche}|${c.core}`);
        takeWords(c.core);
        items.push({ niche: c.niche, core: c.core, volClass: c.volClass, volume: c.volume, siteId: site.id });
        got++;
      }
      if (got < want) shortfalls.push(`${nicheLabel(niche)} · ${VOL_LABEL[cls]}: нашлось ${got} из ${want}`);
    }
  }
  const notes = [...shortfalls];
  if (unknown.length) notes.push(`Пропущены сайты без статей и ниши: ${unknown.join(", ")}`);
  const noWriting = (await copySitesToday()).filter((s) => usable.some((u) => u.id === s.id) && !s.writingOn).map((s) => s.name);
  if (noWriting.length) notes.push(`У сайтов ${noWriting.join(", ")} выключено «Написание» в «Статьях» — собранные статьи будут ждать, пока его не включат`);
  const note = notes.join("\n") || null;

  const batch = await prisma.copyBatch.create({
    data: {
      name: input.name.trim() || `Партия ${new Date().toLocaleDateString("ru-RU")}`, createdById: input.createdById, status: items.length ? "running" : "done",
      siteIds: usable.map((s) => s.id), quotas: input.quotas, word, photos: input.photos, photosMax: input.photosMax && input.photosMax > input.photos ? input.photosMax : null, maxPerWord, review: input.review, noSeason: input.noSeason, year: input.year, planned: items.length, note, finishedAt: items.length ? null : new Date(),
    },
    select: { id: true },
  });
  for (let i = 0; i < items.length; i += 500) {
    await prisma.copyBatchItem.createMany({ data: items.slice(i, i + 500).map((it, j) => ({ ...it, batchId: batch.id, position: i + j + 1 })) });
  }
  return { id: batch.id, planned: items.length, note: note ?? "" };
}

/** Тик воркера (раз в минуту): собирает до ITEMS_PER_TICK пунктов идущих партий, старшие партии раньше. */
export async function copyBatchTick(): Promise<{ built: number; failed: number }> {
  if (running) return { built: 0, failed: 0 };
  const batches = await prisma.copyBatch.findMany({ where: { status: "running" }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, photos: true, photosMax: true, review: true, year: true } });
  if (!batches.length) return { built: 0, failed: 0 };
  running = true;
  let built = 0, failed = 0;
  try {
    const st = await copySettings();
    for (const b of batches) {
      if (built + failed >= ITEMS_PER_TICK) break;
      const items = await prisma.copyBatchItem.findMany({ where: { batchId: b.id, status: "pending" }, orderBy: { position: "asc" }, take: ITEMS_PER_TICK - built - failed });
      if (!items.length) {
        await prisma.copyBatch.update({ where: { id: b.id }, data: { status: "done", finishedAt: new Date() } });
        continue;
      }
      for (const it of items) {
        const site = await prisma.artSite.findUnique({ where: { id: it.siteId }, select: { id: true, teamId: true, name: true, nicheCode: true } });
        const row = site && (await prisma.copyCore.findFirst({ where: { teamId: st.sharedBank ? SHARED_TEAM : site.teamId, niche: it.niche, core: it.core }, select: { niche: true, core: true, formulations: true } }));
        let result: Awaited<ReturnType<typeof buildCopyArticle>>;
        if (!site) result = { ok: false, core: it.core, reason: "сайт удалён или выключен" };
        else if (!row) result = { ok: false, core: it.core, reason: "ядра больше нет в карте" };
        else result = await buildCopyArticle(site, st, row, { review: b.review, photos: b.photosMax ? b.photos + Math.floor(Math.random() * (b.photosMax - b.photos + 1)) : b.photos, batchId: b.id, runName: `Article Copy · ${b.name}`, year: b.year ?? undefined }).catch((e) => ({ ok: false as const, core: it.core, reason: e instanceof Error ? e.message : String(e) }));
        if (result.ok) {
          built++;
          await prisma.$transaction([
            prisma.copyBatchItem.update({ where: { id: it.id }, data: { status: "done", articleId: result.articleId, keyword: result.keyword, doneAt: new Date() } }),
            prisma.copyBatch.update({ where: { id: b.id }, data: { built: { increment: 1 } } }),
          ]);
        } else {
          failed++;
          await prisma.$transaction([
            prisma.copyBatchItem.update({ where: { id: it.id }, data: { status: "failed", reason: result.reason.slice(0, 2000), doneAt: new Date() } }),
            prisma.copyBatch.update({ where: { id: b.id }, data: { failed: { increment: 1 } } }),
          ]);
        }
        // Партию могли поставить на паузу с экрана.
        const fresh = await prisma.copyBatch.findUnique({ where: { id: b.id }, select: { status: true } });
        if (fresh?.status !== "running") break;
      }
    }
    return { built, failed };
  } finally {
    running = false;
  }
}
