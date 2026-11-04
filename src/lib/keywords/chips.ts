/**
 * Плашки активных фильтров экрана ключей: подпись, что снять (patch для адреса) и предупреждение о невозможном значении.
 * Общий код для сервера (считает «сколько станет без этого фильтра») и для клиента (рисует плашки). Чистые данные.
 */
import { FIELDS, filterSpec } from "./fields";
import { flagLabel, nicheLabel, seasonLabel, sourceLabel, statusLabel, verdictLabel } from "./types";

export type FilterChip = { id: string; label: string; patch: Record<string, string | null>; warn?: string };

const LIST_LABEL: Record<string, (v: string, acc: Map<string, string>) => string> = {
  verdict: (v) => verdictLabel(v), niche: (v) => nicheLabel(v), season: (v) => seasonLabel(v), status: (v) => statusLabel(v),
  source: (v) => sourceLabel(v), acc: (v, a) => a.get(v) ?? v, prev: (v) => `было: ${verdictLabel(v)}`, flag: (v) => flagLabel(v), noflag: (v) => `без ${flagLabel(v)}`,
};
const LIST_TITLE: Record<string, string> = { verdict: "Вердикт", niche: "Ниша", season: "Сезонность", status: "Статус", source: "Источник", acc: "Аккаунт", prev: "Прошлый вердикт", flag: "Флаг", noflag: "Без флага" };

export function buildChips(get: (k: string) => string | null | undefined, accounts: Map<string, string>): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const k of Object.keys(LIST_LABEL)) {
    const vals = (get(k) ?? "").split(",").filter(Boolean);
    for (const v of vals) chips.push({ id: `${k}:${v}`, label: `${LIST_TITLE[k]}: ${LIST_LABEL[k](v, accounts)}`, patch: { [k]: vals.filter((x) => x !== v).join(",") || null } });
  }
  if (get("q")) chips.push({ id: "q", label: `Содержит «${get("q")}»`, patch: { q: null } });
  if (get("qx")) chips.push({ id: "qx", label: `Без слов: ${get("qx")}`, patch: { qx: null } });
  if (get("changed") === "1") chips.push({ id: "changed", label: "Сменился вердикт", patch: { changed: null } });
  const data = get("data");
  if (data) chips.push({ id: "data", label: ({ serp: "Выдача снята", noserp: "Выдача не снята", novol: "Нет частотности" } as Record<string, string>)[data] ?? data, patch: { data: null } });
  const mode = get("fu") === "cnt" ? "cnt" : "pct";
  for (const f of FIELDS) {
    const lo = get(`${f.key}_min`), hi = get(`${f.key}_max`);
    if (lo == null && hi == null) continue;
    const spec = filterSpec(f, mode);
    const u = spec.unit === "%" ? "%" : spec.unit ? ` ${spec.unit}` : "";
    const name = f.short ?? f.label;
    let label = lo != null && hi != null ? `${name}: ${lo}–${hi}${u}` : lo != null ? `${name} ≥ ${lo}${u}` : `${name} ≤ ${hi}${u}`;
    if (f.key === "volume" && lo === "0" && hi == null) label = "Частотность: все";
    let warn: string | undefined;
    if (spec.max != null && lo != null && Number(lo) > spec.max) warn = `${f.label}: бывает не больше ${spec.max}${u} — под «≥ ${lo}» не подходит ни один ключ`;
    else if (lo != null && hi != null && Number(lo) > Number(hi)) warn = "«от» больше «до» — под фильтр не подходит ни один ключ";
    chips.push({ id: f.key, label, patch: { [`${f.key}_min`]: null, [`${f.key}_max`]: null }, warn });
  }
  return chips;
}
