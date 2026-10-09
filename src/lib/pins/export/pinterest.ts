/**
 * CSV для массовой загрузки пинов в Pinterest. Порт `preparePinterestExport` и
 * сборки CSV из `bulkEngine.ts` старого приложения — без React, без Supabase.
 * Даты — `Date` (UTC); в CSV пишутся в поясе `tz` в формате `YYYY-MM-DDTHH:mm:ss`.
 */

import { LIMITS } from "@/lib/pins/types";
import { DEFAULT_TZ, formatPinterestDate, keyParts } from "@/lib/pins/schedule/math";

/** Эмодзи, ZWJ, variation selectors и разделители строк ломают импорт CSV в Pinterest («Upload issue»). */
export const PINTEREST_UNSAFE_CHARS =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u200B-\u200F\u2028\u2029\u2060\uFE00-\uFE0F\u{E0000}-\u{E007F}]/gu;

export const PINTEREST_CSV_HEADERS = [
  "Title",
  "Media URL",
  "Pinterest board",
  "Thumbnail",
  "Description",
  "Link",
  "Publish date",
  "Keywords",
] as const;

export const PINTEREST_MAX_ROWS = 200;
export const BOARD_MAX = 120;
export const KEYWORDS_MAX = 200;

export type PinterestRow = {
  id: string;
  title: string;
  mediaUrl: string;
  board: string;
  thumbnail?: string;
  description: string;
  link: string;
  publishDate: Date;
  keywords?: string;
};

export type PinterestIssueReason =
  | "missing_title"
  | "missing_media"
  | "missing_board"
  | "missing_description"
  | "missing_link"
  | "missing_schedule"
  | "bad_media_url"
  | "bad_link_url"
  | "no_free_slot";

export type PinterestFixCode =
  | "title_trimmed"
  | "description_trimmed"
  | "keyword_trimmed"
  | "title_from_description"
  | "date_moved_forward"
  | "duplicate_time_moved";

export const PINTEREST_ISSUE_LABEL: Record<PinterestIssueReason, string> = {
  missing_title: "нет заголовка",
  missing_media: "нет ссылки на картинку",
  missing_board: "не выбрана доска",
  missing_description: "нет описания",
  missing_link: "нет ссылки на страницу",
  missing_schedule: "нет даты публикации",
  bad_media_url: "невалидная ссылка на картинку",
  bad_link_url: "невалидная ссылка на страницу",
  no_free_slot: "не нашлось свободного времени публикации",
};

export const PINTEREST_FIX_LABEL: Record<PinterestFixCode, string> = {
  title_trimmed: `заголовок обрезан до ${LIMITS.title} символов`,
  description_trimmed: `описание обрезано до ${LIMITS.description} символов`,
  keyword_trimmed: `ключевые слова обрезаны до ${KEYWORDS_MAX} символов`,
  title_from_description: "заголовок взят из описания",
  date_moved_forward: "прошлая/близкая дата сдвинута вперёд",
  duplicate_time_moved: "дубликат времени сдвинут на свободный слот",
};

export type ExportItem = {
  id: string;
  title: string;
  description: string;
  /** В CSV Pinterest не попадает (нет колонки), оставлен для единообразия входа. */
  altText: string;
  imageUrl: string;
  link: string;
  boardName: string;
  scheduledAt: Date | null;
  keywords?: string;
};

export type PrepareOptions = {
  tz: string;
  now: Date;
  /** Публикация не раньше `now + minLeadMinutes` (Pinterest: 15). */
  minLeadMinutes?: number;
  /** Шаг, на который разводятся одинаковые времена (Pinterest: 5). */
  slotStepMinutes?: number;
};

export type PinterestIssue = { id: string; reason: PinterestIssueReason };
export type PinterestFix = { id: string; fix: PinterestFixCode };

export type PrepareResult = {
  rows: PinterestRow[];
  issues: PinterestIssue[];
  fixes: PinterestFix[];
};

/* ------------------------------ текст ------------------------------- */

/** Чистит текст для Pinterest: управляющие символы, эмодзи, типографские кавычки/тире, лишние пробелы. */
export function normalizeText(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(PINTEREST_UNSAFE_CHARS, "")
    .replace(/[‒-―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Нормализация + обрезка по границе слова (Pinterest режет строки жёстко и ругается на длину). */
export function clampText(s: string | null | undefined, max: number): { text: string; trimmed: boolean } {
  const t = normalizeText(s);
  if (t.length <= max) return { text: t, trimmed: false };
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return { text: (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim(), trimmed: true };
}

/** Ячейка CSV: кавычки удваиваются, переводы строк заменяются пробелом, всегда в кавычках. */
export function csvEscape(v: string | null | undefined): string {
  return `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

function cleanUrl(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/[\u0000-\u001F\u007F\s]+/g, "");
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && Boolean(u.hostname);
  } catch {
    return false;
  }
}

function titleFromDescription(desc: string, keywords: string): string {
  const first = (desc.split(/(?<=[.!?])\s+/)[0] ?? "").replace(/#\S+/g, "").trim();
  const base = first || keywords || "Pin ideas";
  if (base.length <= LIMITS.title) return base;
  return clampText(base, LIMITS.title).text;
}

/* ----------------------------- preflight ----------------------------- */

/**
 * Единый preflight: валидирует, чистит тексты и строит строки, которые безопасно писать в CSV.
 * Даты: не раньше `now + 15 мин`; одинаковые времена разводятся с шагом 5 минут.
 * Строки с проблемами в `rows` не попадают — только в `issues`.
 */
export function preparePinterestExport(items: readonly ExportItem[], opts: PrepareOptions): PrepareResult {
  const tz = opts.tz;
  const stepMs = Math.max(1, opts.slotStepMinutes ?? 5) * 60_000;
  const minSafeMs = opts.now.getTime() + Math.max(0, opts.minLeadMinutes ?? 15) * 60_000;
  let nextFreeMs = minSafeMs;
  const usedSlots = new Set<string>();
  const rows: PinterestRow[] = [];
  const issues: PinterestIssue[] = [];
  const fixes: PinterestFix[] = [];

  const reserve = (fromMs: number): Date | null => {
    let ms = fromMs;
    for (let guard = 0; guard < 10_000; guard++) {
      const d = new Date(ms);
      const key = formatPinterestDate(d, tz);
      if (!usedSlots.has(key)) {
        usedSlots.add(key);
        return d;
      }
      ms += stepMs;
    }
    return null;
  };

  for (const it of items) {
    const problems: PinterestIssueReason[] = [];
    const fixed = new Set<PinterestFixCode>();

    const title = clampText(it.title, LIMITS.title);
    const description = clampText(it.description, LIMITS.description);
    const keywords = clampText(it.keywords ?? "", KEYWORDS_MAX);
    if (title.trimmed) fixed.add("title_trimmed");
    if (description.trimmed) fixed.add("description_trimmed");
    if (keywords.trimmed) fixed.add("keyword_trimmed");

    const mediaUrl = cleanUrl(it.imageUrl);
    const link = cleanUrl(it.link);
    const board = clampText(it.boardName, BOARD_MAX).text;

    if (!title.text && !description.text) problems.push("missing_title");
    if (!mediaUrl) problems.push("missing_media");
    else if (!isHttpUrl(mediaUrl)) problems.push("bad_media_url");
    if (!board) problems.push("missing_board");
    if (!description.text) problems.push("missing_description");
    if (!link) problems.push("missing_link");
    else if (!isHttpUrl(link)) problems.push("bad_link_url");

    let publishDate: Date | null = null;
    const ts = it.scheduledAt ? it.scheduledAt.getTime() : Number.NaN;
    if (!Number.isFinite(ts)) {
      problems.push("missing_schedule");
    } else {
      let desiredMs = ts;
      const moved = desiredMs < minSafeMs;
      if (moved) {
        desiredMs = Math.max(nextFreeMs, minSafeMs);
        fixed.add("date_moved_forward");
      }
      if (usedSlots.has(formatPinterestDate(new Date(desiredMs), tz))) fixed.add("duplicate_time_moved");
      publishDate = reserve(desiredMs);
      if (!publishDate) problems.push("no_free_slot");
      else if (moved) nextFreeMs = Math.max(nextFreeMs, publishDate.getTime() + stepMs);
    }

    for (const reason of problems) issues.push({ id: it.id, reason });
    if (problems.length || !publishDate) continue;

    let finalTitle = title.text;
    if (!finalTitle) {
      finalTitle = titleFromDescription(description.text, keywords.text);
      fixed.add("title_from_description");
    }
    for (const fix of fixed) fixes.push({ id: it.id, fix });

    rows.push({
      id: it.id,
      title: finalTitle,
      mediaUrl,
      board,
      thumbnail: "",
      description: description.text,
      link,
      publishDate,
      keywords: keywords.text,
    });
  }

  return { rows, issues, fixes };
}

/* ------------------------- уникальные заголовки ------------------------- */

const TITLE_SUFFIXES = ["Ideas", "Inspo", "Looks", "Inspiration", "Must-Try", "Favorites", "Picks", "Guide"];

/** Pinterest отклоняет файл со строками с одинаковым Title — добавляем суффиксы. */
export function dedupeTitles(rows: readonly PinterestRow[]): { rows: PinterestRow[]; renamed: number } {
  const seen = new Set<string>();
  let renamed = 0;
  const out = rows.map((row) => {
    const title = row.title.trim();
    let next = title;
    for (let n = 0; seen.has(next.toLowerCase()); n++) {
      const sfx = n < TITLE_SUFFIXES.length ? TITLE_SUFFIXES[n] : `Idea ${n - TITLE_SUFFIXES.length + 2}`;
      const room = LIMITS.title - sfx.length - 3;
      const base = title.length > room ? clampText(title, room).text : title;
      next = `${base} - ${sfx}`;
    }
    seen.add(next.toLowerCase());
    if (next === row.title) return row;
    renamed++;
    return { ...row, title: next };
  });
  return { rows: out, renamed };
}

/* ------------------------------- CSV ------------------------------- */

export function rowToCsvLine(row: PinterestRow, tz: string): string {
  return [
    row.title,
    row.mediaUrl,
    row.board,
    row.thumbnail ?? "",
    row.description,
    row.link,
    formatPinterestDate(row.publishDate, tz),
    row.keywords ?? "",
  ]
    .map(csvEscape)
    .join(",");
}

/** CSV по шаблону Pinterest (без BOM; при отдаче файла добавьте `﻿` в начало). */
export function buildPinterestCsv(rows: readonly PinterestRow[], tz: string = DEFAULT_TZ): string {
  return [PINTEREST_CSV_HEADERS.map(csvEscape).join(","), ...rows.map((r) => rowToCsvLine(r, tz))].join("\r\n");
}

/** Разбивка на файлы не больше `maxRows` строк (Pinterest принимает до 200). */
export function splitCsv(rows: readonly PinterestRow[], maxRows: number = PINTEREST_MAX_ROWS, tz: string = DEFAULT_TZ): string[] {
  const limit = Math.max(1, Math.floor(maxRows));
  const files: string[] = [];
  for (let i = 0; i < rows.length; i += limit) files.push(buildPinterestCsv(rows.slice(i, i + limit), tz));
  return files;
}

export function siteSlug(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
}

/** `DD_MM_YYYY_SiteName.csv`, для изменённого сегодняшнего файла — с префиксом `NEW_`. */
export function fileName(day: string, siteName: string, isNew = false): string {
  const { year, month, day: d } = keyParts(day);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${isNew ? "NEW_" : ""}${pad(d)}_${pad(month)}_${year}_${siteSlug(siteName)}.csv`;
}
