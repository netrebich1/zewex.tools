import { prisma } from "@/lib/db";
import { todayYmd } from "./currency";
import { rateToEur } from "./rates";

/**
 * Регулярные операции (`FinRecurring`): раз в месяц в свой день система сама записывает `FinOp` по шаблону.
 * Курс — рыночный на дату операции. Пропущенные месяцы (воркер стоял, правило создано задним числом) вносятся при первом же проходе.
 */

/** Ближайшая дата строго после `fromYmd` с днём месяца `day`; в коротком месяце — его последний день. */
export function nextMonthly(fromYmd: string, day: number): string {
  const [y, m] = fromYmd.split("-").map(Number);
  const at = (yy: number, m0: number) => {
    const last = new Date(Date.UTC(yy, m0 + 1, 0)).getUTCDate();
    return new Date(Date.UTC(yy, m0, Math.min(Math.max(1, day), last))).toISOString().slice(0, 10);
  };
  const same = at(y, m - 1);
  return same > fromYmd ? same : at(y, m);
}

const asDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

/** Вносит все операции, срок которых наступил. Безопасно вызывать часто: дата правила сдвигается в одной транзакции с записью операции. */
export async function recurringTick(today = todayYmd()): Promise<{ created: number; skipped: number }> {
  const due = await prisma.finRecurring.findMany({ where: { active: true, nextDate: { lte: asDate(today) } } });
  if (!due.length) return { created: 0, skipped: 0 };
  const partners = new Set((await prisma.finPartner.findMany({ select: { id: true } })).map((p) => p.id));
  let created = 0, skipped = 0;
  for (const r of due) {
    if (!partners.has(r.partnerId)) { skipped++; continue; }
    let date = r.nextDate.toISOString().slice(0, 10);
    // Не больше года за проход — защита от правила с датой далеко в прошлом.
    for (let i = 0; i < 12 && date <= today; i++) {
      const rate = await rateToEur(r.currency, date);
      if (!rate) { skipped++; break; } // курса нет — попробуем в следующий проход
      const next = nextMonthly(date, r.day);
      const amount = Number(r.amount);
      const done = await prisma.$transaction(async (tx) => {
        // Сдвиг даты с условием «дата ещё прежняя»: два прохода одновременно не запишут операцию дважды.
        const moved = await tx.finRecurring.updateMany({ where: { id: r.id, active: true, nextDate: asDate(date) }, data: { nextDate: asDate(next), lastDate: asDate(date) } });
        if (!moved.count) return false;
        await tx.finOp.create({
          data: {
            type: r.type, date: asDate(date), amount, currency: r.currency, rate: rate.rate, rateManual: false,
            amountEur: Math.round(amount * rate.rate * 100) / 100,
            directionId: r.directionId, categoryId: r.categoryId, counterpartyId: r.counterpartyId, partnerId: r.partnerId,
            account: r.account, note: r.note, createdById: r.createdById, recurringId: r.id,
          },
        });
        return true;
      });
      if (!done) break;
      created++;
      date = next;
    }
  }
  return { created, skipped };
}
