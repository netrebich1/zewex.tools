"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Перечитывает серверную страницу раз в `everyMs`, пока есть что обновлять (посты в работе / очереди). */
export function AutoRefresh({ everyMs = 15_000, enabled = true }: { everyMs?: number; enabled?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs, enabled]);
  return null;
}
