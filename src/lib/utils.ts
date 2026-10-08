export function slugify(input: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
    н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "i", є: "e", ґ: "g",
  };
  return input
    .toLowerCase()
    .split("")
    .map((c) => map[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";
}

export function fmtMoney(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v < 0.01 && v > 0) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

export function monthStart(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export const CAPABILITY_LABELS: Record<string, string> = {
  CHAT: "Текст / чат",
  IMAGE: "Генерация картинок",
  EMBEDDING: "Эмбеддинги",
  SERP: "Выдача поиска (SERP)",
  SEO_DATA: "SEO-данные",
};

export const SCOPE_LABELS: Record<string, string> = {
  USER_PROJECT: "Личная (пользователь + проект)",
  TEAM_PROJECT: "Команда + проект",
  PROJECT: "Проект по умолчанию",
  TEAM: "Команда по умолчанию",
  GLOBAL: "Глобально",
};

export const STATUS_LABELS: Record<string, string> = {
  PLANNED: "Планируется",
  MIGRATING: "Переносится",
  ACTIVE: "Работает",
  PAUSED: "Пауза",
};

export class ActionError extends Error {}

export function parseNumber(v: FormDataEntryValue | null): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
