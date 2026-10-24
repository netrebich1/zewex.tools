import { hostname } from "os";
import { setDefaultResultOrder } from "dns";
import { prisma } from "@/lib/db";
import { claimNextJob, requeueOrphans, requeueStale } from "./queue";
import { processJob } from "./runner";
import { startCron } from "./cron";
import { log } from "./log";
import { join } from "path";
import { installNodeCanvasHost } from "@/lib/pins/canvas/host.node";
import { storageRoot } from "@/lib/pins/storage";
import { domainsInflight, domainsLoop, domainsRequeueStale } from "./domains";
import { articlesInflight, articlesLoop, articlesStartup } from "./articles";
import { aiModerationInflight, aiModerationLoop } from "./articles/aiModeration";
import { deeplInflight, deeplLoop, deeplRequeueStale } from "./deepl";
import { analyticsInflight, analyticsLoop, analyticsRequeueStale } from "./analytics";
import { blogInflight, blogLoop, blogStartup } from "./blog";

/**
 * Воркер сервиса пинов: единственный процесс, который двигает прогоны.
 * Запуск: systemd unit zewex-worker (deploy/zewex-worker.service).
 */

setDefaultResultOrder("ipv4first");
// Забытый .catch у фонового промиса не должен ронять весь воркер (пины, домены, статьи): пишем в журнал и работаем дальше.
process.on("unhandledRejection", (e) => log.error("unhandled rejection", e));

const WORKER_ID = `${hostname()}-${process.pid}`;
/**
 * Места воркера пинов (2026-10-22): всего `CONCURRENCY` задач разом, из них тяжёлых этапов (картинки ИИ и Canvas —
 * длинные, держат место по часу) не больше `HEAVY_CAP`. Остальные места всегда свободны для лёгких этапов
 * (ключи и доски, фото, план, промты, тексты, WordPress, расписание), иначе новый прогон часами стоит «В очереди»
 * за чужими картинками. Canvas грузит процессор (на сервере 2 ядра), поэтому тяжёлых мест не больше, чем раньше.
 */
const CONCURRENCY = Number(process.env.PINS_WORKER_CONCURRENCY || 4);
const HEAVY_CAP = Math.max(1, Math.min(CONCURRENCY, Number(process.env.PINS_WORKER_HEAVY || 2)));
export const HEAVY_STAGES = ["images", "canvas"] as const;
const IDLE_MS = 2_000;

let shuttingDown = false;
const inflight = new Set<Promise<void>>();
/** Этап каждой выполняемой задачи — чтобы считать занятые тяжёлые места. */
const inflightStage = new Map<Promise<void>, string>();
const heavyInflight = () => [...inflightStage.values()].filter((s) => (HEAVY_STAGES as readonly string[]).includes(s)).length;

async function loop() {
  while (!shuttingDown) {
    if (inflight.size >= CONCURRENCY) {
      await Promise.race(inflight);
      continue;
    }
    let job = null;
    try {
      job = await claimNextJob(WORKER_ID, { skipStages: heavyInflight() >= HEAVY_CAP ? HEAVY_STAGES : [] });
    } catch (e) {
      log.warn("claim failed", e);
      await sleep(5_000);
      continue;
    }
    if (!job) {
      await sleep(IDLE_MS);
      continue;
    }
    const p: Promise<void> = processJob(job, () => shuttingDown)
      .catch((e) => log.error(`processJob crashed for ${job!.id}`, e))
      .finally(() => { inflight.delete(p); inflightStage.delete(p); });
    inflight.add(p);
    inflightStage.set(p, job.stage);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log.info(`worker ${WORKER_ID} starting (concurrency ${CONCURRENCY}, heavy ${HEAVY_CAP}: ${HEAVY_STAGES.join("/")})`);
  await prisma.$queryRaw`SELECT 1`;
  try {
    const f = installNodeCanvasHost(join(storageRoot(), "pins/fonts"));
    log.info(`canvas host ready: ${f.families} font families, ${f.files} files`);
  } catch (e) {
    log.warn("canvas host init failed (canvas stage will fail until fixed)", e);
  }
  await requeueOrphans(hostname());
  await requeueStale();
  await domainsRequeueStale(hostname()).catch((e) => log.warn("domains requeue failed", e));
  await articlesStartup(hostname());
  await blogStartup(hostname());
  await deeplRequeueStale(hostname()).catch((e) => log.warn("deepl requeue failed", e));
  await analyticsRequeueStale(hostname()).catch((e) => log.warn("analytics requeue failed", e));
  const stopCron = startCron();
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${sig}: finishing ${inflight.size} job(s), ${domainsInflight().size} domain run(s) and ${articlesInflight().size} article(s), ${blogInflight().size} blog post(s), ${aiModerationInflight().size} AI review(s), ${deeplInflight().size} DeepL article(s), ${analyticsInflight().size} GA sync(s), up to 60s`);
    stopCron();
    const t = setTimeout(() => {
      log.warn("forced exit");
      process.exit(1);
    }, 60_000);
    await Promise.allSettled([...inflight, ...domainsInflight(), ...articlesInflight(), ...blogInflight(), ...aiModerationInflight(), ...deeplInflight(), ...analyticsInflight()]);
    clearTimeout(t);
    await prisma.$disconnect();
    log.info("bye");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // Очереди подборов доменов и статей работают рядом с очередью пинов в том же процессе.
  await Promise.all([loop(), domainsLoop(WORKER_ID, () => shuttingDown), articlesLoop(WORKER_ID, () => shuttingDown), blogLoop(WORKER_ID, () => shuttingDown), aiModerationLoop(WORKER_ID, () => shuttingDown), deeplLoop(WORKER_ID, () => shuttingDown), analyticsLoop(WORKER_ID, () => shuttingDown)]);
}

main().catch((e) => {
  log.error("fatal", e);
  process.exit(1);
});
