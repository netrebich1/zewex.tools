/**
 * Математика дат для расписания пинов. Порт `scheduleMath.ts` старого приложения,
 * но без «локального времени браузера»: всё считается в заданном поясе IANA (`tz`).
 *
 * Ключ дня — строка `YYYY-MM-DD` календарной даты в поясе `tz`.
 * Моменты времени — обычные `Date` (UTC внутри), для хранения в БД.
 */

import { SCHEDULE } from "@/lib/pins/types";

export const DEFAULT_TZ = "Europe/Berlin";
/** Первая минута дня для публикаций (08:00). */
export const DAY_START_MIN = SCHEDULE.hourFrom * 60;
/** Последняя минута «сетки» планировщика (21:00). */
export const DAY_END_MIN = SCHEDULE.hourTo * 60;
/** Конец рабочего дня для правок «до конца дня» (21:59). */
export const DAY_LAST_MIN = SCHEDULE.hourTo * 60 + 59;
export const MINUTES_IN_DAY = 24 * 60;
export const MS_IN_DAY = 86_400_000;

const pad = (n: number): string => String(n).padStart(2, "0");

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Проверка, что строка — известный пояс IANA. */
export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** Компоненты «настенного» времени момента `d` в поясе `tz`. */
export function zonedParts(d: Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Ключ дня `YYYY-MM-DD` для момента `d` в поясе `tz`. */
export function dayKey(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Минута суток (0..1439) момента `d` в поясе `tz`. */
export function minuteOfDay(d: Date, tz: string): number {
  const p = zonedParts(d, tz);
  return p.hour * 60 + p.minute;
}

export function isDayKey(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { year, month, day } = keyParts(s);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Разбор ключа дня на числа (без проверки календаря — см. `isDayKey`). */
export function keyParts(key: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`Неверный ключ дня: ${key}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Сдвиг ключа дня на `days` календарных дней (не зависит от пояса). */
export function addDays(key: string, days: number): string {
  const { year, month, day } = keyParts(key);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Сколько дней от `a` до `b` (отрицательно, если `b` раньше). */
export function daysBetween(a: string, b: string): number {
  const pa = keyParts(a);
  const pb = keyParts(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / MS_IN_DAY);
}

/** Число дней в окне, включая первую и последнюю дату (минимум 1). */
export function daysInclusive(first: string, last: string): number {
  return Math.max(1, daysBetween(first, last) + 1);
}

/** Сравнение ключей дня как строк (формат фиксированный, поэтому лексикографически корректно). */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Момент `Date`, соответствующий минуте `minute` дня `key` в поясе `tz`.
 * Переходы на летнее время учитываются (итеративный подбор смещения).
 */
export function zonedToUtc(key: string, minute: number, tz: string): Date {
  const { year, month, day } = keyParts(key);
  const hour = Math.floor(minute / 60);
  const min = minute - hour * 60;
  let guess = Date.UTC(year, month - 1, day, hour, min, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    const diff = asUtc - guess;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

/** Полночь дня `key` в поясе `tz`. */
export function startOfDay(key: string, tz: string): Date {
  return zonedToUtc(key, 0, tz);
}

/** Ключ сегодняшнего дня в поясе `tz`. */
export function todayKey(now: Date, tz: string): string {
  return dayKey(now, tz);
}

/** Дата публикации в формате Pinterest: `YYYY-MM-DDTHH:mm:ss` в поясе `tz`. */
export function formatPinterestDate(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** `YYYY-MM-DD HH:mm` в поясе `tz` — для интерфейса. */
export function formatDateTime(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Ключ дня в виде `DD.MM.YYYY`. */
export function formatRu(key: string): string {
  if (!isDayKey(key)) return key;
  const { year, month, day } = keyParts(key);
  return `${pad(day)}.${pad(month)}.${year}`;
}

/** Равномерно раскладывает `n` точек в окне минут [from, to] (шаг = длина / n, как в Schedule Fixer). */
export function spreadEven(n: number, from: number, to: number): number[] {
  if (n <= 0) return [];
  const span = Math.max(0, to - from);
  const step = n > 1 ? span / n : 0;
  return Array.from({ length: n }, (_, i) => Math.round(from + step * i));
}

/** Ближайшая незанятая минута к `m` (сначала вперёд, потом назад) в пределах [floor, ceil]. */
export function nearestFreeMinute(m: number, used: ReadonlySet<number>, floor = 0, ceil = MINUTES_IN_DAY - 1): number {
  if (!used.has(m)) return m;
  for (let d = 1; d < MINUTES_IN_DAY; d++) {
    const up = m + d;
    if (up <= ceil && !used.has(up)) return up;
    const down = m - d;
    if (down >= floor && !used.has(down)) return down;
  }
  return m;
}

/**
 * Времена внутри дня для планировщика: `n` слотов по равным интервалам в [from, to]
 * с небольшим детерминированным разбросом (до ±20 мин) и без повторов минут.
 * `used` — уже занятые минуты этого дня (пополняется).
 */
export function spreadDayTimes(
  n: number,
  rng: () => number,
  from = DAY_START_MIN,
  to = DAY_END_MIN,
  used: Set<number> = new Set<number>(),
): number[] {
  if (n <= 0) return [];
  const span = Math.max(0, to - from);
  const step = n > 1 ? span / (n - 1) : 0;
  const jitter = Math.max(0, Math.min(20, Math.floor(step / 3)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let m = Math.round(from + step * i);
    if (jitter) m += Math.floor(rng() * (jitter * 2 + 1)) - jitter;
    m = Math.max(from, Math.min(to, m));
    m = nearestFreeMinute(m, used, from, MINUTES_IN_DAY - 1);
    used.add(m);
    out.push(m);
  }
  return out;
}
