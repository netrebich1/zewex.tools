/**
 * Детерминированная случайность для планировщиков: один сид → один и тот же план.
 * Без зависимостей, чистые функции.
 */

/** FNV-1a хэш строки в 32-битное число (стабильный сид из id прогона и т.п.). */
export function hash32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** ГПСЧ mulberry32: возвращает функцию, выдающую числа в [0, 1) по сиду. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Перемешивание Фишера–Йетса уже готовым ГПСЧ (исходный массив не меняется). */
export function shuffleWith<T>(arr: readonly T[], rng: () => number): T[] {
  const r = [...arr];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = r[i];
    r[i] = r[j];
    r[j] = tmp;
  }
  return r;
}

/** Детерминированная перестановка массива по числовому сиду. */
export function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  return shuffleWith(arr, mulberry32(seed));
}

/** Целое из [lo, hi] по ГПСЧ (границы включительно; lo > hi — меняются местами). */
export function randIntWith(rng: () => number, lo: number, hi: number): number {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return a + Math.floor(rng() * (b - a + 1));
}
