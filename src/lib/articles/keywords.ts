/**
 * Разбор списка ключей для запуска статей (без зависимостей от базы — используется и в браузере, и на сервере).
 * Строка: `keyword | seo | focus | count` (разделитель — «|», табуляция или «;»). CSV с запятыми принимается,
 * если в строке нет других разделителей. Пустые строки и строки, начинающиеся с «#», пропускаются.
 */
import type { KeywordInput } from "./types";
import { sanitizeTopic } from "./text/textGuards";

export type ParsedKeyword = KeywordInput & { line: number; raw: string; error?: string };

/** Очистка темы от служебных пометок — общий модуль text/textGuards (порт оригинала), чтобы UI и воркер чистили одинаково. */
export { sanitizeTopic };

function splitLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t");
  if (line.includes("|")) return line.split("|");
  if (line.includes(";")) return line.split(";");
  // CSV через запятую: только если похоже на таблицу (последняя колонка — число или ровно 2–4 колонки без пробелов после запятой не требуем)
  if (line.includes(",")) {
    const parts = line.split(",");
    const last = parts[parts.length - 1].trim();
    if (parts.length <= 4 && (/^\d+$/.test(last) || parts.length >= 3)) return parts;
  }
  return [line];
}

export function parseKeywordLines(text: string): ParsedKeyword[] {
  const out: ParsedKeyword[] = [];
  const lines = (text ?? "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const cols = splitLine(line).map((c) => c.trim());
    // Заголовок таблицы (keyword | seo | focus | count) пропускаем
    if (i === 0 && /^(keyword|ключ)/i.test(cols[0]) && cols.length > 1) return;
    const keyword = sanitizeTopic(cols[0] ?? "");
    const row: ParsedKeyword = { line: i + 1, raw, keyword };
    if (cols[1]) row.seoKeyword = cols[1];
    if (cols[2]) row.focusKeyword = cols[2];
    if (cols[3]) {
      const n = Number(cols[3].replace(/[^\d]/g, ""));
      if (Number.isFinite(n) && n >= 1 && n <= 60) row.photoCount = n;
      else row.error = `Количество фото «${cols[3]}» не похоже на число 1–60`;
    }
    if (!keyword) row.error = "Пустой ключ";
    else if (keyword.length < 3) row.error = "Ключ слишком короткий";
    else if (keyword.length > 180) row.error = "Ключ длиннее 180 символов";
    out.push(row);
  });
  return out;
}

/** Дубликаты внутри самого списка (без учёта регистра): возвращает ключи, встретившиеся повторно. */
export function innerDuplicates(rows: Array<{ keyword: string }>): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of rows) {
    const k = r.keyword.toLowerCase();
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return dup;
}

/**
 * Инфо-ключ: человек ищет действия и советы, а не варианты для выбора (аудит woman-trend 2026-10-22: «Classy Hair Care
 * Routine 2027» стала подборкой стрижек). Для фото-подборки такой ключ не берём — его пишет сервис инфо-статей (блог).
 * Возвращает причину пропуска или null.
 */
const INFO_INTENT_RE = /\b(?:routines?|tips?|how to|ways to|benefits?|mistakes?|guide|remed(?:y|ies)|treatments?|tutorials?|step[- ]by[- ]step|hacks?|(?:hair|skin|nail|scalp|body|beard) ?care|regimen|checklist)\b/i;
export function infoIntent(keyword: string): string | null {
  const m = String(keyword || "").match(INFO_INTENT_RE);
  return m ? `инфо-ключ («${m[0].toLowerCase()}»): это не подборка образов — пишется в формате инфо-статьи` : null;
}
