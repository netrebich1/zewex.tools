import { requeueStale } from "./queue";
import { log } from "./log";
import { domainsRequeueStale } from "./domains";
import { requeueStaleArticles } from "./articles";
import { requeueStalePosts } from "./blog";
import { autostartTick } from "./articles/autostart";
import { purgePublishedBacklog } from "@/lib/articles/wp/cleanup";
import { measureStorage } from "@/lib/articles/storage";
import { prisma } from "@/lib/db";
import { purgeOldRuns } from "@/lib/pins/runs/cleanup";
import { autoResumeKeyBlockedRuns } from "@/lib/pins/runs/autoResume";
import { resyncSheets } from "@/lib/articles/sheets";
import { failedKeywordsTick } from "@/lib/articles/failedKeywords";
import { deeplCheckKeys, deeplPurgeCache, deeplRequeueStale } from "./deepl";
import { analyticsPurge, analyticsRequeueStale } from "./analytics";
import { keywordsArticleDatesTick, keywordsDaily, keywordsRequeueStale, keywordsStyleTick } from "./keywords";
import { uploaderTick } from "@/lib/uploader/runs";
import { newsDaily, newsFailStale } from "./news";
import { tasksTick } from "./tasks";
import { copyTick } from "@/lib/copy/build";
import { copyAutoTick } from "@/lib/copy/auto";
import { copyBatchTick } from "@/lib/copy/batch";

/** Периодические задачи воркера: сторож зависших задач, уборка (позже). */
export function startCron(): () => void {
  const timers: NodeJS.Timeout[] = [];
  timers.push(setInterval(() => requeueStale().catch((e) => log.warn("requeueStale failed", e)), 5 * 60_000));
  timers.push(setInterval(() => domainsRequeueStale().catch((e) => log.warn("domains requeueStale failed", e)), 5 * 60_000));
  // Уборка прогонов старше 90 дней после последнего пина: раз в сутки и через минуту после старта.
  const purge = () => purgeOldRuns().then((r) => { if (r.deleted.length) log.info(`purged ${r.deleted.length} old runs`); }).catch((e) => log.warn("purgeOldRuns failed", e));
  timers.push(setTimeout(purge, 60_000));
  timers.push(setInterval(purge, 24 * 60 * 60_000));
  // Ключи ИИ: автоотключённые (нет баланса / отклонён) проверяются настоящим запросом и включаются обратно,
  // прогоны пинов, вставшие из-за ключа, продолжаются сами — через 2 мин после старта и каждые 10 мин.
  const keys = () => autoResumeKeyBlockedRuns().then((r) => {
    if (r.keysEnabled.length) log.info(`keys re-enabled after check: ${r.keysEnabled.join(", ")}`);
    if (r.resumed.length) log.info(`pins runs auto-resumed after key check: ${r.resumed.join(", ")}`);
    if (r.waiting) log.info(`pins runs still waiting for a working key: ${r.waiting}`);
  }).catch((e) => log.warn("key health check failed", e));
  timers.push(setTimeout(keys, 2 * 60_000), setInterval(keys, 10 * 60_000));
  timers.push(setInterval(() => requeueStaleArticles().catch((e) => log.warn("articles requeueStale failed", e)), 5 * 60_000));
  // Инфо-статьи (Pin Blog Article): посты с истёкшей арендой — в очередь.
  timers.push(setInterval(() => requeueStalePosts().catch((e) => log.warn("blog requeueStale failed", e)), 5 * 60_000));
  // Статьи: файлы фото опубликованных статей — каждые 30 мин. Строки опубликованных статей НЕ удаляются (аудит 2026-10-14):
  // журнал, расходы, защита от повторного ключа и досылка в Google Таблицу живут на них.
  timers.push(setInterval(() => purgePublishedBacklog(50).catch((e) => log.warn("articles purgePublishedBacklog failed", e)), 30 * 60_000));
  // Статьи: разовая миграция старых настроек автозапуска (выключение по простою убрано 2026-10-15, см. worker/articles/autostart.ts).
  timers.push(setInterval(() => autostartTick().then((r) => { if (r.enabled || r.disabled) log.info(`articles autostart: enabled ${r.enabled}, disabled ${r.disabled}`); }).catch((e) => log.warn("articles autostartTick failed", e)), 60_000));
  // Статьи: досылка отчётов в Google Таблицы, которые не записались при публикации (оригинал: publish-worker, каждый тик).
  timers.push(setInterval(() => resyncSheets(10).then((r) => { if (r.tried) log.info(`articles sheets resync: ${r.ok}/${r.tried}`); }).catch((e) => log.warn("articles resyncSheets failed", e)), 5 * 60_000));
  // Статьи: место на диске для экрана «Автозапуск» (данные хранятся, решение 2026-10-19) — через 2 мин после старта и раз в 30 мин.
  const disk = () => measureStorage().then((d) => prisma.artSettings.upsert({ where: { id: "main" }, update: { ...d, storageAt: new Date() }, create: { id: "main", ...d, storageAt: new Date() } })).catch((e) => log.warn("articles measureStorage failed", e));
  timers.push(setTimeout(disk, 2 * 60_000), setInterval(disk, 30 * 60_000));
  // Статьи: список «Неудачные ключи» — полный проход через 90 с после старта (он же бэкфилл), затем изменения каждые 10 мин.
  const failedKw = (full: boolean) => () => failedKeywordsTick(full).then((r) => { if (r.created || r.updated || r.orphansDeleted) log.info(`articles failed keywords${r.full ? " (full)" : ""}: +${r.created}, ~${r.updated}, -${r.orphansDeleted}`); }).catch((e) => log.warn("articles failedKeywords failed", e));
  timers.push(setTimeout(failedKw(true), 90_000), setInterval(failedKw(false), 10 * 60_000));
  // DeepL Articler: статьи с истёкшей арендой — в очередь; кэш переводов старше 90 дней — раз в сутки.
  timers.push(setInterval(() => deeplRequeueStale().catch((e) => log.warn("deepl requeueStale failed", e)), 2 * 60_000));
  timers.push(setInterval(() => deeplPurgeCache().catch((e) => log.warn("deepl purgeCache failed", e)), 24 * 60 * 60_000));
  // Ключи DeepL: проверка в DeepL раз в час (итог и остаток — в списке ключей).
  timers.push(setInterval(() => deeplCheckKeys().catch((e) => log.warn("deepl keys check failed", e)), 60 * 60_000));
  // Трафик сайтов (GA4): зависшие аренды — каждые 5 мин; часы/страницы/разрезы старше 400 дней — раз в сутки.
  timers.push(setInterval(() => analyticsRequeueStale().catch((e) => log.warn("analytics requeueStale failed", e)), 5 * 60_000));
  timers.push(setInterval(() => analyticsPurge().catch((e) => log.warn("analytics purge failed", e)), 24 * 60 * 60_000));
  // Подбор ключей Pinterest: даты статей топа — через 3 мин после старта и каждые 10 мин; пересчёт оценок и уборка очереди — раз в сутки.
  const artDates = () => keywordsArticleDatesTick().catch((e) => log.warn("keywords articleDates failed", e));
  timers.push(setTimeout(artDates, 3 * 60_000), setInterval(artDates, 10 * 60_000));
  timers.push(setInterval(() => keywordsRequeueStale().catch((e) => log.warn("keywords requeueStale failed", e)), 5 * 60_000));
  // Оформление пинов новых снимков (модель со зрением, слот vision) — каждые 2 мин по 5 снимков.
  timers.push(setInterval(() => keywordsStyleTick().catch((e) => log.warn("keywords styles failed", e)), 2 * 60_000));
  timers.push(setInterval(() => keywordsDaily().catch((e) => log.warn("keywords daily failed", e)), 24 * 60 * 60_000));
  // Заливка в Pinterest (Pin Uploader): агенты офлайн, просроченные аренды, фаза проверки, расписание — раз в минуту.
  timers.push(setInterval(() => uploaderTick().then((r) => { if (r.verify || r.scheduled) log.info(`uploader tick: verify ${r.verify}, scheduled ${r.scheduled}, stale ${r.stale}`); }).catch((e) => log.warn("uploader tick failed", e)), 60_000));
  // Новости (Google Discover): уборка старых инфоповодов, избранного и векторов — только в 04:00 по Киеву (решение владельца 07.11:
  // редакция работает до ночи, а раньше уборка шла через 5 мин после каждого перезапуска, то есть после каждого деплоя, и днём).
  // Проверка раз в минуту; перезапуск в 04:xx повторит уборку — она идемпотентна.
  let newsPurgedDay = "";
  const news = () => {
    const kyiv = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" });
    if (kyiv.slice(11, 13) !== "04" || kyiv.slice(0, 10) === newsPurgedDay) return;
    newsPurgedDay = kyiv.slice(0, 10);
    newsDaily().catch((e) => log.warn("news daily failed", e));
  };
  timers.push(setInterval(news, 60_000));
  // Зависшие прогоны новостей закрываются при старте воркера (newsStartup) и раз в час.
  timers.push(setInterval(() => newsFailStale().catch((e) => log.warn("news failStaleRuns failed", e)), 60 * 60_000));
  // Задачи: регламенты → задачи, дайджесты в Telegram в свой час — раз в минуту (через 30 с после старта).
  const tasks = () => tasksTick().then((r) => { if (r.routines || r.digest) log.info(`tasks tick: routines +${r.routines}${r.digest ? `, digest ${r.digest}` : ""}`); }).catch((e) => log.warn("tasks tick failed", e));
  timers.push(setTimeout(tasks, 30_000), setInterval(tasks, 60_000));
  // Article Copy: карта ключей и запас — пересчёт по запросу с экрана и раз в 6 часов (через 4 мин после старта, затем раз в минуту проверка).
  const copy = () => copyTick().then((r) => { if (r.rebuilt) log.info(`copy map rebuilt: ${r.cores} cores in ${r.ms} ms`); }).catch((e) => log.warn("copy tick failed", e));
  timers.push(setTimeout(copy, 4 * 60_000), setInterval(copy, 60_000));
  // Article Copy, автосборка: если включена — до двух мешап-статей в минуту на привязанные сайты в пределах суточной нормы.
  timers.push(setInterval(() => copyAutoTick().then((r) => { if (r.created) log.info(`copy auto: +${r.created}
${r.note}`); }).catch((e) => log.warn("copy auto failed", e)), 60_000));
  // Article Copy, партии: собирает пункты идущих партий (до 15 в минуту); текст пишет очередь «Статей».
  timers.push(setInterval(() => copyBatchTick().then((r) => { if (r.built || r.failed) log.info(`copy batch: +${r.built} built, ${r.failed} failed`); }).catch((e) => log.warn("copy batch failed", e)), 60_000));
  return () => timers.forEach(clearInterval);
}
