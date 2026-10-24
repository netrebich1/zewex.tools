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
    prisma.deeplKey.findMany({ select: { isActive: true, charLimit: true, charUsed: true, usageAt: true } }),
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
