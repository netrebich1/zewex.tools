import { prisma } from "@/lib/db";
import { addDays, dayOfMonth, daysBetween, dateToYmd, isYmd, todayYmd, weekday, ymdToDate, type Rule } from "./consts";

/** Регламенты: расчёт следующей даты и создание задач воркером. */

/** Ближайший день ≥ from, подходящий правилу. */
export function nextDate(rule: Rule, arg: string, from: string, lastAt: string | null): string {
  if (rule === "daily") return from;
  if (rule === "weekly") {
    const days = arg.split(",").map((x) => Number(x.trim())).filter((x) => x >= 1 && x <= 7);
    if (!days.length) return from;
    for (let i = 0; i < 8; i++) { const d = addDays(from, i); if (days.includes(weekday(d))) return d; }
    return from;
  }
  if (rule === "monthly") {
    const dom = Math.min(31, Math.max(1, Number(arg) || 1));
    for (let i = 0; i < 70; i++) {
      const d = addDays(from, i);
      if (dayOfMonth(d) === dom) return d;
      // В месяце меньше дней, чем dom (30-е февраля) — берём последний день месяца
      if (dayOfMonth(d) < dom && addDays(d, 1).slice(0, 7) !== d.slice(0, 7)) return d;
    }
    return from;
  }
  // every_n
  const n = Math.max(1, Number(arg) || 1);
  if (!lastAt) return from;
  const target = addDays(lastAt, n);
  return target < from ? from : target;
}

export function describeRule(rule: string, arg: string): string {
  if (rule === "daily") return "каждый день";
  if (rule === "weekly") {
    const names = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
    const days = arg.split(",").map((x) => Number(x.trim())).filter((x) => x >= 1 && x <= 7).map((x) => names[x]);
    return days.length === 7 ? "каждый день" : `по ${days.join(", ") || "пн"}`;
  }
  if (rule === "monthly") return `${arg}-го числа каждого месяца`;
  return `раз в ${arg} ${Number(arg) === 1 ? "день" : Number(arg) < 5 ? "дня" : "дней"}`;
}

/**
 * Создать задачи из регламентов, у которых наступил nextAt (день по Киеву). Одна задача на регламент и день
 * (проверка по routineId+planDate). Возвращает число созданных.
 */
export async function spawnRoutineTasks(now = new Date()): Promise<number> {
  const today = todayYmd(now);
  const due = await prisma.tkRoutine.findMany({ where: { active: true, OR: [{ nextAt: null }, { nextAt: { lte: ymdToDate(today) } }] } });
  let created = 0;
  for (const r of due) {
    const rule = r.rule as Rule;
    const last = dateToYmd(r.lastAt);
    const target = r.nextAt ? dateToYmd(r.nextAt)! : nextDate(rule, r.ruleArg, today, last);
    const planYmd = target < today ? today : target; // пропущенные дни не накапливаются: одна задача сегодня
    if (planYmd === today || target <= today) {
      const exists = await prisma.tkTask.findFirst({ where: { routineId: r.id, planDate: ymdToDate(planYmd) }, select: { id: true } });
      if (!exists) {
        const steps = Array.isArray(r.steps) ? (r.steps as unknown[]).map((s) => String(s).trim()).filter(Boolean) : [];
        await prisma.tkTask.create({
          data: {
            title: r.title, description: r.description, projectId: r.projectId, routineId: r.id, mode: r.mode, priority: r.priority, assigneeId: r.assigneeId,
            status: "planned", planDate: ymdToDate(planYmd), dueAt: ymdToDate(planYmd),
            checks: { create: steps.map((text, i) => ({ text: text.slice(0, 300), order: i })) },
            notes: { create: { kind: "event", text: "Создана регламентом" } },
          },
        });
        created++;
      }
      const next = nextDate(rule, r.ruleArg, addDays(planYmd, 1), planYmd);
      await prisma.tkRoutine.update({ where: { id: r.id }, data: { lastAt: ymdToDate(planYmd), nextAt: ymdToDate(next) } });
    } else if (!r.nextAt) {
      await prisma.tkRoutine.update({ where: { id: r.id }, data: { nextAt: ymdToDate(target) } });
    }
  }
  return created;
}

/** Пересчитать nextAt после правки регламента (с завтра, если сегодня уже была задача). */
export function firstNext(rule: Rule, arg: string, lastAt: string | null): string {
  const today = todayYmd();
  const from = lastAt === today ? addDays(today, 1) : today;
  const d = nextDate(rule, arg, from, lastAt);
  return isYmd(d) ? d : today;
}

export { daysBetween };
