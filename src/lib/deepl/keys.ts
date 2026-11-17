/**
 * Сводка по ключам DeepL для шапки инструмента: сколько ключей в работе и примерно сколько символов осталось.
 * «Хватит примерно на N статей» — по среднему расходу символов DeepL на статью в последних прогонах.
 */
import { prisma } from "@/lib/db";

export type KeysSummary = {
  total: number;
  /** Активны и с остатком лимита */
  working: number;
  /** Активны, но лимит исчерпан */
  exhausted: number;
  /** Выключены вручную или DeepL отказал */
  off: number;
  /** Остаток символов по рабочим ключам; null — есть ключ без лимита */
  remaining: number | null;
  /** Средний расход символов DeepL на статью (по последним 200 статьям); null — истории нет */
  perArticle: number | null;
  lastUsageAt: Date | null;
};

export async function keysSummary(): Promise<KeysSummary> {
  const [keys, recent] = await Promise.all([
    prisma.deeplKey.findMany({ where: { deletedAt: null }, select: { isActive: true, charLimit: true, charUsed: true, usageAt: true } }),
    prisma.deeplItem.findMany({ where: { deeplChars: { gt: 0 } }, orderBy: { finishedAt: "desc" }, take: 200, select: { deeplChars: true } }),
  ]);
  const isExhausted = (k: { charLimit: number | null; charUsed: number }) => k.charLimit != null && k.charUsed >= k.charLimit;
  const working = keys.filter((k) => k.isActive && !isExhausted(k));
  const unlimited = working.some((k) => k.charLimit == null);
  return {
    total: keys.length,
    working: working.length,
    exhausted: keys.filter((k) => k.isActive && isExhausted(k)).length,
    off: keys.filter((k) => !k.isActive).length,
    remaining: unlimited ? null : working.reduce((a, k) => a + Math.max(0, (k.charLimit ?? 0) - k.charUsed), 0),
    perArticle: recent.length ? recent.reduce((a, r) => a + r.deeplChars, 0) / recent.length : null,
    lastUsageAt: keys.reduce<Date | null>((m, k) => (k.usageAt && (!m || k.usageAt > m) ? k.usageAt : m), null),
  };
}

/** 4 380 000 → «4,38 млн», 230 500 → «231 тыс.» */
export function fmtChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} млн`;
  if (n >= 10_000) return `${Math.round(n / 1000).toLocaleString("ru-RU")} тыс.`;
  return Math.round(n).toLocaleString("ru-RU");
}

export type KeyLifeStats = {
  /** Всего добавлено за всё время, включая удалённые */
  added: number;
  alive: number;
  dead: number;
  exhausted: number;
  rejected: number;
  /** Удалены, не успев выйти из строя */
  deletedAlive: number;
  /** Срок жизни вышедших из строя ключей, дни: медиана и среднее */
  medianDays: number | null;
  avgDays: number | null;
  /** Сколько символов в среднем перевёл ключ до выхода из строя */
  avgCharsDead: number | null;
  /** Через сколько вышли из строя: «до суток», «1–7 дн», … */
  buckets: { label: string; count: number }[];
  /** По месяцам добавления: сколько добавлено, сколько уже вышло из строя, средний срок жизни вышедших */
  byMonth: { month: string; added: number; dead: number; avgDays: number | null }[];
};

const DAY = 24 * 60 * 60_000;
const BUCKETS: [string, number][] = [["до суток", 1], ["1–7 дн", 7], ["7–30 дн", 30], ["30–90 дн", 90], ["больше 90 дн", Infinity]];

/** Статистика «сколько ключей и через сколько перестали работать» — по всем ключам, включая удалённые. */
export async function keysLifeStats(): Promise<KeyLifeStats> {
  const keys = await prisma.deeplKey.findMany({ select: { createdAt: true, deadAt: true, deadReason: true, deletedAt: true, charUsed: true } });
  const dead = keys.filter((k) => k.deadAt);
  const life = dead.map((k) => (k.deadAt!.getTime() - k.createdAt.getTime()) / DAY).sort((a, b) => a - b);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const months = new Map<string, { added: number; life: number[] }>();
  for (const k of keys) {
    const m = k.createdAt.toISOString().slice(0, 7);
    const e = months.get(m) ?? { added: 0, life: [] };
    e.added++;
    if (k.deadAt) e.life.push((k.deadAt.getTime() - k.createdAt.getTime()) / DAY);
    months.set(m, e);
  }
  return {
    added: keys.length,
    alive: keys.filter((k) => !k.deadAt && !k.deletedAt).length,
    dead: dead.length,
    exhausted: dead.filter((k) => k.deadReason === "exhausted").length,
    rejected: dead.filter((k) => k.deadReason !== "exhausted").length,
    deletedAlive: keys.filter((k) => !k.deadAt && k.deletedAt).length,
    medianDays: life.length ? life[Math.floor(life.length / 2)]! : null,
    avgDays: avg(life),
    avgCharsDead: avg(dead.map((k) => k.charUsed)),
    buckets: BUCKETS.map(([label, max], i) => ({ label, count: life.filter((d) => d < max && d >= (i ? BUCKETS[i - 1]![1] : 0)).length })),
    byMonth: [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, e]) => ({ month, added: e.added, dead: e.life.length, avgDays: avg(e.life) })),
  };
}

/** 0,4 дн → «10 ч», 3,2 → «3,2 дн» */
export function fmtDays(d: number | null): string {
  if (d == null) return "—";
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} ч`;
  return `${d.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} дн`;
}
