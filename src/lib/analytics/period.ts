/**
 * Периоды и даты без часовых поясов: всё в строках "YYYY-MM-DD", арифметика через UTC-полночь (без сюрпризов с переводом часов).
 * Чистые функции — используются и на сервере, и в клиентских компонентах.
 */

export type Preset = "today" | "yesterday" | "7d" | "30d" | "90d" | "12m" | "custom";
export type Compare = "prev" | "year" | "none";
export type Grain = "hour" | "day" | "week" | "month";
export type Metric = "sessions" | "users" | "pageviews";

export const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: "today", label: "Сегодня" },
  { key: "yesterday", label: "Вчера" },
  { key: "7d", label: "7 дней" },
  { key: "30d", label: "30 дней" },
  { key: "90d", label: "90 дней" },
  { key: "12m", label: "12 месяцев" },
];
export const GRAINS: Array<{ key: Grain; label: string }> = [
  { key: "hour", label: "По часам" },
  { key: "day", label: "По дням" },
  { key: "week", label: "По неделям" },
  { key: "month", label: "По месяцам" },
];
export const METRICS: Array<{ key: Metric; label: string }> = [
  { key: "sessions", label: "Визиты" },
  { key: "users", label: "Посетители" },
  { key: "pageviews", label: "Просмотры" },
];

export type Range = {
  preset: Preset;
  from: string;
  to: string;
  /** Период сравнения (той же длины) или null */
  prev: { from: string; to: string } | null;
  compare: Compare;
  grain: Grain;
  /** Выбранная вручную детализация (иначе авто) */
  grainManual: boolean;
  metric: Metric;
  days: number;
};

const DAY = 86_400_000;
export const toUtc = (d: string) => new Date(`${d}T00:00:00Z`);
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(new Date(toUtc(d).getTime() + n * DAY));
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / DAY);
export const addYears = (d: string, n: number) => {
  const x = toUtc(d);
  x.setUTCFullYear(x.getUTCFullYear() + n);
  return iso(x);
};
const RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s: unknown): s is string => typeof s === "string" && RE.test(s) && !Number.isNaN(toUtc(s).getTime());

/** Сегодняшняя дата в часовом поясе. */
export function todayIn(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return iso(new Date());
  }
}

export function autoGrain(days: number): Grain {
  if (days <= 2) return "hour";
  if (days <= 92) return "day";
  if (days <= 400) return "week";
  return "month";
}

/** Детализации, которые имеют смысл для диапазона (по часам — до 7 дней). */
export function allowedGrains(days: number): Grain[] {
  const g: Grain[] = [];
  if (days <= 7) g.push("hour");
  if (days <= 400) g.push("day");
  if (days >= 7) g.push("week");
  if (days >= 28) g.push("month");
  return g;
}

/** Разбор параметров адреса: p, from, to, cmp, g, m. */
export function parseRange(params: Record<string, string | string[] | undefined>, today: string): Range {
  const get = (k: string) => (Array.isArray(params[k]) ? (params[k] as string[])[0] : (params[k] as string | undefined));
  let preset = (get("p") as Preset) || "30d";
  let from: string;
  let to: string;
  const f = get("from");
  const t = get("to");
  if (preset === "custom" || (isDate(f) && isDate(t) && !PRESETS.some((p) => p.key === preset))) {
    preset = "custom";
    from = isDate(f) ? f : addDays(today, -29);
    to = isDate(t) ? t : today;
    if (from > to) [from, to] = [to, from];
    if (daysBetween(from, to) > 800) from = addDays(to, -800);
  } else {
    if (!PRESETS.some((p) => p.key === preset)) preset = "30d";
    to = preset === "yesterday" ? addDays(today, -1) : today;
    from = preset === "today" || preset === "yesterday" ? to : preset === "7d" ? addDays(today, -6) : preset === "30d" ? addDays(today, -29) : preset === "90d" ? addDays(today, -89) : addDays(addYears(today, -1), 1);
  }
  const days = daysBetween(from, to) + 1;
  const cmpRaw = get("cmp");
  const compare: Compare = cmpRaw === "none" || cmpRaw === "year" ? cmpRaw : "prev";
  const prev = compare === "none" ? null : compare === "year" ? { from: addYears(from, -1), to: addYears(to, -1) } : { from: addDays(from, -days), to: addDays(from, -1) };
  const gRaw = get("g") as Grain | undefined;
  const allowed = allowedGrains(days);
  const grainManual = !!gRaw && allowed.includes(gRaw);
  const grain = grainManual ? gRaw! : allowed.includes(autoGrain(days)) ? autoGrain(days) : allowed[0];
  const mRaw = get("m") as Metric | undefined;
  const metric: Metric = mRaw && METRICS.some((m) => m.key === mRaw) ? mRaw : "sessions";
  return { preset, from, to, prev, compare, grain, grainManual, metric, days };
}

/** Параметры адреса для диапазона (чтобы ссылки сохраняли выбранный период). */
export function rangeParams(r: Range): Record<string, string> {
  const o: Record<string, string> = {};
  if (r.preset === "custom") {
    o.p = "custom";
    o.from = r.from;
    o.to = r.to;
  } else if (r.preset !== "30d") o.p = r.preset;
  if (r.compare !== "prev") o.cmp = r.compare;
  if (r.grainManual) o.g = r.grain;
  if (r.metric !== "sessions") o.m = r.metric;
  return o;
}

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_FULL = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const WEEKDAYS_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/** «15 окт», «15 окт 2025» */
export function fmtDay(d: string, withYear = false): string {
  const x = toUtc(d);
  return `${x.getUTCDate()} ${MONTHS_SHORT[x.getUTCMonth()]}${withYear ? ` ${x.getUTCFullYear()}` : ""}`;
}
export function fmtMonth(d: string): string {
  const x = toUtc(d);
  return `${MONTHS_FULL[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}
/** Подпись периода: «1–30 сен 2026», «15 окт 2026» */
export function fmtRange(from: string, to: string): string {
  const a = toUtc(from);
  const b = toUtc(to);
  if (from === to) return fmtDay(from, true);
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS_SHORT[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  if (a.getUTCFullYear() === b.getUTCFullYear()) return `${fmtDay(from)} – ${fmtDay(to)} ${a.getUTCFullYear()}`;
  return `${fmtDay(from, true)} – ${fmtDay(to, true)}`;
}
/** 0 = понедельник */
export function weekdayIndex(d: string): number {
  return (toUtc(d).getUTCDay() + 6) % 7;
}
/** Подпись точки графика по детализации. key: hour — "YYYY-MM-DD HH", day — "YYYY-MM-DD", week — дата понедельника, month — "YYYY-MM-01". */
export function pointLabel(key: string, grain: Grain, long = false): string {
  if (grain === "hour") {
    const [d, h] = key.split(" ");
    return long ? `${fmtDay(d)}, ${h}:00` : `${h}:00`;
  }
  if (grain === "month") return long ? fmtMonth(key) : `${MONTHS_SHORT[toUtc(key).getUTCMonth()]} ${String(toUtc(key).getUTCFullYear()).slice(2)}`;
  if (grain === "week") return long ? `неделя с ${fmtDay(key, true)}` : fmtDay(key);
  return long ? `${fmtDay(key, true)}, ${WEEKDAYS_SHORT[weekdayIndex(key)]}` : fmtDay(key);
}
