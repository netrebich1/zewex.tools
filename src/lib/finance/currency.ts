/** Валюты и форматирование сумм. Чистые функции — работают и на клиенте. Учёт ведётся в EUR. */

export const BASE = "EUR";
/** Валюты операций: кнопки в форме. Старые операции в другой валюте показываются как есть. */
export const CURRENCIES = ["EUR", "USD", "UAH", "USDT"] as const;
/** Валюты показа итогов (переключатель). */
export const DISPLAY = ["EUR", "USD", "UAH"] as const;
export type DisplayCur = (typeof DISPLAY)[number];
export const DISPLAY_COOKIE = "zx_fin_cur";

export const SYMBOL: Record<string, string> = { EUR: "€", USD: "$", UAH: "₴", GBP: "£", PLN: "zł", RUB: "₽" };

export const normCur = (c: string) => c.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
export const asDisplay = (c: string | undefined): DisplayCur => ((DISPLAY as readonly string[]).includes(c ?? "") ? (c as DisplayCur) : "EUR");

/** 1 234,56 € / 1 234,56 USDT. `sign` — ставить «+» у положительных. */
export function fmtAmount(v: number, cur: string, opts: { sign?: boolean; digits?: number } = {}): string {
  const digits = opts.digits ?? (Math.abs(v) >= 1000 ? 0 : 2);
  const s = Math.abs(v).toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  const sym = SYMBOL[cur];
  return sym ? `${sign}${s} ${sym}` : `${sign}${s} ${cur}`;
}

/** Курс для подписи: «1 EUR = 45,21 UAH» (так же, как ищут в Google). `rate` — EUR за 1 единицу валюты. */
export function rateLabel(cur: string, rate: number): string {
  if (cur === BASE || !rate) return "";
  const per = 1 / rate;
  const digits = per >= 100 ? 2 : per >= 1 ? 4 : 8;
  return `1 EUR = ${per.toLocaleString("ru-RU", { maximumFractionDigits: digits })} ${cur}`;
}

/** Строка даты YYYY-MM-DD в UTC (даты операций хранятся как @db.Date). */
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
