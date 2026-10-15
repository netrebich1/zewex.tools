"use client";
import { useEffect, useState } from "react";
import { fmtInt } from "@/lib/analytics/format";

/** «Сейчас на сайте»: активные за последние 30 минут, обновляется раз в минуту. */
export function Realtime({ ids }: { ids: string[] }) {
  const [value, setValue] = useState<number | null>(null);
  useEffect(() => {
    if (!ids.length) return;
    const ctrl = new AbortController();
    const load = () => fetch(`/api/analytics/realtime?ids=${ids.join(",")}`, { signal: ctrl.signal }).then((r) => (r.ok ? r.json() : {})).then((m: Record<string, number | null>) => setValue(Object.values(m).reduce<number>((s, v) => s + (v ?? 0), 0))).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { clearInterval(t); ctrl.abort(); };
  }, [ids]);
  if (value == null) return null;
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px]">
      <i className={`inline-block h-2 w-2 rounded-full ${value ? "bg-ok animate-pulse" : "bg-muted/50"}`} />
      Сейчас на сайте <b className="tabular-nums">{fmtInt(value)}</b>
    </span>
  );
}
