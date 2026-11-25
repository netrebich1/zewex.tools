import { headers } from "next/headers";

/**
 * Simple in-memory rate limiter (single Node process behind nginx).
 * Counts attempts per bucket (e.g. "login:<ip>") within a sliding window.
 */
type Entry = { count: number; resetAt: number };
const store = new Map<string, Entry>();

function prune(now: number) {
  if (store.size < 5000) return;
  for (const [k, v] of store) if (v.resetAt <= now) store.delete(k);
}

/** Returns null when allowed, otherwise seconds until the bucket resets. */
export function hit(bucket: string, limit: number, windowSec: number): number | null {
  const now = Date.now();
  prune(now);
  const e = store.get(bucket);
  if (!e || e.resetAt <= now) {
    store.set(bucket, { count: 1, resetAt: now + windowSec * 1000 });
    return null;
  }
  e.count++;
  if (e.count > limit) return Math.ceil((e.resetAt - now) / 1000);
  return null;
}

export function clear(bucket: string) {
  store.delete(bucket);
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  const xff = h.get("x-forwarded-for");
  // nginx дописывает адрес клиента последним: первый элемент может подделать сам клиент.
  if (xff) { const parts = xff.split(",").map((s) => s.trim()).filter(Boolean); return parts[parts.length - 1] ?? "unknown"; }
  return "unknown";
}

export function tooMany(retryIn: number): string {
  const min = Math.max(1, Math.ceil(retryIn / 60));
  return `Слишком много попыток. Попробуйте через ${min} мин.`;
}
