/**
 * Планировщик дат публикации. Порт `bulkEngine.scheduleItems` старого приложения
 * под новые правила: одна политика сайта (`pinsPerDay` + `startFrom`), окно 30 дней,
 * жёсткий потолок 100 пинов в день на сайт, детерминированность по `seed`.
 *
 * Чистая функция: без Prisma, без React. Воркер подаёт пины прогона и занятость
 * сайта, получает карту «id → Date» и список пинов, которым места не хватило.
 */

import { hash32, mulberry32, randIntWith } from "@/lib/pins/plan/seed";
import { MAX_DAY_PINS, MAX_PINS_PER_DAY, SCHEDULE } from "@/lib/pins/types";
import {
  DAY_END_MIN,
  DAY_START_MIN,
  MINUTES_IN_DAY,
  addDays,
  compareKeys,
  daysBetween,
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
  /**
   * fixed — «строго N в день»: каждый день наполняется ровно до pinsPerDay (с учётом чужих пинов), окно растёт само;
   * dates — «от даты до даты»: все пины размазываются равномерно до lastDate (дневной потолок 100), остаток — после lastDate.
   * Шаг между пинами статьи, первый пин и «со статьи в день» — мягкие предпочтения: задают порядок, но не ломают норму дня.
   */
  mode?: "fixed" | "dates";
  lastDate?: string;
  /**
   * Норма этого прогона на день по смещению от первого дня окна (режим fixed): «плавный рост» —
   * 15 в день первую неделю, 20 вторую… Без неё каждый день — pinsPerDay.
   */
  quotaAt?: (off: number) => number;
  /** Общий потолок сайта в день (по умолчанию 100). «Вклинить в график» поднимает его до 200: сверх 100 — публикация сразу. */
  siteDayLimit?: number;
  /** Служебное: посчитать раскладку без общего лимита сайта (для отчёта «сколько пинов пришлось перенести»). */
  ignoreSiteLimit?: boolean;
};

/** Что пришлось изменить из-за общего лимита 100 пинов в день на сайт. */
export type LimitReport = { moved: number; days: string[]; limit: number };

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
  /** Новые пины этого прогона по дням. */
  newPerDay: Map<string, number>;
  /** Заполнено, если общий лимит сайта заставил перенести пины на другие дни. */
  limitReport: LimitReport | null;
};

type Task = { id: string; pageId: string; want: number; seq: number; order: number };

const MAX_START_SEARCH_DAYS = 400;

export function scheduleItems(input: ScheduleInput): ScheduleOutput {
  const tz = input.tz;
  const cap = Math.min(MAX_PINS_PER_DAY, Math.max(0, Math.floor(input.pinsPerDay)));
  const windowDaysPref = Math.max(1, Math.floor(input.windowDays ?? SCHEDULE.windowDays));
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
  /** Пины этого прогона по дням (закреплённые + новые): норма «N в день» считается по ним, а не по всему сайту. */
  const own = new Map<string, number>();
  const HARD = input.ignoreSiteLimit ? Number.POSITIVE_INFINITY : Math.max(1, Math.min(MAX_DAY_PINS, Math.floor(input.siteDayLimit ?? MAX_PINS_PER_DAY)));
  const capAt = (off: number): number => (input.quotaAt ? Math.min(MAX_PINS_PER_DAY, Math.max(0, Math.floor(input.quotaAt(off)))) : cap);
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
        bump(own, key);
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
    // Ближайший день, где у сайта ещё есть место под общим лимитом (пины других прогонов плюсуются).
    for (let i = 0; i < MAX_START_SEARCH_DAYS && (load.get(start) ?? 0) >= HARD; i++) start = addDays(start, 1);
  } else {
    if (!isDayKey(input.startFrom)) throw new Error(`startFrom: ожидается next_free_day или YYYY-MM-DD, получено «${input.startFrom}»`);
    start = compareKeys(input.startFrom, earliest) < 0 ? earliest : input.startFrom;
  }
  const mode: "fixed" | "dates" = input.mode === "dates" ? "dates" : "fixed";
  const flexibleCount = [...flexible.values()].reduce((n, l) => n + l.length, 0);
  // Окно: fixed — столько дней, сколько нужно при норме cap в день (с запасом на чужую нагрузку);
  // dates — от start до lastDate включительно (не раньше start), остаток уходит в дни после lastDate.
  let windowDays: number;
  let datesDays = 0;
  if (mode === "dates") {
    const last = input.lastDate && isDayKey(input.lastDate) && compareKeys(input.lastDate, start) >= 0 ? input.lastDate : start;
    datesDays = Math.min(MAX_START_SEARCH_DAYS, daysBetween(start, last) + 1);
    windowDays = Math.min(MAX_START_SEARCH_DAYS, datesDays + Math.ceil(flexibleCount / Math.max(1, MAX_PINS_PER_DAY)) + 31);
  } else {
    // с запасом: часть дней может быть занята другими прогонами до общего лимита
    let need = Math.ceil(flexibleCount / Math.max(1, cap));
    if (input.quotaAt) {
      // плавный рост: сколько дней уйдёт при растущей норме
      let left = flexibleCount;
      need = 0;
      while (left > 0 && need < MAX_START_SEARCH_DAYS) left -= Math.max(1, capAt(need++));
    }
    windowDays = Math.min(MAX_START_SEARCH_DAYS, Math.max(windowDaysPref, need + 62));
  }
  const lastOffset = windowDays - 1;
  const keys: string[] = [];
  for (let off = 0; off <= lastOffset; off++) keys.push(addDays(start, off));
  const windowEnd = keys[mode === "dates" ? Math.max(0, datesDays - 1) : lastOffset];
  // Норма пинов ЭТОГО прогона на день: fixed — cap; dates — равномерная доля (дефицит переносится на следующий день).
  // Пины других прогонов сайта на те же даты плюсуются; общий потолок сайта — HARD (100) в день.
  const evenQuota = (off: number): number => {
    if (mode !== "dates") return Number.POSITIVE_INFINITY;
    if (off >= datesDays) return Number.POSITIVE_INFINITY; // после lastDate — остаток, сколько влезет
    const base = Math.floor(flexibleCount / datesDays), extra = flexibleCount % datesDays;
    // «лишние» пины распределяем по окну равномерно, а не подряд в первые дни
    const bonus = extra > 0 && Math.floor(((off + 1) * extra) / datesDays) > Math.floor((off * extra) / datesDays) ? 1 : 0;
    return base + bonus;
  };

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

  /* ---- 2) размещение: день за днём добиваем норму, порядок — по желаемым датам ----
   * Главное правило — норма дня (fixed: ровно cap; dates: равная доля). Предпочтения статьи
   * (первый пин, шаг, «со статьи в день») мягкие: сначала берём пины, которым они не мешают,
   * если нормы не хватает — ослабляем «со статьи в день»; порядок пинов внутри статьи не нарушается. */
  const dayFree = (off: number): number => {
    const siteRoom = HARD - (load.get(keys[off]) ?? 0);
    const ownRoom = mode === "dates" ? Number.POSITIVE_INFINITY : capAt(off) - (own.get(keys[off]) ?? 0);
    return Math.max(0, Math.min(siteRoom, ownRoom));
  };
  const pageFree = (off: number, pageId: string): boolean =>
    perPageCap === 0 || (pageLoad.get(`${keys[off]}|${pageId}`) ?? 0) < perPageCap;
  /** Последний день, куда уже поставлен пин страницы — более поздние пины страницы раньше него не уходят. */
  const lastByPage = new Map<string, number>();
  const noRoom = cap === 0 && !input.quotaAt;
  const pending: Task[] = noRoom ? [] : [...tasks];
  const unscheduled: string[] = noRoom ? tasks.map((t) => t.id) : [];
  const placed = new Map<number, string[]>();
  let lastUsed = 0;
  let carry = 0; // недобор прошлых дней в режиме dates
  const put = (t: Task, off: number): void => {
    bump(load, keys[off]);
    bump(own, keys[off]);
    bump(pageLoad, `${keys[off]}|${t.pageId}`);
    lastByPage.set(t.pageId, Math.max(lastByPage.get(t.pageId) ?? 0, off));
    if (off > lastUsed) lastUsed = off;
    const ids = placed.get(off);
    if (ids) ids.push(t.id); else placed.set(off, [t.id]);
  };
  for (let off = 0; off <= lastOffset && pending.length; off++) {
    const quota = evenQuota(off);
    const target = Number.isFinite(quota) ? quota + carry : Number.POSITIVE_INFINITY;
    let want = Math.min(dayFree(off), target);
    const initialWant = want;
    const floorOk = (t: Task) => (lastByPage.get(t.pageId) ?? 0) <= off;
    // проход 1: желаемая дата уже наступила и предпочтения статьи соблюдены
    for (let pass = 0; pass < 3 && want > 0; pass++) {
      for (let i = 0; i < pending.length && want > 0; i++) {
        const t = pending[i];
        if (!floorOk(t)) continue;
        if (pass === 0 && (t.want > off || !pageFree(off, t.pageId))) continue;
        if (pass === 1 && !pageFree(off, t.pageId)) continue; // будущие даты подтягиваем вперёд, лимит статьи держим
        // pass 2: ослабляем «со статьи в день» — норма дня важнее
        put(t, off);
        pending.splice(i, 1);
        i--;
        want--;
      }
    }
    // Недобор дня (лимит 100 или нечем заполнить) переносится на следующие дни окна.
    if (Number.isFinite(target)) carry = Math.max(0, target - (initialWant - want));
  }
  for (const t of pending) unscheduled.push(t.id);
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
  const newPerDay = new Map<string, number>();
  for (const [off, ids] of placed) newPerDay.set(keys[off], ids.length);

  // Отчёт: сравниваем с раскладкой без общего лимита сайта. Пины, которым не хватило места в «своём» дне, считаются перенесёнными.
  let limitReport: LimitReport | null = null;
  if (!input.ignoreSiteLimit && flexibleCount > 0) {
    const ideal = scheduleItems({ ...input, ignoreSiteLimit: true });
    let moved = 0;
    const days: string[] = [];
    for (const [day, want] of ideal.newPerDay) {
      const got = newPerDay.get(day) ?? 0;
      if (want > got) { moved += want - got; days.push(day); }
    }
    if (moved > 0) limitReport = { moved, days: days.sort(), limit: Number.isFinite(HARD) ? HARD : MAX_PINS_PER_DAY };
  }

  return {
    assignments,
    unscheduled,
    perDay,
    firstDay: start,
    lastDay: keys[lastUsed],
    windowEnd,
    kept,
    newPerDay,
    limitReport,
  };
}
