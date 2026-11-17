/** Словари раздела «Задачи» и работа с днями по Киеву. Без импорта Prisma — используется и на клиенте. */

export const TZ = "Europe/Kyiv";

export const STATUSES = [
  { key: "idea", label: "Идея", short: "Идея", tone: "idea" },
  { key: "backlog", label: "Бэклог", short: "Бэклог", tone: "neutral" },
  { key: "planned", label: "На день", short: "План", tone: "brand" },
  { key: "doing", label: "В работе", short: "Делаю", tone: "ok" },
  { key: "waiting", label: "Ждём ответа", short: "Ждём", tone: "warn" },
  { key: "done", label: "Готово", short: "Готово", tone: "done" },
  { key: "cancelled", label: "Отменено", short: "Отмена", tone: "muted" },
] as const;
export type Status = (typeof STATUSES)[number]["key"];
export const STATUS_KEYS = STATUSES.map((s) => s.key) as Status[];
export const OPEN_STATUSES: Status[] = ["idea", "backlog", "planned", "doing", "waiting"];
/** Колонки канбана (без отменённых). */
export const BOARD_STATUSES: Status[] = ["idea", "backlog", "planned", "doing", "waiting", "done"];
export const statusLabel = (k: string) => STATUSES.find((s) => s.key === k)?.label ?? k;
export const isStatus = (k: string): k is Status => STATUS_KEYS.includes(k as Status);

export const MODES = [
  { key: "do", label: "Сделать сам", short: "Сам", icon: "●", hint: "Делаю своими руками" },
  { key: "delegate", label: "Делегировать", short: "Делегировать", icon: "➜", hint: "Поручить кому-то и дождаться результата" },
  { key: "ask", label: "Спросить", short: "Спросить", icon: "?", hint: "Уточнить у кого-то, дождаться ответа" },
] as const;
export type Mode = (typeof MODES)[number]["key"];
export const isMode = (k: string): k is Mode => MODES.some((m) => m.key === k);
export const modeLabel = (k: string) => MODES.find((m) => m.key === k)?.label ?? k;

export const PRIORITIES = [
  { n: 1, label: "Срочно", icon: "🔥", cls: "text-danger" },
  { n: 2, label: "Важно", icon: "!", cls: "text-warn" },
  { n: 3, label: "Обычно", icon: "", cls: "text-muted" },
  { n: 4, label: "Когда-нибудь", icon: "~", cls: "text-muted" },
] as const;
export const priorityLabel = (n: number) => PRIORITIES.find((p) => p.n === n)?.label ?? "Обычно";
export const normPriority = (n: unknown) => { const v = Number(n); return v >= 1 && v <= 4 ? Math.round(v) : 3; };

export const RULES = [
  { key: "daily", label: "Каждый день" },
  { key: "weekly", label: "По дням недели" },
  { key: "monthly", label: "Каждое число месяца" },
  { key: "every_n", label: "Раз в N дней" },
] as const;
export type Rule = (typeof RULES)[number]["key"];
export const isRule = (k: string): k is Rule => RULES.some((r) => r.key === k);
export const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/* ---------- Дни ---------- */

/** Сегодня по Киеву: YYYY-MM-DD. */
export function todayYmd(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
/** Текущий час по Киеву (0–23). */
export function hourKyiv(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now).replace(/\D/g, "")) % 24;
}
export const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
/** YYYY-MM-DD → Date для колонок @db.Date (полночь UTC, как в финансах). */
export const ymdToDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
/** Колонка @db.Date → YYYY-MM-DD. */
export const dateToYmd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export function addDays(ymd: string, n: number): string {
  const d = ymdToDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const tomorrowYmd = (now = new Date()) => addDays(todayYmd(now), 1);
/** День недели 1=пн … 7=вс. */
export function weekday(ymd: string): number {
  const d = ymdToDate(ymd).getUTCDay();
  return d === 0 ? 7 : d;
}
export function dayOfMonth(ymd: string): number { return Number(ymd.slice(8, 10)); }
export function daysBetween(a: string, b: string): number { return Math.round((ymdToDate(b).getTime() - ymdToDate(a).getTime()) / 86400000); }

/** «сегодня», «завтра», «вчера», «пн, 12 ноя», «12 ноя 2025». */
export function fmtDay(ymd: string | null | undefined, now = new Date()): string {
  if (!ymd) return "";
  const today = todayYmd(now);
  if (ymd === today) return "сегодня";
  if (ymd === addDays(today, 1)) return "завтра";
  if (ymd === addDays(today, -1)) return "вчера";
  const d = ymdToDate(ymd);
  const sameYear = ymd.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", weekday: sameYear ? "short" : undefined, day: "numeric", month: "short", year: sameYear ? undefined : "numeric" }).format(d).replace(".", "");
}
export function fmtDateTime(d: Date | string): string {
  return new Date(d).toLocaleString("ru-RU", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).replace(".", "");
}
