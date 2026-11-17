"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { pollWhileVisible } from "@/lib/poll";

type State = { status: string; total: number; done: number; error: number; processing: number };

/** Пока прогон пишет посты: опрос раз в 5 с, при готовности новой статьи страница тихо обновляется. */
export function RunLive({ runId }: { runId: string }) {
  const router = useRouter();
  const [st, setSt] = useState<State | null>(null);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetch(`/api/social/runs/${runId}`, { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as State;
        setSt(j);
        const v = `${j.status}:${j.done}:${j.error}`;
        if (seen.current !== null && seen.current !== v) router.refresh();
        seen.current = v;
      } catch {
        /* сеть — следующий тик */
      }
    };
    void tick();
    return pollWhileVisible(tick, 5_000);
  }, [runId, router]);
  if (!st || (st.status !== "QUEUED" && st.status !== "RUNNING")) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[14px]">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
      <span className="font-medium">{st.status === "QUEUED" ? "Прогон в очереди" : "Пишем посты"}</span>
      <span className="text-muted">· готово {st.done} из {st.total}{st.error ? `, с ошибкой ${st.error}` : ""}</span>
      <span className="help ml-auto">страница обновится сама, вкладку можно закрыть</span>
    </div>
  );
}
