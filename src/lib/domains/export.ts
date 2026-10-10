/**
 * Выгрузка подбора: XLSX (лист «Сводка» + лист на бренд) и CSV (всё одним списком).
 * Статистика считается только по доменам, попавшим в выгрузку.
 */
import { buildCsv, buildXlsx, type CellValue, type Sheet } from "@/lib/xlsx";
import { computeStats, formatCounts, NO_SUFFIX } from "./selection";
import type { RunDomainRow } from "./runs";
import type { DomainRunSettings } from "./types";

export type ExportScope = "selected" | "available" | "all";

const STATUS_RU: Record<string, string> = { available: "свободен", taken: "занят", unknown: "не проверен" };
const HEAD = ["Домен", "Бренд", "Зона", "Приставка", "Уровень", "Шаблон", "Статус", "Выбран", "Оценка ИИ", "Комментарий ИИ"];

function rowOf(d: RunDomainRow): CellValue[] {
  return [d.domain, d.brand, d.tld, d.suffix ?? "", d.tier || "", d.pattern, STATUS_RU[d.status] ?? d.status, d.selected ? "да" : "", d.aiScore ?? "", d.aiReason ?? ""];
}

function scoped(rows: RunDomainRow[], scope: ExportScope): RunDomainRow[] {
  if (scope === "selected") return rows.filter((r) => r.selected);
  if (scope === "available") return rows.filter((r) => r.status === "available");
  return rows;
}

function statRows(rows: RunDomainRow[]): CellValue[][] {
  const s = computeStats(rows);
  const line = (label: string, pairs: [string, number][]) => [label, formatCounts(pairs)];
  return [
    ["Выбрано", s.counts.selected, "Свободно", s.counts.available, "Занято", s.counts.taken, "Не проверено", s.counts.unknown],
    [],
    ["Зоны"],
    line("Выбрано", s.zones.selected),
    line("Свободно", s.zones.available),
    line("Не задействовано", s.zones.unused),
    [],
    ["Приставки"],
    line("Выбрано", s.suffixes.selected),
    line("Свободно", s.suffixes.available),
    line("Не задействовано", s.suffixes.unused),
  ];
}

export function fileBase(name: string): string {
  const safe = name.replace(/[^\p{L}\p{N}_ -]+/gu, "").trim().replace(/\s+/g, "_").slice(0, 60) || "domains";
  return `domains_${safe}`;
}

export function buildRunXlsx(run: { name: string; settings: DomainRunSettings }, rows: RunDomainRow[], scope: ExportScope): Buffer {
  const exported = scoped(rows, scope);
  const brands = run.settings.brands;
  const summary: CellValue[][] = [
    ["Подбор", run.name],
    ["Страна", run.settings.countryCode.toUpperCase()],
    ["Зоны", run.settings.tlds.join(", ")],
    ["Приставки, уровень 1", run.settings.suffixTiers[0].join(", ")],
    ["Приставки, уровень 2", run.settings.suffixTiers[1].join(", ")],
    ["Приставки, уровень 3", run.settings.suffixTiers[2].join(", ")],
    ["Доменов на бренд", run.settings.perBrand],
    ["Что выгружено", scope === "selected" ? "только выбранные" : scope === "available" ? "все свободные" : "все проверенные"],
    [],
    ...statRows(exported),
    [],
    ["Бренд", "Выбрано", "Свободно", "Занято", "Не проверено"],
    ...brands.map((b) => {
      const s = computeStats(exported.filter((r) => r.brand === b));
      return [b, s.counts.selected, s.counts.available, s.counts.taken, s.counts.unknown];
    }),
  ];
  const sheets: Sheet[] = [{ name: "Сводка", rows: summary, widths: [26, 60, 14, 12, 14], boldRows: [0, 12 + 9] }];
  for (const b of brands) {
    const list = exported.filter((r) => r.brand === b);
    if (!list.length) continue;
    const sel = list.filter((r) => r.selected);
    const free = list.filter((r) => r.status === "available" && !r.selected);
    const taken = list.filter((r) => r.status === "taken");
    const unknown = list.filter((r) => r.status === "unknown");
    const body: CellValue[][] = [HEAD];
    const bold: number[] = [0];
    const block = (title: string, items: RunDomainRow[]) => {
      if (!items.length) return;
      body.push([]);
      bold.push(body.length);
      body.push([title]);
      for (const d of items) body.push(rowOf(d));
    };
    if (sel.length) for (const d of sel) body.push(rowOf(d));
    block("Свободные, не выбранные", free);
    block("Занятые", taken);
    block("Не проверенные", unknown);
    body.push([]);
    bold.push(body.length);
    body.push(["Статистика по бренду"]);
    body.push(...statRows(list));
    sheets.push({ name: b, rows: body, widths: [34, 18, 8, 14, 9, 22, 12, 8, 10, 50], boldRows: bold });
  }
  return buildXlsx(sheets);
}

export function buildRunCsv(rows: RunDomainRow[], scope: ExportScope): string {
  const exported = scoped(rows, scope);
  const stats = statRows(exported);
  const out: CellValue[][] = [];
  const width = HEAD.length;
  // Статистика справа от таблицы (колонки после основной), как в старом сервисе
  const total = Math.max(exported.length + 1, stats.length);
  for (let i = 0; i < total; i++) {
    const left: CellValue[] = i === 0 ? HEAD : exported[i - 1] ? rowOf(exported[i - 1]!) : Array(width).fill("");
    const right = stats[i] ?? [];
    out.push([...left, "", ...right]);
  }
  return buildCsv(out);
}

export const NO_SUFFIX_LABEL = NO_SUFFIX;
