/**
 * Рекомендованные к покупке домены бренда: из свободных берём набор, который покрывает как можно больше разных тестов —
 * разные зоны, разные типы приставок (гео / ключи / ваши / запас / чистый бренд), разные приставки, с дефисом и без.
 * Жадный выбор: на каждом шаге — домен с наибольшей «новизной» плюс качество (уровень, оценка ИИ, длина).
 * «Бренд + буква» берётся только если без него не набирается нужное число.
 */
type Row = { id: string; domain: string; tld: string; suffix: string | null; tier: number; pattern: string; status: string; aiScore: number | null };

export type Recommendation = { id: string; reason: string };

const TIER_QUALITY = [3, 2.5, 2, 1.5, 0.8, 0.6, 0.4];

const KIND_LABELS: Record<string, string> = { none: "чистый бренд", geo: "гео", brand: "ключ", common: "ваша приставка", pool: "запас" };

export function recommendDomains<T extends Row>(rows: T[], n: number, kindOf: (d: T) => string): Recommendation[] {
  const free = rows.filter((d) => d.status === "available");
  const main = free.filter((d) => d.pattern !== "brand-letter");
  // «Бренд + буква» — только добор, если основных не хватает
  const pool = main.length >= n ? main : [...main, ...free.filter((d) => d.pattern === "brand-letter")];
  const zones = new Map<string, number>();
  const kinds = new Map<string, number>();
  const suffixes = new Set<string>();
  const shapes = new Map<string, number>();
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const picked: Recommendation[] = [];
  const taken = new Set<string>();
  // Короткая не-гео приставка (no, de) — обрывок фразы, в покупку не годится
  const quality = (d: T) => (TIER_QUALITY[d.tier] ?? 0.3) + (d.aiScore ?? 0) / 25 - d.domain.length / 40 - (d.pattern === "brand-letter" ? 3 : 0) - (d.suffix && d.suffix.length <= 2 && kindOf(d) !== "geo" ? 4 : 0);
  const shapeOf = (d: T) => (d.domain.includes("-") ? "дефис" : "слитно");
  while (picked.length < n) {
    let best: T | null = null;
    let bestScore = -Infinity;
    for (const d of pool) {
      if (taken.has(d.id)) continue;
      const suffix = d.suffix ?? "";
      // Новизна: новая зона/тип/форма — бонус, уже частая — штраф по числу повторов (набор ровно распределяется)
      const score =
        quality(d) +
        (zones.has(d.tld) ? -1.2 * zones.get(d.tld)! : 3) +
        (kinds.has(kindOf(d)) ? -1 * kinds.get(kindOf(d))! : 3) +
        (suffixes.has(suffix) ? -2 : 2) +
        (shapes.has(shapeOf(d)) ? -0.4 * shapes.get(shapeOf(d))! : 1);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    if (!best) break;
    const why: string[] = [];
    if (!zones.has(best.tld)) why.push(`зона .${best.tld}`);
    if (!kinds.has(kindOf(best))) why.push(KIND_LABELS[kindOf(best)] ?? kindOf(best));
    if (best.suffix && !suffixes.has(best.suffix)) why.push(`приставка ${best.suffix}`);
    if (!shapes.has(shapeOf(best))) why.push(shapeOf(best));
    taken.add(best.id);
    inc(zones, best.tld);
    inc(kinds, kindOf(best));
    suffixes.add(best.suffix ?? "");
    inc(shapes, shapeOf(best));
    picked.push({ id: best.id, reason: why.length ? `новое в наборе: ${why.join(", ")}` : "лучший из оставшихся" });
  }
  return picked;
}
