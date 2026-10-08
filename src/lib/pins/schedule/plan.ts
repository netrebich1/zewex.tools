/**
 * Планировщик дат публикации. Порт `bulkEngine.scheduleItems` старого приложения
 * под новые правила: одна политика сайта (`pinsPerDay` + `startFrom`), окно 30 дней,
 * жёсткий потолок 100 пинов в день на сайт, детерминированность по `seed`.
 *
 * Чистая функция: без Prisma, без React. Воркер подаёт пины прогона и занятость
 * сайта, получает карту «id → Date» и список пинов, которым места не хватило.
 */

import { hash32, mulberry32, randIntWith } from "@/lib/pins/plan/seed";
import { MAX_PINS_PER_DAY, SCHEDULE } from "@/lib/pins/types";
import {
  DAY_END_MIN,
  DAY_START_MIN,
  MINUTES_IN_DAY,
  addDays,
  compareKeys,
  dayKey,
  isDayKey,
  minuteOfDay,
  spreadDayTimes,
  zonedToUtc,
} from "./math";

export type ScheduleItem = {
  id: string;
  scheduledAt: Date | null;
  /** Дата закреплена вручную — не трогаем, только учитываем в лимитах. */
  scheduleFixed: boolean;
};

export type StartFrom = "next_free_day" | string;

export type ScheduleInput = {
  /** pageId → пины страницы. */
  itemsByPage: Map<string, ScheduleItem[]>;
  /**
   * Занятость сайта по дням (`YYYY-MM-DD` → число пинов) из ДРУГИХ прогонов.
   * Пины из `itemsByPage` сюда включать не нужно — закреплённые считаются внутри.
   */
  existingLoad: Map<string, number>;
  /** Пинов в день на сайт; обрезается потолком `MAX_PINS_PER_DAY` (100). */
  pinsPerDay: number;
  /** `next_free_day` — первый день с сегодняшнего, где есть место; либо `YYYY-MM-DD` (не раньше сегодня). */
  startFrom: StartFrom;
  now: Date;
  seed: number;
  /** Пояс IANA, в котором считаются дни и часы публикации. */
  tz: string;
  windowDays?: number;
  /** Максимум пинов одной страницы в день (0 = без ограничения). */
  perPagePerDay?: number;
  /** Первый пин страницы выходит в первые N дней окна. */
  firstPinWindowDays?: number;
  stepMinDays?: number;
  stepMaxDays?: number;
  /** Сегодняшние слоты не раньше `now + minLeadMinutes` (Pinterest требует ≥ 15 мин). */
  minLeadMinutes?: number;
};

export type ScheduleOutput = {
  /** Новые даты только для перепланированных пинов (закреплённые сюда не попадают). */
  assignments: Map<string, Date>;
  /** Пины, которым не нашлось места в окне — остаются без даты, подхватываются следующим запуском. */
  unscheduled: string[];
  /** Итоговая загрузка по дням окна: чужая + закреплённая + новая. */
  perDay: Map<string, number>;
  /** Первый день окна. */
  firstDay: string;
  /** Последний день, получивший новый пин (= `firstDay`, если ничего не поставлено). */
  lastDay: string;
  /** Последний день окна. */
  windowEnd: string;
  /** Сколько пинов оставлено с прежней датой. */
  kept: number;
};

type Task = { id: string; pageId: string; want: number; seq: number; order: number };

const MAX_START_SEARCH_DAYS = 400;

export function scheduleItems(input: ScheduleInput): ScheduleOutput {
  const tz = input.tz;
  const cap = Math.min(MAX_PINS_PER_DAY, Math.max(0, Math.floor(input.pinsPerDay)));
  const windowDays = Math.max(1, Math.floor(input.windowDays ?? SCHEDULE.windowDays));
  const perPageCap = Math.max(0, Math.floor(input.perPagePerDay ?? SCHEDULE.perPagePerDay));
  const firstWindow = Math.max(1, Math.floor(input.firstPinWindowDays ?? SCHEDULE.firstPinWindowDays));
  const stepMin = Math.max(1, Math.floor(input.stepMinDays ?? SCHEDULE.stepMinDays));
  const stepMax = Math.max(stepMin, Math.floor(input.stepMaxDays ?? SCHEDULE.stepMaxDays));
  const minLead = Math.max(0, Math.floor(input.minLeadMinutes ?? 30));

  const nowMs = input.now.getTime();
  const todayKey = dayKey(input.now, tz);
  const nowMin = minuteOfDay(input.now, tz);

  /* ---- занятость: чужие прогоны + закреплённые/будущие пины этого прогона ---- */
  const load = new Map<string, number>();
  for (const [key, n] of input.existingLoad) load.set(key, Math.max(0, Math.floor(n)));
  const pageLoad = new Map<string, number>();
  const usedMinutes = new Map<string, Set<number>>();
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  let kept = 0;
  const flexible = new Map<string, ScheduleItem[]>();
  for (const [pageId, list] of input.itemsByPage) {
    const rest: ScheduleItem[] = [];
    for (const it of list) {
      const at = it.scheduledAt;
      const keep = at !== null && !Number.isNaN(at.getTime()) && (it.scheduleFixed || at.getTime() >= nowMs);
      if (keep && at) {
        const key = dayKey(at, tz);
        bump(load, key);
        bump(pageLoad, `${key}|${pageId}`);
        let set = usedMinutes.get(key);
        if (!set) {
          set = new Set<number>();
          usedMinutes.set(key, set);
        }
        set.add(minuteOfDay(at, tz));
        kept++;
      } else {
        rest.push(it);
      }
    }
    if (rest.length) flexible.set(pageId, rest);
  }

  /* ---- первый день окна ---- */
  // Сегодня годится, только если до 21:00 ещё есть время с учётом запаса.
  const earliest = nowMin + minLead >= DAY_END_MIN ? addDays(todayKey, 1) : todayKey;
  let start: string;
  if (input.startFrom === "next_free_day") {
    start = earliest;
    for (let i = 0; i < MAX_START_SEARCH_DAYS && (load.get(start) ?? 0) >= cap; i++) start = addDays(start, 1);
  } else {
    if (!isDayKey(input.startFrom)) throw new Error(`startFrom: ожидается next_free_day или YYYY-MM-DD, получено «${input.startFrom}»`);
    start = compareKeys(input.startFrom, earliest) < 0 ? earliest : input.startFrom;
  }
  const lastOffset = windowDays - 1;
  const keys: string[] = [];
  for (let off = 0; off <= lastOffset; off++) keys.push(addDays(start, off));
  const windowEnd = keys[lastOffset];

  /* ---- детерминированная случайность ---- */
  const seedStr = [input.seed, start, windowDays, cap, perPageCap, firstWindow, stepMin, stepMax].join("|");
  const keyOf = (s: string): number => mulberry32(hash32(`${seedStr}|${s}`))();

  /* ---- 1) идеальные даты: первый пин в стартовом окне, дальше шаг 2–5 дней ---- */
  const tasks: Task[] = [];
  const firstMax = Math.min(firstWindow - 1, lastOffset);
  for (const [pageId, list] of flexible) {
    const pageRng = mulberry32(hash32(`${seedStr}|page|${pageId}`));
    const order = keyOf(`order|${pageId}`);
    const ordered = [...list]
      .map((it) => ({ it, k: keyOf(`item|${it.id}`) }))
      .sort((a, b) => a.k - b.k || (a.it.id < b.it.id ? -1 : a.it.id > b.it.id ? 1 : 0))
      .map((x) => x.it);
    let dayOffset = randIntWith(pageRng, 0, firstMax);
    ordered.forEach((it, idx) => {
      if (idx > 0) dayOffset = Math.min(lastOffset, dayOffset + randIntWith(pageRng, stepMin, stepMax));
      tasks.push({ id: it.id, pageId, want: dayOffset, seq: idx, order });
    });
  }
  // По возрастанию желаемой даты — дни наполняются равномерно; порядок страниц не зависит от порядка Map.
  tasks.sort((a, b) => a.want - b.want || a.seq - b.seq || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  /* ---- 2) размещение с дневным и постраничным лимитами ---- */
  const dayFree = (off: number): boolean => (load.get(keys[off]) ?? 0) < cap;
  const pageFree = (off: number, pageId: string): boolean =>
    perPageCap === 0 || (pageLoad.get(`${keys[off]}|${pageId}`) ?? 0) < perPageCap;
  const free = (off: number, pageId: string): boolean => dayFree(off) && pageFree(off, pageId);

  let cursor = 0;
  const advanceCursor = (): void => {
    while (cursor <= lastOffset && !dayFree(cursor)) cursor++;
  };
  /** Последний день, куда уже поставлен пин страницы — более поздние пины страницы раньше него не уходят. */
  const lastByPage = new Map<string, number>();

  const placeDay = (t: Task): number => {
    advanceCursor();
    const floor = Math.max(cursor, lastByPage.get(t.pageId) ?? 0);
    const wanted = Math.min(t.want, lastOffset);
    for (let off = Math.max(floor, wanted); off <= lastOffset; off++) if (free(off, t.pageId)) return off;
    for (let off = wanted - 1; off >= floor; off--) if (free(off, t.pageId)) return off;
    return -1;
  };

  const placed = new Map<number, string[]>();
  const unscheduled: string[] = [];
  let lastUsed = 0;
  for (const t of tasks) {
    if (cap === 0) {
      unscheduled.push(t.id);
      continue;
    }
    const off = placeDay(t);
    if (off < 0) {
      unscheduled.push(t.id);
      continue;
    }
    bump(load, keys[off]);
    bump(pageLoad, `${keys[off]}|${t.pageId}`);
    lastByPage.set(t.pageId, Math.max(lastByPage.get(t.pageId) ?? 0, off));
    if (off > lastUsed) lastUsed = off;
    const ids = placed.get(off);
    if (ids) ids.push(t.id);
    else placed.set(off, [t.id]);
  }

  /* ---- 3) времена внутри дня: 08:00–21:00, разброс по сиду, без повторов минут ---- */
  const assignments = new Map<string, Date>();
  for (const [off, ids] of placed) {
    const key = keys[off];
    let used = usedMinutes.get(key);
    if (!used) {
      used = new Set<number>();
      usedMinutes.set(key, used);
    }
    let from = DAY_START_MIN;
    if (key === todayKey) from = Math.max(from, Math.min(nowMin + minLead, MINUTES_IN_DAY - 1));
    const to = Math.max(DAY_END_MIN, from);
    const dayRng = mulberry32(hash32(`${seedStr}|time|${key}`));
    const minutes = spreadDayTimes(ids.length, dayRng, from, to, used);
    ids.forEach((id, i) => assignments.set(id, zonedToUtc(key, minutes[i], tz)));
  }

  const perDay = new Map<string, number>();
  for (const key of keys) perDay.set(key, load.get(key) ?? 0);

  return {
    assignments,
    unscheduled,
    perDay,
    firstDay: start,
    lastDay: keys[lastUsed],
    windowEnd,
    kept,
  };
}
