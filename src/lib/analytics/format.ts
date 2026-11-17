/** Форматирование чисел для кабинета аналитики (чистые функции, годятся на клиенте). */

const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
export const fmtInt = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "—" : nf.format(Math.round(v)));

/** 12 345 → «12,3 тыс.», 1 234 567 → «1,23 млн» — для тесных мест (оси, спарклайны). */
export function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 2).replace(".", ",")} млн`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)} тыс.`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1).replace(".", ",")} тыс.`;
  return nf.format(Math.round(v));
}

export const fmtPct = (v: number | null | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits).replace(".", ",")} %`);

/** Секунды → «1:23» или «12:05» */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export const fmtDecimal = (v: number | null | undefined, digits = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits).replace(".", ","));

/** Изменение к прошлому периоду: доля (0.12 = +12 %) или null, если сравнивать не с чем. */
export function delta(cur: number, prev: number | null | undefined): number | null {
  if (prev == null) return null;
  if (!prev) return cur ? Infinity : 0;
  return (cur - prev) / prev;
}
export function fmtDelta(d: number | null): string {
  if (d == null) return "";
  if (!Number.isFinite(d)) return "новое";
  const p = Math.abs(d) * 100;
  const s = p >= 100 ? p.toFixed(0) : p >= 10 ? p.toFixed(0) : p.toFixed(1).replace(".", ",");
  return `${d > 0 ? "+" : d < 0 ? "−" : ""}${s} %`;
}

/** Склонение: plural(n, "сайт", "сайта", "сайтов") */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
