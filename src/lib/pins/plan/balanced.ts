/**
 * Сбалансированный выбор шаблонов за прогон и назначение набора странице.
 * Перенесено из pinPlanner.ts старого приложения; чистые функции, без Prisma.
 */

/** Минимум, что нужно знать о наборе пинов (PinSet) планировщику. */
export interface PinSetLike {
  id: string;
  name?: string;
  /** Тема набора; "" = общий набор для любых страниц. */
  topic: string;
  styleIds: string[];
}

/**
 * Счётчик использований шаблонов за прогон: каждый раз берём из наименее
 * использованных, внутри равных — случайно (по переданному ГПСЧ). За прогон все
 * шаблоны расходуются примерно поровну, внутри одной страницы не повторяются.
 */
export class BalancedPicker {
  private used = new Map<string, number>();

  constructor(private readonly rng: () => number) {}

  /** Учесть уже созданные пины (по одному на элемент), чтобы баланс не сбивался при дозаполнении. */
  seed(styleIds: Iterable<string>): void {
    for (const id of styleIds) if (id) this.used.set(id, this.count(id) + 1);
  }

  /** Учесть готовые счётчики «шаблон → сколько раз уже использован». */
  seedCounts(counts: ReadonlyMap<string, number> | undefined): void {
    if (!counts) return;
    for (const [id, n] of counts) if (id && n > 0) this.used.set(id, this.count(id) + n);
  }

  /** Сколько раз шаблон уже использован в прогоне. */
  count(styleId: string): number {
    return this.used.get(styleId) ?? 0;
  }

  /**
   * Выбирает до `k` уникальных шаблонов из пула (минус `exclude`) по балансу.
   * `familyOf` — необязательная «семья» шаблона: внутри страницы стараемся не брать
   * два шаблона одной семьи (одинаковая зона текста и т.п.).
   */
  pick(pool: readonly string[], k: number, exclude: Iterable<string> = [], familyOf?: (styleId: string) => string): string[] {
    const skip = new Set(exclude);
    const rest = [...new Set(pool)].filter((id) => id && !skip.has(id));
    const out: string[] = [];
    const families = new Set<string>();
    if (familyOf) for (const id of skip) families.add(familyOf(id));

    for (let i = 0; i < k && rest.length; i++) {
      const fresh = familyOf ? rest.filter((id) => !families.has(familyOf(id))) : rest;
      const tierPool = fresh.length ? fresh : rest;
      let best = Number.POSITIVE_INFINITY;
      for (const id of tierPool) best = Math.min(best, this.count(id));
      const tier = tierPool.filter((id) => this.count(id) === best);
      const chosen = tier[Math.floor(this.rng() * tier.length)];
      out.push(chosen);
      if (familyOf) families.add(familyOf(chosen));
      this.used.set(chosen, this.count(chosen) + 1);
      rest.splice(rest.indexOf(chosen), 1);
    }
    return out;
  }
}

/**
 * Назначает набор странице: сначала набор с той же темой, иначе набор без темы,
 * иначе любой; среди кандидатов выбирает случайно по `rng`. Пустой пул → null.
 */
export function pickSetForPage<T extends PinSetLike>(sets: readonly T[], page: { topic: string }, rng: () => number): T | null {
  if (!sets.length) return null;
  const topic = (page.topic || "").trim();
  const matching = topic ? sets.filter((s) => (s.topic || "").trim() === topic) : [];
  const generic = sets.filter((s) => !(s.topic || "").trim());
  const candidates = matching.length ? matching : generic.length ? generic : sets;
  return candidates[Math.floor(rng() * candidates.length)] ?? null;
}

/** Ключ исключения «тема|шаблон» — так же, как в PinStyleExclusion. */
export function exclusionKey(topic: string, styleId: string): string {
  return `${(topic || "").trim()}|${styleId}`;
}

/** Собирает Set ключей исключений из строк PinStyleExclusion (или любых {topic, styleId}). */
export function exclusionSet(rows: ReadonlyArray<{ topic: string; styleId: string }> | undefined): Set<string> {
  const out = new Set<string>();
  for (const r of rows ?? []) out.add(exclusionKey(r.topic, r.styleId));
  return out;
}
