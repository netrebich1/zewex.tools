/**
 * Перераспределение уже запланированных пинов сайта: новая норма в день (ровная или «плавный рост»).
 * Чистая функция без Prisma: вызывающий подаёт подвижные пины (не залитые дни, не закреплённые) и
 * занятость, которая остаётся на месте. Порядок пинов сохраняется: кто стоял раньше — встанет раньше.
 *
 * Норма дня — ВСЕГО пинов сайта в день (вместе с теми, что остаются на месте), потолок MAX_DAY_PINS (200):
 * Pinterest ставит по времени до 100 пинов файла дня, остальные публикуются сразу при загрузке (см. export/day.ts).
 */

import { hash32, mulberry32 } from "@/lib/pins/plan/seed";
import { MAX_DAY_PINS, SCHEDULED_PER_DAY, SCHEDULE } from "@/lib/pins/types";
import { DAY_END_MIN, DAY_START_MIN, MINUTES_IN_DAY, addDays, compareKeys, dayKey, minuteOfDay, spreadDayTimes, zonedToUtc } from "./math";

export type MovablePin = { id: string; pageId: string; scheduledAt: Date | null };

export type RedistributeInput = {
  /** Пины, которые можно переставить (без дат — в конец очереди). */
  items: readonly MovablePin[];
  /** Занятость дней пинами, которые остаются на месте (залитые дни, закреплённые, другой прогон при «вклинивании»). */
  fixedLoad: ReadonlyMap<string, number>;
  /** Занятые минуты этих пинов по дням — новые времена их не повторяют. */
  fixedMinutes?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Первый день (`YYYY-MM-DD`), не раньше сегодня. */
  start: string;
  /** Всего пинов сайта на день по смещению от `start`. */
  quotaAt: (off: number) => number;
  /** Дни, куда ставить нельзя (файл дня уже залит в Pinterest). */
  blockedDays?: ReadonlySet<string>;
  perPagePerDay?: number;
  now: Date;
  tz: string;
  seed: number;
  minLeadMinutes?: number;
};

export type DayOver = { day: string; total: number; immediate: number };

export type RedistributeOutput = {
  assignments: Map<string, Date>;
  /** Не хватило дней (очень длинный хвост) — остаются без даты. */
  unscheduled: string[];
  /** Итог по дням: остаются + переставленные. */
  perDay: Map<string, number>;
  /** Дни, где больше 100: сколько всего и сколько уйдёт «сразу». */
  over: DayOver[];
  firstDay: string;
  lastDay: string;
};

const MAX_DAYS = 800;
const LOOKAHEAD = 400;

export function redistribute(input: RedistributeInput): RedistributeOutput {
  const { tz } = input;
  const perPage = Math.max(0, Math.floor(input.perPagePerDay ?? SCHEDULE.perPagePerDay));
  const minLead = Math.max(0, Math.floor(input.minLeadMinutes ?? 30));
  const today = dayKey(input.now, tz);
  const nowMin = minuteOfDay(input.now, tz);
  const start = compareKeys(input.start, today) < 0 ? today : input.start;

  // Порядок: по текущей дате (без даты — в конец), при равенстве — по id: результат не зависит от порядка входа.
  const queue = [...input.items].sort((a, b) => {
    const ta = a.scheduledAt ? a.scheduledAt.getTime() : Number.POSITIVE_INFINITY;
    const tb = b.scheduledAt ? b.scheduledAt.getTime() : Number.POSITIVE_INFINITY;
    return ta - tb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  const placed = new Map<string, MovablePin[]>();
  let lastDay = start;
  for (let off = 0; off < MAX_DAYS && queue.length; off++) {
    const day = addDays(start, off);
    if (input.blockedDays?.has(day)) continue;
    if (day === today && nowMin + minLead >= DAY_END_MIN) continue;
    const quota = Math.min(MAX_DAY_PINS, Math.max(0, Math.floor(input.quotaAt(off))));
    let room = Math.max(0, quota - (input.fixedLoad.get(day) ?? 0));
    if (!room) continue;
    const got: MovablePin[] = [];
    const pageCount = new Map<string, number>();
    // проход 1: держим «не больше N пинов статьи в день», смотрим вперёд на LOOKAHEAD пинов;
    // проход 2: норма дня важнее — добираем по порядку.
    for (let pass = 0; pass < 2 && room > 0; pass++) {
      for (let i = 0; i < queue.length && room > 0 && (pass === 1 || i < LOOKAHEAD); i++) {
        const it = queue[i];
        if (pass === 0 && perPage > 0 && (pageCount.get(it.pageId) ?? 0) >= perPage) continue;
        got.push(it);
        pageCount.set(it.pageId, (pageCount.get(it.pageId) ?? 0) + 1);
        queue.splice(i, 1);
        i--;
        room--;
      }
    }
    if (got.length) { placed.set(day, got); lastDay = day; }
  }

  const assignments = new Map<string, Date>();
  for (const [day, list] of placed) {
    const used = new Set<number>(input.fixedMinutes?.get(day) ?? []);
    let from = DAY_START_MIN;
    if (day === today) from = Math.max(from, Math.min(nowMin + minLead, MINUTES_IN_DAY - 1));
    const to = Math.max(DAY_END_MIN, from);
    const rng = mulberry32(hash32(`${input.seed}|redistribute|${day}`));
    const minutes = spreadDayTimes(list.length, rng, from, to, used);
    list.forEach((it, i) => assignments.set(it.id, zonedToUtc(day, minutes[i], tz)));
  }

  const perDay = new Map<string, number>(input.fixedLoad);
  for (const [day, list] of placed) perDay.set(day, (perDay.get(day) ?? 0) + list.length);
  return { assignments, unscheduled: queue.map((q) => q.id), perDay, over: overDays(perDay, start), firstDay: start, lastDay };
}

/** Дни (с `from`), где пинов больше 100: сверх 100 Pinterest публикует сразу при загрузке файла. */
export function overDays(perDay: ReadonlyMap<string, number>, from: string): DayOver[] {
  return [...perDay.entries()]
    .filter(([day, n]) => n > SCHEDULED_PER_DAY && compareKeys(day, from) >= 0)
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([day, total]) => ({ day, total, immediate: total - SCHEDULED_PER_DAY }));
}
