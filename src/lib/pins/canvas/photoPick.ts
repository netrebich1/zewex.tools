/**
 * Выбор фото статьи для её Canvas-пинов (чистые функции, без сети).
 * Кандидаты берутся равномерно по всей статье; модель оценивает их (assessPhoto), на пины идут лучшие:
 * без «плохих» флагов, без повторов между пинами статьи, внутри пина — не соседние кадры статьи.
 */

/** Сколько фото оценивать на статью: нужно её Canvas-пинам + 2 запасных, но не меньше 6 и не больше 10 (и не больше запаса). */
export function candidateCount(needed: number, pool: number): number {
  return Math.max(0, Math.min(pool, Math.max(6, Math.min(10, needed + 2))));
}

/** K индексов равномерно по списку длины n (первое и последнее фото включены). */
export function spreadIndices(n: number, k: number): number[] {
  if (n <= 0 || k <= 0) return [];
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let j = 0; j < k; j++) out.add(Math.round((j * (n - 1)) / (k - 1)));
  return [...out];
}

export type PickCandidate = { url: string; index: number; score: number; bad: boolean };

/**
 * Раздаёт фото пинам статьи. `needs` — сколько фото у каждого пина (в порядке пинов).
 * Порядок: хорошие (без плохих флагов) по убыванию оценки, затем плохие. Каждый пин берёт лучшие ещё не
 * использованные фото, избегая соседних по статье кадров; когда уникальные кончились — берёт наименее использованные.
 */
export function assignPhotos(cands: PickCandidate[], needs: number[]): string[][] {
  const ranked = [...cands].sort((a, b) => Number(a.bad) - Number(b.bad) || b.score - a.score || a.index - b.index);
  // Плохие берём, только если без них не хватает на все пины.
  const total = needs.reduce((s, n) => s + n, 0);
  const good = ranked.filter((c) => !c.bad);
  const pool = good.length >= Math.min(total, ranked.length) ? good : ranked;
  const uses = new Map<string, number>();
  return needs.map((n) => {
    const pick: PickCandidate[] = [];
    const fresh = pool.filter((c) => !uses.has(c.url));
    for (const c of fresh) {
      if (pick.length >= n) break;
      if (pick.some((p) => Math.abs(p.index - c.index) <= 1) && fresh.length - pick.length > n - pick.length) continue;
      pick.push(c);
    }
    for (const c of fresh) { if (pick.length >= n) break; if (!pick.includes(c)) pick.push(c); }
    // Уникальных не хватило — повторяем наименее использованные лучшие фото.
    if (pick.length < n) {
      const reuse = pool.filter((c) => !pick.includes(c)).sort((a, b) => (uses.get(a.url) ?? 0) - (uses.get(b.url) ?? 0));
      for (const c of reuse) { if (pick.length >= n) break; pick.push(c); }
    }
    for (const c of pick) uses.set(c.url, (uses.get(c.url) ?? 0) + 1);
    return pick.map((c) => c.url);
  });
}
