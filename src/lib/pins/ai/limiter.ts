/**
 * Семафор на ключ API: не больше N одновременных запросов одним ключом.
 *
 * Очередь честная: ожидающие группируются по владельцу (`owner`, обычно id прогона), слоты раздаются по кругу
 * между владельцами, а не в порядке прихода. Иначе один прогон, поставивший 15 запросов первым, забирает ключ
 * целиком, а остальные прогоны того же ключа ждут его конца.
 *
 * Пауза ключа (`pauseKey`): после ответа «rate limit» все новые запросы этим ключом ждут до конца паузы,
 * чтобы не жечь попытки пинов впустую. Пауза растёт с каждым подряд идущим лимитом (1 → 5 мин) и сбрасывается
 * первым успешным ответом (`keyOk`).
 */

type Waiter = { owner: string; resolve: () => void; signal?: AbortSignal; onAbort?: () => void };
type Slot = { active: number; queue: Waiter[]; rr: number; pausedUntil: number; rateHits: number };
const slots = new Map<string, Slot>();

export const DEFAULT_LIMITS = { IMAGE: 15, CHAT: 6 } as const;
/** Пауза ключа после «rate limit»: первая 60 с, дальше ×2, не больше 5 мин. */
export const PAUSE_FIRST_MS = 60_000;
export const PAUSE_MAX_MS = 5 * 60_000;

function slot(key: string): Slot {
  let s = slots.get(key);
  if (!s) {
    s = { active: 0, queue: [], rr: 0, pausedUntil: 0, rateHits: 0 };
    slots.set(key, s);
  }
  return s;
}

export type AcquireOptions = { owner?: string; signal?: AbortSignal };

function abortError(signal?: AbortSignal): Error {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Следующий ожидающий по кругу владельцев: первый в очереди у владельца, идущего после предыдущего. */
function takeNext(s: Slot): Waiter | undefined {
  if (!s.queue.length) return undefined;
  const owners: string[] = [];
  for (const w of s.queue) if (!owners.includes(w.owner)) owners.push(w.owner);
  const owner = owners[s.rr % owners.length];
  s.rr = (s.rr + 1) % owners.length;
  const idx = s.queue.findIndex((w) => w.owner === owner);
  const [w] = s.queue.splice(idx, 1);
  if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
  return w;
}

/** Освободившееся место отдать следующему ожидающему (он сам сделает `active++`). */
function grantNext(s: Slot): void {
  const w = takeNext(s);
  if (w) w.resolve();
}

export async function acquire(key: string, limit: number, opts: AcquireOptions = {}): Promise<() => void> {
  const s = slot(key);
  const owner = opts.owner ?? "";
  if (s.active >= limit || s.queue.length) {
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = { owner, resolve, signal: opts.signal };
      if (opts.signal) {
        const sig = opts.signal;
        w.onAbort = () => {
          const i = s.queue.indexOf(w);
          if (i >= 0) s.queue.splice(i, 1);
          reject(abortError(sig));
        };
        if (sig.aborted) return w.onAbort();
        sig.addEventListener("abort", w.onAbort, { once: true });
      }
      s.queue.push(w);
    });
  }
  // Место занято; паузу ключа пережидаем уже с ним, чтобы после паузы не вышло больше `limit` запросов разом.
  s.active++;
  try {
    while (s.pausedUntil > Date.now()) await sleep(Math.min(s.pausedUntil - Date.now(), 15_000), opts.signal);
  } catch (e) {
    s.active--;
    grantNext(s);
    throw e;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.active--;
    grantNext(s);
  };
}

/** Провайдер ответил «rate limit»: поставить ключ на паузу. Возвращает длину паузы в мс. */
export function pauseKey(key: string): number {
  const s = slot(key);
  s.rateHits++;
  const ms = Math.min(PAUSE_MAX_MS, PAUSE_FIRST_MS * 2 ** (s.rateHits - 1));
  s.pausedUntil = Math.max(s.pausedUntil, Date.now() + ms);
  return ms;
}

/** Успешный ответ ключом: серия лимитов прервана. */
export function keyOk(key: string): void {
  const s = slots.get(key);
  if (s) s.rateHits = 0;
}

/** До конца паузы ключа, мс (0 — паузы нет). */
export function keyPausedFor(key: string): number {
  const s = slots.get(key);
  return s ? Math.max(0, s.pausedUntil - Date.now()) : 0;
}

export function limiterStats(): Record<string, { active: number; waiting: number; pausedMs: number }> {
  const out: Record<string, { active: number; waiting: number; pausedMs: number }> = {};
  for (const [k, v] of slots) out[k] = { active: v.active, waiting: v.queue.length, pausedMs: Math.max(0, v.pausedUntil - Date.now()) };
  return out;
}
