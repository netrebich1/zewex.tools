/** Семафор на ключ API: не больше N одновременных запросов одним ключом. */

type Waiter = () => void;
const slots = new Map<string, { active: number; queue: Waiter[] }>();

export const DEFAULT_LIMITS = { IMAGE: 15, CHAT: 6 } as const;

export async function acquire(key: string, limit: number): Promise<() => void> {
  let s = slots.get(key);
  if (!s) {
    s = { active: 0, queue: [] };
    slots.set(key, s);
  }
  if (s.active < limit) {
    s.active++;
  } else {
    await new Promise<void>((resolve) => s!.queue.push(resolve));
    s.active++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s!.active--;
    const next = s!.queue.shift();
    if (next) next();
  };
}

export function limiterStats(): Record<string, { active: number; waiting: number }> {
  const out: Record<string, { active: number; waiting: number }> = {};
  for (const [k, v] of slots) out[k] = { active: v.active, waiting: v.queue.length };
  return out;
}
