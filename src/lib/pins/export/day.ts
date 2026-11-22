/**
 * Дневная выгрузка одного сайта (порт оркестрации `dayExport.ts`) как чистая функция:
 * пины дня → замена ссылок с редиректом → для сегодняшнего дня правка «до конца дня»
 * (fixer `today`) → preflight Pinterest → уникальные заголовки → CSV.
 * Загрузка пинов из БД, проверка редиректов и запись новых дат — на стороне вызывающего.
 */

import { fixSchedule, type FixRow } from "@/lib/pins/schedule/fixer";
import { dayKey, startOfDay } from "@/lib/pins/schedule/math";
import { SCHEDULED_PER_DAY } from "@/lib/pins/types";
import {
  buildPinterestCsv,
  dedupeTitles,
  fileName,
  preparePinterestExport,
  type ExportItem,
  type PinterestFix,
  type PinterestIssue,
  type PinterestRow,
} from "./pinterest";

export type DayExportInput = {
  /** Пины этого дня (для сегодняшнего дня — плюс пропущенные с прошлых дней). */
  items: readonly ExportItem[];
  /** `YYYY-MM-DD` в поясе `tz`. */
  day: string;
  siteName: string;
  tz: string;
  now: Date;
  isToday: boolean;
  /** Старая ссылка → конечная после редиректа. */
  redirects?: ReadonlyMap<string, string>;
  /** Запас для fixer в минутах (по умолчанию 20). */
  bufferMinutes?: number;
};

export type DayExportResult = {
  fileName: string;
  csv: string;
  rows: PinterestRow[];
  issues: PinterestIssue[];
  /** Сведения preflight по строкам, попавшим в файл. */
  textFixes: PinterestFix[];
  fixes: { retimed: number; linksReplaced: number; titlesRenamed: number; immediate: number };
  /** Новые даты из fixer (id → Date) — их нужно записать в БД. */
  retimedAt: Map<string, Date>;
  count: number;
};

export function buildDayFiles(input: DayExportInput): DayExportResult {
  const { tz, now, day } = input;

  // 1) Ссылки с редиректом → конечные адреса.
  let linksReplaced = 0;
  let items: ExportItem[] = input.items.map((it) => {
    const nu = input.redirects?.get(it.link.trim());
    if (!nu || nu === it.link) return { ...it };
    linksReplaced++;
    return { ...it, link: nu };
  });

  // 2) Сегодня — правка «до конца дня»; другие дни — даты не трогаем.
  let retimed = 0;
  const retimedAt = new Map<string, Date>();
  // Поздний файл: запас (now + buffer) уже за полночью. Раньше пропущенные пины уезжали на завтра, и завтрашний
  // файл их повторял (22.11: 96+95 = 191 у azureglam). Теперь они остаются в своём дне и в файле идут без даты —
  // Pinterest публикует их сразу при загрузке; в базе даты не меняются.
  const lateIds = new Set<string>();
  const safeAt = new Date(now.getTime() + (input.bufferMinutes ?? 20) * 60_000);
  if (input.isToday && dayKey(safeAt, tz) !== day) {
    for (const it of items) if (it.scheduledAt && it.scheduledAt.getTime() < safeAt.getTime()) lateIds.add(it.id);
    // для preflight — любая допустимая дата; в CSV у них всё равно будет пустая дата
    items = items.map((it) => (lateIds.has(it.id) ? { ...it, scheduledAt: safeAt } : it));
  } else if (input.isToday) {
    const rows: FixRow[] = items.map((it) => ({ id: it.id, scheduledAt: it.scheduledAt }));
    const fx = fixSchedule(rows, "today", { now, tz, bufferMinutes: input.bufferMinutes });
    retimed = fx.changed;
    const byId = new Map(fx.rows.map((r) => [r.id, r.scheduledAt] as const));
    items = items.map((it) => ({ ...it, scheduledAt: byId.has(it.id) ? (byId.get(it.id) ?? null) : it.scheduledAt }));
    for (const [id, d] of fx.updates) if (d) retimedAt.set(id, d);
  }
  items.sort((a, b) => (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0));

  // 3) Preflight: для прошлых/будущих дней точка отсчёта — полночь дня, чтобы даты не сдвигались.
  const report = preparePinterestExport(items, { tz, now: input.isToday ? now : startOfDay(day, tz) });

  // 4) Уникальные заголовки. Сверх 100 пинов в дне Pinterest по времени не ставит: первые 100 (по времени)
  // идут с датой, остальные — с пустой датой и публикуются сразу при загрузке файла.
  const titled = dedupeTitles(report.rows);
  // Время, которое preflight сдвинул за полночь (поздний вечер, плотные слоты), тоже без даты: иначе пин уйдёт в завтрашний день Pinterest.
  const keep = (r: (typeof titled.rows)[number], i: number) => i < SCHEDULED_PER_DAY && !lateIds.has(r.id) && (!input.isToday || !r.publishDate || dayKey(r.publishDate, tz) === day);
  titled.rows = titled.rows.map((r, i) => (keep(r, i) ? r : { ...r, publishDate: null }));
  const immediate = titled.rows.filter((r) => !r.publishDate).length;
  const csv = buildPinterestCsv(titled.rows, tz);

  return {
    fileName: fileName(day, input.siteName, input.isToday && retimed > 0, titled.rows.length),
    csv,
    rows: titled.rows,
    issues: report.issues,
    textFixes: report.fixes,
    fixes: { retimed, linksReplaced, titlesRenamed: titled.renamed, immediate },
    retimedAt,
    count: titled.rows.length,
  };
}
