/** Балансировка выбора и статистика по зонам и приставкам. Чистые функции, работают и на клиенте. */

export type SelectableDomain = {
  domain: string;
  tld: string;
  suffix: string | null;
  status: string;
  score?: number | null;
};

export const NO_SUFFIX = "без приставки";

export function countBy<T>(items: T[], key: (item: T) => string): [string, number][] {
  const map = new Map<string, number>();
  for (const i of items) {
    const k = key(i);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export const byTld = (d: SelectableDomain) => d.tld || "—";
export const bySuffix = (d: SelectableDomain) => d.suffix || NO_SUFFIX;

export function formatCounts(pairs: [string, number][]): string {
  if (pairs.length === 0) return "—";
  return pairs.map(([k, n]) => `${k} · ${n}`).join(", ");
}

/**
 * Отбирает n доменов, выравнивая их по зонам и/или приставкам: лимит на одно значение растёт 1, 2, 3…,
 * на каждом шаге кандидаты проходятся по убыванию score. Обе галочки выключены — строго первые n.
 */
export function balancePicks<T extends SelectableDomain>(candidates: T[], n: number, opts: { zones: boolean; suffixes: boolean }): T[] {
  if (n <= 0) return [];
  if (!opts.zones && !opts.suffixes) return candidates.slice(0, n);
  const picked: T[] = [];
  const taken = new Set<string>();
  const zoneCount = new Map<string, number>();
  const suffixCount = new Map<string, number>();
  const fits = (d: T, cap: number) => {
    if (opts.zones && (zoneCount.get(byTld(d)) ?? 0) >= cap) return false;
    if (opts.suffixes && (suffixCount.get(bySuffix(d)) ?? 0) >= cap) return false;
    return true;
  };
  for (let cap = 1; picked.length < n && cap <= n; cap++) {
    for (const d of candidates) {
      if (picked.length >= n) break;
      if (taken.has(d.domain) || !fits(d, cap)) continue;
      picked.push(d);
      taken.add(d.domain);
      zoneCount.set(byTld(d), (zoneCount.get(byTld(d)) ?? 0) + 1);
      suffixCount.set(bySuffix(d), (suffixCount.get(bySuffix(d)) ?? 0) + 1);
    }
  }
  return picked;
}

export type StatBlock = { selected: [string, number][]; available: [string, number][]; unused: [string, number][] };
export type Stats = { zones: StatBlock; suffixes: StatBlock; counts: { selected: number; available: number; taken: number; unknown: number; total: number } };

/** Выбрано / свободно / не задействовано по зонам и приставкам для набора доменов (бренда или всего подбора). */
export function computeStats<T extends SelectableDomain & { selected: boolean }>(rows: T[]): Stats {
  const available = rows.filter((r) => r.status === "available");
  const selected = rows.filter((r) => r.selected);
  const unused = available.filter((r) => !r.selected);
  const block = (key: (d: SelectableDomain) => string): StatBlock => ({ selected: countBy(selected, key), available: countBy(available, key), unused: countBy(unused, key) });
  return {
    zones: block(byTld),
    suffixes: block(bySuffix),
    counts: {
      selected: selected.length,
      available: available.length,
      taken: rows.filter((r) => r.status === "taken").length,
      unknown: rows.filter((r) => r.status === "unknown").length,
      total: rows.length,
    },
  };
}
