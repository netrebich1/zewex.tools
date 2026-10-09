/**
 * Правка уже назначенных дат (порт `scheduleFixer.ts`), но над строками `{ id, scheduledAt }`,
 * а не над CSV. Режимы:
 *  - `today`  — пропущенные и оставшиеся сегодняшние пины равномерно до 21:59;
 *  - `all`    — всё расписание сдвигается вперёд от текущего момента, дневной объём сохраняется;
 *  - `clear`  — у просроченных пинов дата стирается.
 * Всё считается в поясе `tz`.
 */

import { DAY_LAST_MIN, DAY_START_MIN, MINUTES_IN_DAY, addDays, dayKey, minuteOfDay, spreadEven, zonedToUtc } from "./math";

export type FixMode = "today" | "all" | "clear";

export type FixRow = { id: string; scheduledAt: Date | null };

export type FixOptions = {
  now: Date;
  tz: string;
  /** Запас от «сейчас» в минутах: всё раньше `now + buffer` считается пропущенным. */
  bufferMinutes?: number;
};

export type FixResult = {
  /** id → новая дата (`null` — дата стёрта). Только реально изменившиеся строки. */
  updates: Map<string, Date | null>;
  /** Строки после правки (в исходном порядке). */
  rows: FixRow[];
  total: number;
  missed: number;
  changed: number;
  cleared: number;
  firstDate: Date | null;
  lastDate: Date | null;
};

type Dated = { id: string; at: Date };

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

export function fixSchedule(rows: readonly FixRow[], mode: FixMode, opts: FixOptions): FixResult {
  const tz = opts.tz;
  const buffer = opts.bufferMinutes ?? 20;
  const start = new Date(opts.now.getTime() + buffer * 60_000);
  const nowMin = minuteOfDay(start, tz);
  const todayK = dayKey(start, tz);

  const next = new Map<string, Date | null>();
  for (const r of rows) next.set(r.id, r.scheduledAt);

  const dated: Dated[] = [];
  for (const r of rows) if (r.scheduledAt && !Number.isNaN(r.scheduledAt.getTime())) dated.push({ id: r.id, at: r.scheduledAt });
  dated.sort((a, b) => a.at.getTime() - b.at.getTime());
  const missed = dated.filter((x) => x.at.getTime() < start.getTime());

  const endToday = nowMin < DAY_LAST_MIN - 5 ? DAY_LAST_MIN : MINUTES_IN_DAY - 1;
  const set = (id: string, d: Date | null): void => {
    next.set(id, d);
  };

  if (mode === "clear") {
    for (const x of missed) set(x.id, null);
  } else if (mode === "today") {
    const todays = dated.filter((x) => x.at.getTime() < start.getTime() || dayKey(x.at, tz) === todayK);
    const from = Math.max(DAY_START_MIN, Math.min(nowMin, endToday));
    spreadEven(todays.length, from, endToday).forEach((m, k) => set(todays[k].id, zonedToUtc(todayK, m, tz)));
  } else {
    const perDay = new Map<string, number>();
    for (const x of dated) {
      const k = dayKey(x.at, tz);
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    const cap = Math.max(1, ...perDay.values());
    let k = 0;
    let day = todayK;
    let first = true;
    while (k < dated.length) {
      let from = DAY_START_MIN;
      let to = DAY_LAST_MIN;
      let n = cap;
      if (first) {
        from = Math.max(DAY_START_MIN, Math.min(nowMin, endToday));
        to = endToday;
        n = Math.max(0, Math.round(cap * ((to - from) / (DAY_LAST_MIN - DAY_START_MIN))));
      }
      const chunk = dated.slice(k, k + n);
      spreadEven(chunk.length, from, to).forEach((m, j) => set(chunk[j].id, zonedToUtc(day, m, tz)));
      k += chunk.length;
      day = addDays(day, 1);
      first = false;
    }
  }

  const updates = new Map<string, Date | null>();
  let changed = 0;
  let cleared = 0;
  const out: FixRow[] = rows.map((r) => {
    const v = next.get(r.id) ?? null;
    if (!sameInstant(v, r.scheduledAt)) {
      updates.set(r.id, v);
      changed++;
      if (v === null) cleared++;
    }
    return { id: r.id, scheduledAt: v };
  });

  let firstDate: Date | null = null;
  let lastDate: Date | null = null;
  for (const r of out) {
    if (!r.scheduledAt) continue;
    if (!firstDate || r.scheduledAt < firstDate) firstDate = r.scheduledAt;
    if (!lastDate || r.scheduledAt > lastDate) lastDate = r.scheduledAt;
  }

  return { updates, rows: out, total: rows.length, missed: missed.length, changed, cleared, firstDate, lastDate };
}
