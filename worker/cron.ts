import { requeueStale } from "./queue";
import { log } from "./log";
import { domainsRequeueStale } from "./domains";
import { requeueStaleArticles } from "./articles";
import { autostartTick } from "./articles/autostart";
import { purgeOldArticles, purgePublishedBacklog } from "@/lib/articles/wp/cleanup";
import { purgeOldRuns } from "@/lib/pins/runs/cleanup";
import { resyncSheets } from "@/lib/articles/sheets";

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
  // Статьи: оригиналы фото опубликованных статей — каждые 30 мин; ночная очистка опубликованных >24 ч — раз в сутки (оригинал: cron 23:00 UTC).
  timers.push(setInterval(() => purgePublishedBacklog(50).catch((e) => log.warn("articles purgePublishedBacklog failed", e)), 30 * 60_000));
  timers.push(setInterval(() => purgeOldArticles(1, 200).then((r) => { const n = typeof r === "number" ? r : (r as { deleted?: number })?.deleted ?? 0; if (n) log.info(`articles: purged ${n} published`); }).catch((e) => log.warn("articles purgeOldArticles failed", e)), 24 * 60 * 60_000));
  // Статьи: автовключение цепочек при появлении работы и автоотключение через 15 мин простоя (оригинал: auto_enable_site_phase + idle auto-off).
  timers.push(setInterval(() => autostartTick().then((r) => { if (r.enabled || r.disabled) log.info(`articles autostart: enabled ${r.enabled}, disabled ${r.disabled}`); }).catch((e) => log.warn("articles autostartTick failed", e)), 60_000));
  // Статьи: досылка отчётов в Google Таблицы, которые не записались при публикации (оригинал: publish-worker, каждый тик).
  timers.push(setInterval(() => resyncSheets(10).then((r) => { if (r.tried) log.info(`articles sheets resync: ${r.ok}/${r.tried}`); }).catch((e) => log.warn("articles resyncSheets failed", e)), 5 * 60_000));
  return () => timers.forEach(clearInterval);
}
