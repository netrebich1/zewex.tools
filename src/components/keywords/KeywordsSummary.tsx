import type { KeywordSummary } from "@/lib/keywords/query";
import { VERDICTS } from "@/lib/keywords/types";

const fmt = (n: number) => n.toLocaleString("ru-RU");
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

const VERDICT_BAR: Record<string, string> = { easy: "bg-ok", medium: "bg-warn", hard: "bg-danger", commercial: "bg-danger/60", low_volume: "bg-muted/50" };

/** Карточки и два графика по текущей выборке: вердикты (статусные цвета + подпись) и корзины частотности (один оттенок). */
export function KeywordsSummary({ s }: { s: KeywordSummary }) {
  const easy = s.verdicts.easy ?? 0;
  const medium = s.verdicts.medium ?? 0;
  const tiles = [
    { label: "Ключей в выборке", value: fmt(s.total), hint: null },
    { label: "Выдача снята", value: fmt(s.withSerp), hint: `${pct(s.withSerp, s.total)}% выборки` },
    { label: "✅ Изи", value: fmt(easy), hint: `${pct(easy, s.withSerp)}% снятых` },
    { label: "🟡 Средний", value: fmt(medium), hint: `${pct(medium, s.withSerp)}% снятых` },
    { label: "Средняя оценка", value: s.avgScore != null ? String(s.avgScore) : "—", hint: "из 100, где посчитана" },
    { label: "Вход: новый / старый", value: `${s.avgNew ?? "—"} / ${s.avgOld ?? "—"}`, hint: "средние оценки входа блога" },
    { label: "Сменился вердикт", value: fmt(s.changed), hint: "с прошлого снимка выдачи" },
  ];
  const verdictRows = [...VERDICTS.map((v) => ({ key: v.key as string, label: v.label as string, count: s.verdicts[v.key] ?? 0 })), { key: "", label: "Нет выдачи", count: s.verdicts[""] ?? 0 }];
  const vMax = Math.max(1, ...verdictRows.map((r) => r.count));
  const bMax = Math.max(1, ...s.buckets.map((b) => b.count));
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7 mb-3">
        {tiles.map((t) => (
          <div key={t.label} className="kpi">
            <span className="text-[12.5px] font-semibold uppercase tracking-wider text-muted">{t.label}</span>
            <span className="text-[22px] font-bold leading-none tracking-tight tabular-nums">{t.value}</span>
            <span className="help min-h-[18px]">{t.hint}</span>
          </div>
        ))}
      </div>
      <details className="mb-4 group">
        <summary className="cursor-pointer list-none text-[13px] font-semibold text-muted hover:text-ink">Графики: вердикты и частотность <span className="inline-block transition group-open:rotate-180">▾</span></summary>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="text-[13px] font-bold mb-3">Вердикты</h3>
          <div className="space-y-1.5">
            {verdictRows.map((r) => (
              <div key={r.key || "none"} className="grid grid-cols-[110px_1fr_64px] sm:grid-cols-[150px_1fr_84px] items-center gap-3 text-[13px]" title={`${r.label}: ${fmt(r.count)} (${pct(r.count, s.total)}%)`}>
                <span className="truncate">{r.label}</span>
                <span className="h-3 rounded-r-[4px] bg-ink/5"><span className={`block h-full rounded-r-[4px] ${VERDICT_BAR[r.key] ?? "bg-ink/15"}`} style={{ width: `${(100 * r.count) / vMax}%` }} /></span>
                <span className="text-right tabular-nums font-semibold">{fmt(r.count)}<span className="text-muted font-normal"> · {pct(r.count, s.total)}%</span></span>
              </div>
            ))}
          </div>
        </div>
        <div className="card p-4">
          <h3 className="text-[13px] font-bold mb-3">Частотность, аудитория US/мес</h3>
          <div className="space-y-1.5">
            {s.buckets.map((b) => (
              <div key={b.label} className="grid grid-cols-[110px_1fr_64px] sm:grid-cols-[150px_1fr_84px] items-center gap-3 text-[13px]" title={`${b.label}: ${fmt(b.count)} (${pct(b.count, s.total)}%)`}>
                <span className="truncate">{b.label}</span>
                <span className="h-3 rounded-r-[4px] bg-ink/5"><span className="block h-full rounded-r-[4px] bg-[var(--viz-1)]" style={{ width: `${(100 * b.count) / bMax}%` }} /></span>
                <span className="text-right tabular-nums font-semibold">{fmt(b.count)}<span className="text-muted font-normal"> · {pct(b.count, s.total)}%</span></span>
              </div>
            ))}
          </div>
        </div>
      </div>
      </details>
    </>
  );
}
