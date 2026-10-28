"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { pollWhileVisible } from "@/lib/poll";

type State = { active: { status: string; step: string | null; kind: string; startedAt: string | null; fetched: number; fresh: number; classified: number } | null; version: string };

/** Живая лента: опрос раз в 15 с, при новом прогоне или изменении кластеров — тихое обновление страницы. */
export function LiveRefresh({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [st, setSt] = useState<State | null>(null);
  const version = useRef<string | null>(null);
  useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetch(`/api/news/state?project=${projectId}`, { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as State;
        setSt(j);
        if (version.current !== null && version.current !== j.version) router.refresh();
        version.current = j.version;
      } catch {
        /* сеть — следующий тик */
      }
    };
    void tick();
    return pollWhileVisible(tick, 15_000);
  }, [projectId, router]);
  if (!st?.active) return null;
  const a = st.active;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[14px]">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
      <span className="font-medium">{a.status === "queued" ? "Прогон в очереди" : `Идёт ${a.kind === "manual" ? "ручной" : "плановый"} прогон`}</span>
      {a.step && <span className="text-muted">· шаг: {a.step}</span>}
      {a.status === "running" && <span className="text-muted">· собрано {a.fetched}, новых {a.fresh}, классифицировано {a.classified}</span>}
      <span className="help ml-auto">карточки обновятся сами</span>
    </div>
  );
}
