/**
 * Отметка «пин залит в Pinterest» (PinRunItem.uploadedAt) — основа защиты от дублей:
 * залитые пины и пины с той же картинкой больше не попадают в файлы (см. dayItemsChecked).
 */
import { prisma } from "@/lib/db";
import { TZ } from "@/lib/pins/runs/stats";
import { addDays, startOfDay } from "@/lib/pins/schedule/math";

const DAY_READY = { status: "READY" as const, moderation: "APPROVED" as const };

const dayRange = (day: string) => ({ gte: startOfDay(day, TZ), lt: startOfDay(addDays(day, 1), TZ) });

/** Агент залил файл: ровно те пины, что были в CSV. */
export async function markPinsUploaded(ids: string[], at = new Date()): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 1000) n += (await prisma.pinRunItem.updateMany({ where: { id: { in: ids.slice(i, i + 1000) }, uploadedAt: null }, data: { uploadedAt: at } })).count;
  return n;
}

/** Отметка «залито» за день (руками или агентом без списка): все готовые пины этого дня сайта. */
export async function markDayUploaded(siteId: string, day: string, at = new Date()): Promise<number> {
  return (await prisma.pinRunItem.updateMany({ where: { siteId, scheduledAt: dayRange(day), ...DAY_READY, uploadedAt: null }, data: { uploadedAt: at } })).count;
}

/** Снята отметка «залито» за день — пины дня снова можно заливать. */
export async function unmarkDayUploaded(siteId: string, day: string): Promise<number> {
  return (await prisma.pinRunItem.updateMany({ where: { siteId, scheduledAt: dayRange(day), uploadedAt: { not: null } }, data: { uploadedAt: null } })).count;
}

/** Текст предупреждения о дублях для экрана заливки (пусто — дублей нет). */
export function dupesText(d: { uploaded: number; sameImage: number } | null | undefined): string {
  if (!d || (!d.uploaded && !d.sameImage)) return "";
  const parts = [d.uploaded ? `${d.uploaded} уже залиты` : "", d.sameImage ? `${d.sameImage} с уже залитой картинкой` : ""].filter(Boolean);
  return `Дубли убраны из файла: ${parts.join(", ")}`;
}
