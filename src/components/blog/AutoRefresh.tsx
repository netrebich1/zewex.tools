"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { pollWhileVisible } from "@/lib/poll";

/** Перечитывает серверную страницу раз в `everyMs`, пока есть что обновлять (посты в работе / очереди). */
export function AutoRefresh({ everyMs = 15_000, enabled = true }: { everyMs?: number; enabled?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    return pollWhileVisible(() => router.refresh(), everyMs);
  }, [router, everyMs, enabled]);
  return null;
}
