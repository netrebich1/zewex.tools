import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Card, Empty, PageHeader, type SearchParams, sp } from "@/components/ui";
import { moderationBatch, moderationCounts } from "@/lib/pins/runs/moderation";
import { ModerationGrid } from "@/components/pins/ModerationGrid";
import { ENGINE_LABELS } from "@/components/pins/labels";

export const dynamic = "force-dynamic";

export default async function ModerationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const siteId = sp(params, "site");
  const runId = sp(params, "run");
  const engine = sp(params, "engine");
  const [counts, first] = await Promise.all([moderationCounts(me), moderationBatch(me, { siteId, runId, engine, limit: 60 })]);
  const qs = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const all = { site: siteId, run: runId, engine, ...patch };
    for (const [k, v] of Object.entries(all)) if (v) u.set(k, v);
    const s = u.toString();
    return `/pinterest/pins/moderation${s ? `?${s}` : ""}`;
  };
  const visibleRuns = counts.runs.filter((r) => !siteId || r.siteId === siteId);

  return (
    <>
      <PageHeader title="Модерация" subtitle={`Непроверенных пинов: ${counts.total}. Клик по пину помечает его на отклонение, остальные одобряются кнопкой внизу.`} />
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap gap-2 items-center">
            <Link href={qs({ site: undefined, run: undefined })} className={`badge px-3 py-1 ${!siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все сайты · {counts.total}</Link>
            {counts.sites.map((s) => (
              <Link key={s.siteId} href={qs({ site: s.siteId, run: undefined })} className={`badge px-3 py-1 ${siteId === s.siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{s.siteName || "без сайта"} · {s.total}</Link>
            ))}
          </div>
          {visibleRuns.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2 items-center">
              <Link href={qs({ run: undefined })} className={`badge px-3 py-1 ${!runId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все прогоны</Link>
              {visibleRuns.map((r) => (
                <Link key={r.runId} href={qs({ run: r.runId })} className={`badge px-3 py-1 ${runId === r.runId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{r.name} · {r.total}</Link>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            <Link href={qs({ engine: undefined })} className={`badge px-3 py-1 ${!engine ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все типы</Link>
            {["OPENAI", "PINORA", "PHOTO", "CANVAS"].map((e) => (
              <Link key={e} href={qs({ engine: e })} className={`badge px-3 py-1 ${engine === e ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{ENGINE_LABELS[e]}</Link>
            ))}
          </div>
        </Card>
        {first.items.length === 0 ? (
          <Empty title="Всё проверено" hint="Непроверенных пинов по этому фильтру нет." />
        ) : (
          <ModerationGrid initial={first} filter={{ siteId, runId, engine }} />
        )}
      </div>
    </>
  );
}
