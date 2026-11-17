import Link from "next/link";
import { FUNNEL_COLUMNS, type FunnelCounts } from "@/lib/blog/queries";

const toneCls: Record<string, string> = {
  muted: "bg-ink/5 text-ink-2", info: "bg-info-soft text-info", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", danger: "bg-danger-soft text-danger",
};

/** Воронка статусов сайта: очередь → в работе → на проверке → публикуются → ошибки → опубликовано за 24 ч. */
export function SiteFunnel({ siteId, f, compact = false }: { siteId: string; f: FunnelCounts; compact?: boolean }) {
  return (
    <ol className={`flex flex-wrap items-center ${compact ? "gap-1" : "gap-1.5"}`}>
      {FUNNEL_COLUMNS.map((c, i) => {
        const n = c.key === "published24h" ? f.published24h : f[c.key];
        const cls = n > 0 ? toneCls[c.tone] : "bg-transparent text-muted/60 border border-dashed border-line";
        return (
          <li key={c.key} className="flex items-center gap-1">
            <Link href={`/pinterest/blog/sites/${siteId}?tab=queue&status=${c.filter}`} title={c.label} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] leading-none transition hover:ring-2 hover:ring-brand/30 ${cls}`}>
              <span className="font-semibold tabular-nums">{n}</span>
              {!compact && <span className="hidden lg:inline opacity-80">{c.short}</span>}
            </Link>
            {i < FUNNEL_COLUMNS.length - 1 && <span className="text-line-2 text-[10px]">›</span>}
          </li>
        );
      })}
    </ol>
  );
}
