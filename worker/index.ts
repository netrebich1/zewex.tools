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

/**
 * Воркер сервиса пинов: единственный процесс, который двигает прогоны.
 * Запуск: systemd unit zewex-worker (deploy/zewex-worker.service).
 */

setDefaultResultOrder("ipv4first");

const WORKER_ID = `${hostname()}-${process.pid}`;
const CONCURRENCY = Number(process.env.PINS_WORKER_CONCURRENCY || 2);
const IDLE_MS = 2_000;

let shuttingDown = false;
const inflight = new Set<Promise<void>>();

async function loop() {
  while (!shuttingDown) {
    if (inflight.size >= CONCURRENCY) {
      await Promise.race(inflight);
      continue;
    }
    let job = null;
    try {
      job = await claimNextJob(WORKER_ID);
    } catch (e) {
      log.warn("claim failed", e);
      await sleep(5_000);
      continue;
    }
    if (!job) {
      await sleep(IDLE_MS);
      continue;
    }
    const p = processJob(job, () => shuttingDown)
      .catch((e) => log.error(`processJob crashed for ${job!.id}`, e))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log.info(`worker ${WORKER_ID} starting (concurrency ${CONCURRENCY})`);
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
  const stopCron = startCron();
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${sig}: finishing ${inflight.size} job(s) and ${domainsInflight().size} domain run(s), up to 60s`);
    stopCron();
    const t = setTimeout(() => {
      log.warn("forced exit");
      process.exit(1);
    }, 60_000);
    await Promise.allSettled([...inflight, ...domainsInflight()]);
    clearTimeout(t);
    await prisma.$disconnect();
    log.info("bye");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // Очередь подборов доменов работает рядом с очередью пинов в том же процессе.
  await Promise.all([loop(), domainsLoop(WORKER_ID, () => shuttingDown)]);
}

main().catch((e) => {
  log.error("fatal", e);
  process.exit(1);
});
