/**
 * Сводка заполненности календаря сайта (порт идеи `dailyCapacity.ts`).
 * В старом приложении вместимость дня была случайной из диапазона; теперь
 * у сайта один `pinsPerDay`, поэтому «вместимость» = `target` для каждого дня.
 */

import { addDays } from "./math";

export type CapacityDayState = "empty" | "under" | "full";

export type CapacityDay = {
  key: string;
  planned: number;
  target: number;
  /** Сколько ещё можно поставить (0, если день заполнен или перегружен). */
  free: number;
  state: CapacityDayState;
};

export type CapacityReport = {
  days: CapacityDay[];
  target: number;
  totalPlanned: number;
  totalCapacity: number;
  totalFree: number;
  /** Дней с хотя бы одним пином. */
  coveredDays: number;
  /** Дней, заполненных до `target` и выше. */
  fullDays: number;
  /** Дни, где пины есть, но меньше нормы. */
  underFilledDays: string[];
  /** Дни без единого пина. */
  emptyDays: string[];
  /** «Запас»: сколько дней подряд с `from` заполнены по норме. */
  stockDays: number;
  /** Первый день, где не хватает до нормы (null — все дни заполнены). */
  firstGapDay: string | null;
};

/**
 * @param perDay  занятость по дням (`YYYY-MM-DD` → число пинов), все прогоны сайта
 * @param target  норма сайта (`pinsPerDay`)
 * @param from    первый день отчёта
 * @param days    сколько дней показать
 */
export function capacity(perDay: ReadonlyMap<string, number>, target: number, from: string, days: number): CapacityReport {
  const norm = Math.max(0, Math.floor(target));
  const count = Math.max(0, Math.floor(days));
  const list: CapacityDay[] = [];
  let totalPlanned = 0;
  let coveredDays = 0;
  let fullDays = 0;
  const underFilledDays: string[] = [];
  const emptyDays: string[] = [];
  let stockDays = 0;
  let stockBroken = false;
  let firstGapDay: string | null = null;

  for (let i = 0; i < count; i++) {
    const key = addDays(from, i);
    const planned = Math.max(0, Math.floor(perDay.get(key) ?? 0));
    const full = norm > 0 && planned >= norm;
    const state: CapacityDayState = planned === 0 ? "empty" : full ? "full" : "under";
    list.push({ key, planned, target: norm, free: Math.max(0, norm - planned), state });
    totalPlanned += planned;
    if (planned > 0) coveredDays++;
    if (full) fullDays++;
    if (state === "under") underFilledDays.push(key);
    if (state === "empty") emptyDays.push(key);
    if (!stockBroken) {
      if (full) stockDays++;
      else stockBroken = true;
    }
    if (firstGapDay === null && !full) firstGapDay = key;
  }

  const totalCapacity = norm * count;
  return {
    days: list,
    target: norm,
    totalPlanned,
    totalCapacity,
    totalFree: Math.max(0, totalCapacity - totalPlanned),
    coveredDays,
    fullDays,
    underFilledDays,
    emptyDays,
    stockDays,
    firstGapDay,
  };
}
