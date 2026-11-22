import { prisma } from "@/lib/db";
import { aiSpirit } from "@/lib/stylist/dna";
import { teamId } from "@/lib/stylist/team";
import { claimStore, requeueStale, scanStore } from "@/lib/stylist/scan";
import { log } from "./log";

/**
 * «Стилист»: обновление каталогов магазинов — раз в сутки и по кнопке «Обновить сейчас».
 * Один магазин за раз: запросы к сайтам идут с паузами, спешить некуда.
 */
const IDLE_MS = 30_000;

const inflight = new Set<Promise<void>>();

export function stylistInflight(): Set<Promise<void>> {
  return inflight;
}

export async function stylistLoop(workerId: string, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    try {
      const store = await claimStore(workerId);
      if (!store) {
        await sleep(IDLE_MS);
        continue;
      }
      const t = Date.now();
      const p = scanStore(store)
        .then((r) => log.info(`stylist: ${store.slug} — ${r.total} item(s), +${r.fresh} new, ${r.gone} gone, ${Math.round((Date.now() - t) / 1000)}s`))
        .catch((e) => log.warn(`stylist: ${store.slug} scan failed`, e))
        .finally(() => inflight.delete(p));
      inflight.add(p);
      await p;
    } catch (e) {
      log.warn("stylist: loop error", e);
      await sleep(60_000);
    }
  }
}

/**
 * Очередь «в духе бренда»: вещи, отмеченные кнопкой «Проверить ИИ», по одной (каждая — один вызов модели с фото).
 * Ошибка ключа или правила — снимаем всю очередь, чтобы не стучаться впустую; причина видна в журнале воркера.
 */
export async function stylistSpiritLoop(shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    try {
      const item = await prisma.stItem.findFirst({ where: { spiritAsked: { not: null } }, orderBy: { spiritAsked: "asc" }, select: { id: true, spiritById: true } });
      if (!item) {
        await sleep(10_000);
        continue;
      }
      const userId = item.spiritById ?? (await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
      const r = userId ? await aiSpirit(userId, await teamId(), item.id) : { ok: false as const, error: "нет пользователя для записи расхода" };
      if (!r.ok) {
        const fatal = /правил|ключ|лимит|баланс|кредит|402|401|403/i.test(r.error);
        const n = fatal ? (await prisma.stItem.updateMany({ where: { spiritAsked: { not: null } }, data: { spiritAsked: null } })).count : (await prisma.stItem.update({ where: { id: item.id }, data: { spiritAsked: null } }), 1);
        log.warn(`stylist: spirit check failed (${r.error}); dropped ${n} queued item(s)`);
      }
      await sleep(400);
    } catch (e) {
      log.warn("stylist: spirit loop error", e);
      await sleep(30_000);
    }
  }
}

export async function stylistStartup(hostPrefix: string): Promise<void> {
  const n = await requeueStale(hostPrefix);
  if (n) log.info(`stylist: requeued ${n} interrupted scan(s)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
