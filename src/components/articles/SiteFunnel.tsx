import Link from "next/link";
import { FUNNEL_COLUMNS, type FunnelCounts } from "@/lib/articles/queries";

const toneCls: Record<string, string> = {
  muted: "bg-ink/5 text-ink-2", info: "bg-info-soft text-info", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", danger: "bg-danger-soft text-danger",
};

/** Фильтр очереди для колонки воронки (значения — STATUS_FILTER_GROUPS в queries.ts). */
function filterFor(key: string): string {
  switch (key) {
    case "pending": return "PENDING";
    case "photos": case "writing": return "RUNNING";
    case "photoReview": return "PHOTO_REVIEW";
    case "fewPhotos": return "fewPhotos";
    case "articleReview": return "REVIEW_PENDING";
    case "publishing": return "publishing";
    case "errors": return "errors";
    default: return "COMPLETED";
  }
}

/**
 * Воронка статусов сайта: цепочка ячеек «в очереди → фото → модерация фото → мало фото → пишутся → модерация статьи →
 * публикуются → ошибки → опубликовано за 24 ч». Нули приглушены; клик ведёт в очередь сайта с нужным фильтром.
 */
export function SiteFunnel({ siteId, f, compact = false }: { siteId: string; f: FunnelCounts; compact?: boolean }) {
  return (
    <ol className={`flex flex-wrap items-center ${compact ? "gap-1" : "gap-1.5"}`}>
      {FUNNEL_COLUMNS.map((c, i) => {
        const n = c.key === "published24h" ? f.published24h : f[c.key];
        const cls = n > 0 ? toneCls[c.tone] : "bg-transparent text-muted/60 border border-dashed border-line";
        return (
          <li key={c.key} className="flex items-center gap-1">
            <Link href={`/pinterest/articles/sites/${siteId}?tab=queue&status=${filterFor(c.key)}`} title={c.label} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] leading-none transition hover:ring-2 hover:ring-brand/30 ${cls}`}>
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

/**
 * Подпись-легенда воронки (один раз над таблицей). <span>, а не <p>: её кладут в `Card description`, который сам <p>,
 * а <p> внутри <p> браузер разбирает иначе, чем React, — ошибка гидратации (React 418) на обзоре статей.
 */
export function FunnelLegend() {
  return (
    <span className="help">
      Воронка: {FUNNEL_COLUMNS.map((c) => c.label.toLowerCase()).join(" → ")}. Нажмите на число, чтобы открыть эти статьи в очереди сайта.
    </span>
  );
}
