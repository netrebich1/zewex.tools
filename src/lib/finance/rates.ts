import { prisma } from "@/lib/db";
import { BASE, normCur, todayYmd } from "./currency";

/**
 * Курсы валют на дату: середина рынка (как показывает Google) из бесплатного @fawazahmed0/currency-api —
 * история по дням, есть UAH, USDT и крипта. Кэш в `FinRate`: прошлые даты навсегда, сегодня — 3 часа.
 * Хранится «1 EUR = N единиц валюты» (ключи в нижнем регистре, как отдаёт источник).
 */
type Table = Record<string, number>;

const urls = (date: string) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/eur.min.json`,
  `https://${date}.currency-api.pages.dev/v1/currencies/eur.min.json`,
];

async function download(date: string): Promise<{ date: string; rates: Table } | null> {
  for (const u of urls(date)) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (!r.ok) continue;
      const j = (await r.json()) as { date?: string; eur?: Table };
      if (j.eur && typeof j.eur.usd === "number") return { date: j.date ?? date, rates: j.eur };
    } catch {
      /* следующий адрес */
    }
  }
  return null;
}

const mem = new Map<string, { at: number; rates: Table }>();

/** Таблица курсов на дату. Если источник недоступен — ближайшая прошлая дата из кэша; нет и её — null. */
export async function ratesOn(date: string): Promise<{ date: string; rates: Table; stale: boolean } | null> {
  const today = todayYmd();
  const d = date > today ? today : date;
  const ttl = d === today ? 3 * 3600_000 : Infinity;
  const m = mem.get(d);
  if (m && Date.now() - m.at < ttl) return { date: d, rates: m.rates, stale: false };
  const row = await prisma.finRate.findUnique({ where: { date: d } });
  if (row && Date.now() - row.fetchedAt.getTime() < ttl) {
    mem.set(d, { at: row.fetchedAt.getTime(), rates: row.rates as Table });
    return { date: d, rates: row.rates as Table, stale: false };
  }
  // Сегодняшние курсы источник публикует в течение дня; до этого берём «latest».
  const got = (await download(d)) ?? (d === today ? await download("latest") : null);
  if (got) {
    await prisma.finRate.upsert({ where: { date: d }, update: { rates: got.rates, fetchedAt: new Date() }, create: { date: d, rates: got.rates } });
    mem.set(d, { at: Date.now(), rates: got.rates });
    return { date: d, rates: got.rates, stale: false };
  }
  if (row) return { date: d, rates: row.rates as Table, stale: true };
  const prev = await prisma.finRate.findFirst({ where: { date: { lt: d } }, orderBy: { date: "desc" } });
  return prev ? { date: prev.date, rates: prev.rates as Table, stale: true } : null;
}

/** Сколько EUR стоит 1 единица валюты на дату. null — курса нет (просим вписать вручную). */
export async function rateToEur(currency: string, date: string): Promise<{ rate: number; date: string; stale: boolean } | null> {
  const cur = normCur(currency);
  if (cur === BASE) return { rate: 1, date, stale: false };
  const t = await ratesOn(date);
  const per = t?.rates[cur.toLowerCase()];
  return t && per && per > 0 ? { rate: 1 / per, date: t.date, stale: t.stale } : null;
}

/** Сколько единиц валюты показа в 1 EUR сегодня (для переключателя итогов). */
export async function displayFactor(cur: string): Promise<number> {
  if (cur === BASE) return 1;
  const r = await rateToEur(cur, todayYmd());
  return r ? 1 / r.rate : 1;
}
