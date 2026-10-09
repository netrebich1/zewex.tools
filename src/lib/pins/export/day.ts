/**
 * Дневная выгрузка одного сайта (порт оркестрации `dayExport.ts`) как чистая функция:
 * пины дня → замена ссылок с редиректом → для сегодняшнего дня правка «до конца дня»
 * (fixer `today`) → preflight Pinterest → уникальные заголовки → CSV.
 * Загрузка пинов из БД, проверка редиректов и запись новых дат — на стороне вызывающего.
 */

import { fixSchedule, type FixRow } from "@/lib/pins/schedule/fixer";
import { startOfDay } from "@/lib/pins/schedule/math";
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
  fixes: { retimed: number; linksReplaced: number; titlesRenamed: number };
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
  if (input.isToday) {
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

  // 4) Уникальные заголовки и CSV.
  const titled = dedupeTitles(report.rows);
  const csv = buildPinterestCsv(titled.rows, tz);

  return {
    fileName: fileName(day, input.siteName, input.isToday && retimed > 0),
    csv,
    rows: titled.rows,
    issues: report.issues,
    textFixes: report.fixes,
    fixes: { retimed, linksReplaced, titlesRenamed: titled.renamed },
    retimedAt,
    count: titled.rows.length,
  };
}
