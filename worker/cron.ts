import { requeueStale } from "./queue";
import { log } from "./log";
import { domainsRequeueStale } from "./domains";

/** Периодические задачи воркера: сторож зависших задач, уборка (позже). */
export function startCron(): () => void {
  const timers: NodeJS.Timeout[] = [];
  timers.push(setInterval(() => requeueStale().catch((e) => log.warn("requeueStale failed", e)), 5 * 60_000));
  timers.push(setInterval(() => domainsRequeueStale().catch((e) => log.warn("domains requeueStale failed", e)), 5 * 60_000));
  return () => timers.forEach(clearInterval);
}
