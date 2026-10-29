/**
 * «Плавный рост» для молодых сайтов: ступени «N дней по M пинов в день», после последней ступени —
 * её норма дальше. Чистые функции без Prisma и React: ими пользуются этап расписания, перераспределение и формы.
 */

/** = MAX_DAY_PINS в types.ts (тут без импорта: types.ts сам импортирует этот модуль). */
const DAY_MAX = 200;

export type GrowthStep = { days: number; perDay: number };

/** Пример по умолчанию: неделя по 15, неделя по 20, неделя по 30, неделя по 40 (и дальше по 40). */
export const DEFAULT_GROWTH: GrowthStep[] = [
  { days: 7, perDay: 15 },
  { days: 7, perDay: 20 },
  { days: 7, perDay: 30 },
  { days: 7, perDay: 40 },
];

export const MAX_GROWTH_STEPS = 12;

/** Чистка ступеней из формы/JSON: дни 1…90, пинов 1…200, не больше 12 ступеней. */
export function cleanGrowth(raw: unknown): GrowthStep[] {
  if (!Array.isArray(raw)) return [];
  const out: GrowthStep[] = [];
  for (const s of raw) {
    const days = Math.floor(Number((s as GrowthStep | null)?.days));
    const perDay = Math.floor(Number((s as GrowthStep | null)?.perDay));
    if (!(days >= 1) || !(perDay >= 1)) continue;
    out.push({ days: Math.min(90, days), perDay: Math.min(DAY_MAX, perDay) });
    if (out.length >= MAX_GROWTH_STEPS) break;
  }
  return out;
}

/** Норма дня по смещению от первого дня (0 = первый день). После последней ступени — её норма. */
export function growthQuota(steps: readonly GrowthStep[], off: number): number {
  if (!steps.length) return 0;
  let left = off;
  for (const s of steps) {
    if (left < s.days) return s.perDay;
    left -= s.days;
  }
  return steps[steps.length - 1].perDay;
}

/** Сколько дней нужно, чтобы поставить `count` пинов при этих ступенях (для окна планировщика и подсказок). */
export function growthDaysFor(steps: readonly GrowthStep[], count: number, maxDays = 400): number {
  if (!steps.length || count <= 0) return 0;
  let left = count;
  for (let off = 0; off < maxDays; off++) {
    left -= Math.max(1, growthQuota(steps, off));
    if (left <= 0) return off + 1;
  }
  return maxDays;
}

/** Сколько пинов вмещают сами ступени (без продолжения последней). */
export function growthTotal(steps: readonly GrowthStep[]): number {
  return steps.reduce((n, s) => n + s.days * s.perDay, 0);
}

/** «7 дн. × 15 → 7 дн. × 20 → дальше по 40». */
export function describeGrowth(steps: readonly GrowthStep[]): string {
  if (!steps.length) return "";
  return `${steps.map((s) => `${s.days} дн. × ${s.perDay}`).join(" → ")} → дальше по ${steps[steps.length - 1].perDay}`;
}

/** Расписание прогона одной строкой для шапки: «90/день», «плавный рост: …», «вклинен: 15/день, всего 100/день». */
export function describeSchedule(s: { dailyMode: string; pinsPerDay: number; lastDate?: string; growth?: GrowthStep[]; insertTotal?: number }): string {
  if (s.dailyMode === "growth" && s.growth?.length) return `плавный рост: ${describeGrowth(s.growth)}`;
  if (s.dailyMode === "insert") return `вклинен: ${s.pinsPerDay}/день${s.insertTotal ? `, всего ${s.insertTotal}/день` : ""}`;
  if (s.dailyMode === "dates") return `равномерно до ${(s.lastDate || "").split("-").reverse().join(".")}`;
  return `${s.pinsPerDay}/день`;
}
