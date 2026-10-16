import { requeueStale } from "./queue";
import { log } from "./log";
import { domainsRequeueStale } from "./domains";
import { requeueStaleArticles } from "./articles";
import { autostartTick } from "./articles/autostart";
import { purgePublishedBacklog } from "@/lib/articles/wp/cleanup";
import { purgeOldRuns } from "@/lib/pins/runs/cleanup";
import { resyncSheets } from "@/lib/articles/sheets";
import { deeplPurgeCache, deeplRequeueStale } from "./deepl";
import { analyticsPurge, analyticsRequeueStale } from "./analytics";

/** Периодические задачи воркера: сторож зависших задач, уборка (позже). */
export function startCron(): () => void {
  const timers: NodeJS.Timeout[] = [];
  timers.push(setInterval(() => requeueStale().catch((e) => log.warn("requeueStale failed", e)), 5 * 60_000));
  timers.push(setInterval(() => domainsRequeueStale().catch((e) => log.warn("domains requeueStale failed", e)), 5 * 60_000));
  // Уборка прогонов старше 90 дней после последнего пина: раз в сутки и через минуту после старта.
  const purge = () => purgeOldRuns().then((r) => { if (r.deleted.length) log.info(`purged ${r.deleted.length} old runs`); }).catch((e) => log.warn("purgeOldRuns failed", e));
  timers.push(setTimeout(purge, 60_000));
  timers.push(setInterval(purge, 24 * 60 * 60_000));
  timers.push(setInterval(() => requeueStaleArticles().catch((e) => log.warn("articles requeueStale failed", e)), 5 * 60_000));
  // Статьи: файлы фото опубликованных статей — каждые 30 мин. Строки опубликованных статей НЕ удаляются (аудит 2026-10-14):
  // журнал, расходы, защита от повторного ключа и досылка в Google Таблицу живут на них.
  timers.push(setInterval(() => purgePublishedBacklog(50).catch((e) => log.warn("articles purgePublishedBacklog failed", e)), 30 * 60_000));
  // Статьи: разовая миграция старых настроек автозапуска (выключение по простою убрано 2026-10-15, см. worker/articles/autostart.ts).
  timers.push(setInterval(() => autostartTick().then((r) => { if (r.enabled || r.disabled) log.info(`articles autostart: enabled ${r.enabled}, disabled ${r.disabled}`); }).catch((e) => log.warn("articles autostartTick failed", e)), 60_000));
  // Статьи: досылка отчётов в Google Таблицы, которые не записались при публикации (оригинал: publish-worker, каждый тик).
  timers.push(setInterval(() => resyncSheets(10).then((r) => { if (r.tried) log.info(`articles sheets resync: ${r.ok}/${r.tried}`); }).catch((e) => log.warn("articles resyncSheets failed", e)), 5 * 60_000));
  // DeepL Articler: статьи с истёкшей арендой — в очередь; кэш переводов старше 90 дней — раз в сутки.
  timers.push(setInterval(() => deeplRequeueStale().catch((e) => log.warn("deepl requeueStale failed", e)), 2 * 60_000));
  timers.push(setInterval(() => deeplPurgeCache().catch((e) => log.warn("deepl purgeCache failed", e)), 24 * 60 * 60_000));
  // Трафик сайтов (GA4): зависшие аренды — каждые 5 мин; часы/страницы/разрезы старше 400 дней — раз в сутки.
  timers.push(setInterval(() => analyticsRequeueStale().catch((e) => log.warn("analytics requeueStale failed", e)), 5 * 60_000));
  timers.push(setInterval(() => analyticsPurge().catch((e) => log.warn("analytics purge failed", e)), 24 * 60 * 60_000));
  return () => timers.forEach(clearInterval);
}
