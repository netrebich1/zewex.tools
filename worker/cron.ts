import { requeueStale } from "./queue";
import { log } from "./log";
import { domainsRequeueStale } from "./domains";
import { requeueStaleArticles } from "./articles";
import { purgeOldRuns } from "@/lib/pins/runs/cleanup";

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
  return () => timers.forEach(clearInterval);
}
