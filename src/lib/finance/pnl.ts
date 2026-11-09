/** Строки отчёта P&L. Чистые данные — и для сервера, и для форм. Порядок = порядок строк в отчёте. */
export const PNL_LINES = [
  { key: "REVENUE", label: "Выручка", kind: "INCOME", help: "Доходы направлений" },
  { key: "COGS", label: "Прямые расходы", kind: "EXPENSE", help: "Без чего нет выручки: контент, ИИ, домены, фриланс" },
  { key: "OPEX", label: "Операционные расходы", kind: "EXPENSE", help: "Сервисы, серверы, реклама, общие траты" },
  { key: "TAX", label: "Налоги и комиссии", kind: "EXPENSE", help: "Налоги, комиссии банков и бирж" },
  { key: "OTHER", label: "Прочее", kind: "ANY", help: "Разовое и вне основной работы" },
] as const;
export type PnlLine = (typeof PNL_LINES)[number]["key"];
export const pnlLine = (k: string) => PNL_LINES.find((l) => l.key === k) ?? PNL_LINES[2];
export const isPnlLine = (k: string): k is PnlLine => PNL_LINES.some((l) => l.key === k);
