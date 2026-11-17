import { prisma } from "@/lib/db";
import { log } from "./log";
import { botToken, tgGetUpdates } from "@/lib/tasks/telegram";
import { handleUpdate } from "@/lib/tasks/bot";
import { sendDigest } from "@/lib/tasks/digest";
import { spawnRoutineTasks } from "@/lib/tasks/routines";
import { hourKyiv, todayYmd } from "@/lib/tasks/consts";

/**
 * Раздел «Задачи»: Telegram-бот (long polling getUpdates — вебхук не нужен), дайджесты утром и вечером,
 * задачи из регламентов. Один цикл опроса на воркер; курсор getUpdates хранится в TkSettings.tgOffset.
 */

let polling = false;
let stop = false;

export async function tasksPollLoop(isShuttingDown: () => boolean): Promise<void> {
  if (polling) return;
  polling = true;
  while (!isShuttingDown() && !stop) {
    const token = await botToken().catch(() => null);
    if (!token) { await sleep(30_000); continue; }
    const s = await prisma.tkSettings.findUnique({ where: { id: "main" } });
    const r = await tgGetUpdates(token, s?.tgOffset ?? 0, 20);
    if (!r.ok) {
      log.warn(`tasks bot getUpdates: ${r.error}`);
      await prisma.tkSettings.update({ where: { id: "main" }, data: { lastError: r.error.slice(0, 1000) } }).catch(() => {});
      await sleep(/401|404/.test(r.error) ? 60_000 : 10_000);
      continue;
    }
    for (const u of r.updates) {
      try { await handleUpdate(token, u); } catch (e) { log.warn(`tasks bot update ${u.update_id} failed`, e); }
      await prisma.tkSettings.update({ where: { id: "main" }, data: { tgOffset: u.update_id + 1, lastError: null } }).catch(() => {});
    }
  }
  polling = false;
}
export function tasksStop() { stop = true; }

/** Раз в минуту: регламенты → задачи; дайджесты в свой час (по Киеву), один раз в день. */
export async function tasksTick(): Promise<{ routines: number; digest?: string }> {
  const routines = await spawnRoutineTasks();
  const token = await botToken().catch(() => null);
  if (!token) return { routines };
  const s = await prisma.tkSettings.findUnique({ where: { id: "main" } });
  if (!s) return { routines };
  const today = todayYmd();
  const hour = hourKyiv();
  let digest: string | undefined;
  if (hour >= s.morningHour && s.morningSent !== today) {
    await prisma.tkSettings.update({ where: { id: "main" }, data: { morningSent: today } });
    const r = await sendDigest(token, "morning");
    digest = `morning: ${r.sent} sent${r.errors.length ? `, errors: ${r.errors.join("; ")}` : ""}`;
  } else if (hour >= s.eveningHour && s.eveningSent !== today) {
    await prisma.tkSettings.update({ where: { id: "main" }, data: { eveningSent: today } });
    const r = await sendDigest(token, "evening");
    digest = `evening: ${r.sent} sent${r.errors.length ? `, errors: ${r.errors.join("; ")}` : ""}`;
  }
  return { routines, digest };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
