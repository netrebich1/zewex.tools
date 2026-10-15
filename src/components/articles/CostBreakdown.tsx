/**
 * Виджеты расходов сервиса «Статьи» (серверные, без состояния): полоса фаз с легендой и KPI,
 * матрица «строка × фаза» (сайты, запуски, дни) и таблица расходов по статьям.
 * Данные — из src/lib/articles/costs.ts (costBreakdown). Показывать только при seesTeamCosts(me).
 */
import Link from "next/link";
import { Badge } from "@/components/ui";
import { badgeTone } from "@/components/articles/StatusBadge";
import { COST_PHASES, activePhases, type CostBreakdown, type CostPhase, type PhaseSums } from "@/lib/articles/costs";
import { STATUS_LABELS } from "@/lib/articles/labels";
import { fmtMoney } from "@/lib/utils";

const PHASE_COLOR: Record<CostPhase, string> = {
  search: "bg-info",
  rate: "bg-info/50",
  ai_moderation: "bg-brand",
  images: "bg-warn/60",
  text: "bg-ok",
  publish: "bg-ink-2",
  other: "bg-muted/50",
};

const money = (v: number) => (v > 0 ? fmtMoney(v) : "—");

/** Полоса фаз + легенда с суммами и долями. */
export function PhaseBar({ phases, total }: { phases: PhaseSums; total: number }) {
  const keys = activePhases(phases);
  if (!total || !keys.length) return <p className="help">Расходов нет.</p>;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-ink/5">
        {keys.map((k) => <div key={k} className={PHASE_COLOR[k]} style={{ width: `${(phases[k] / total) * 100}%` }} title={`${COST_PHASES.find((p) => p.key === k)?.label}: ${fmtMoney(phases[k])}`} />)}
      </div>
      <ul className="mt-3 grid gap-x-6 gap-y-1.5 text-[14px] sm:grid-cols-2 lg:grid-cols-3">
        {COST_PHASES.filter((p) => keys.includes(p.key)).map((p) => (
          <li key={p.key} className="flex items-center gap-2" title={p.hint}>
            <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${PHASE_COLOR[p.key]}`} />
            <span className="text-muted">{p.label}</span>
            <span className="ml-auto tabular-nums font-medium">{fmtMoney(phases[p.key])}</span>
            <span className="w-10 text-right tabular-nums help">{Math.round((phases[p.key] / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** KPI и полоса фаз для запуска/сайта/периода. */
export function CostSummary({ c, periodNote }: { c: CostBreakdown; periodNote?: string }) {
  const pub = c.outcome.published;
  const lost = c.outcome.wasted;
  const open = c.outcome.open;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <div className="kpi"><span className="help">Всего{periodNote ? ` ${periodNote}` : ""}</span><span className="kpi-value tabular-nums">{fmtMoney(c.total)}</span><span className="help">{c.calls} платных вызовов</span></div>
        <div className="kpi" title="Средний расход самой опубликованной статьи (её собственные вызовы)"><span className="help">Одна опубликованная</span><span className="kpi-value tabular-nums">{c.avgPublished == null ? "—" : fmtMoney(c.avgPublished)}</span><span className="help">опубликовано {pub.articles} · {fmtMoney(pub.cost)}</span></div>
        <div className="kpi" title="Весь расход (вместе с потерянными и незаконченными) делённый на число опубликованных"><span className="help">Полная цена публикации</span><span className="kpi-value tabular-nums">{c.fullPerPublished == null ? "—" : fmtMoney(c.fullPerPublished)}</span><span className="help">с учётом потерь</span></div>
        <div className="kpi" title="Статьи в статусе «Ошибка», «Ошибка публикации» или «Остановлена»: деньги потрачены, статьи нет"><span className="help">Потеряно впустую</span><span className={`kpi-value tabular-nums ${lost.cost > 0 ? "text-danger" : ""}`}>{fmtMoney(lost.cost)}</span><span className="help">{lost.articles} статей с ошибкой/остановлено · в работе {open.articles} · {fmtMoney(open.cost)}</span></div>
      </div>
      <PhaseBar phases={c.phases} total={c.total} />
      {c.check.articleCostSum != null && (
        <p className="help">
          Сверка: сумма по фазам {fmtMoney(c.total)} {c.check.ok ? "совпадает" : "не совпадает"} с суммой расходов статей {fmtMoney(c.check.articleCostSum)}
          {!c.check.ok && c.check.diff != null && ` (разница ${c.check.diff > 0 ? "+" : ""}${c.check.diff.toFixed(4)} $ — у части статей счётчик ещё не обновился: обновится после следующего этапа)`}.
        </p>
      )}
    </div>
  );
}

export type CostMatrixRow = { id: string; name: string; href?: string; sub?: string; articles: number; total: number; phases: PhaseSums };

/** Матрица «строка × фаза» с итоговой строкой. Итог = сумма строк = сумма по фазам. */
export function CostMatrix({ rows, firstCol, empty = "Расходов нет." }: { rows: CostMatrixRow[]; firstCol: string; empty?: string }) {
  if (!rows.length) return <p className="help">{empty}</p>;
  const keys = activePhases(...rows.map((r) => r.phases));
  const sum = (k: CostPhase) => rows.reduce((s, r) => s + r.phases[k], 0);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{firstCol}</th>
            <th className="text-right">Статей</th>
            {keys.map((k) => <th key={k} className="text-right whitespace-nowrap" title={COST_PHASES.find((p) => p.key === k)?.hint}>{COST_PHASES.find((p) => p.key === k)?.label}</th>)}
            <th className="text-right">Всего</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="max-w-xs">
                {r.href ? <Link href={r.href} className="font-medium hover:underline">{r.name}</Link> : <span className="font-medium">{r.name}</span>}
                {r.sub && <div className="help">{r.sub}</div>}
              </td>
              <td className="text-right tabular-nums">{r.articles}</td>
              {keys.map((k) => <td key={k} className="text-right tabular-nums whitespace-nowrap">{money(r.phases[k])}</td>)}
              <td className="text-right tabular-nums font-semibold whitespace-nowrap">{fmtMoney(r.total)}</td>
            </tr>
          ))}
          {rows.length > 1 && (
            <tr>
              <td className="font-semibold">Итого</td>
              <td className="text-right tabular-nums font-semibold">{rows.reduce((s, r) => s + r.articles, 0)}</td>
              {keys.map((k) => <td key={k} className="text-right tabular-nums font-semibold whitespace-nowrap">{fmtMoney(sum(k))}</td>)}
              <td className="text-right tabular-nums font-semibold whitespace-nowrap">{fmtMoney(rows.reduce((s, r) => s + r.total, 0))}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Расход по каждой статье: статус и фазы. */
export function CostArticlesTable({ c, limit = 500 }: { c: CostBreakdown; limit?: number }) {
  if (!c.articles.length) return <p className="help">Статей нет.</p>;
  const keys = activePhases(...c.articles.map((a) => a.phases));
  const rows = c.articles.slice(0, limit);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Ключ</th>
            <th>Статус</th>
            {keys.map((k) => <th key={k} className="text-right whitespace-nowrap">{COST_PHASES.find((p) => p.key === k)?.label}</th>)}
            <th className="text-right">Вызовов</th>
            <th className="text-right">Всего</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="max-w-xs"><Link href={`/pinterest/articles/articles/${a.id}`} className="hover:underline">{a.keyword}</Link></td>
              <td className="whitespace-nowrap"><Badge tone={badgeTone(STATUS_LABELS[a.status].tone)}>{STATUS_LABELS[a.status].label}</Badge>{a.outcome === "wasted" && a.total > 0 && <span className="ml-1 text-danger text-[12px]">потеряно</span>}</td>
              {keys.map((k) => <td key={k} className="text-right tabular-nums whitespace-nowrap">{money(a.phases[k])}</td>)}
              <td className="text-right tabular-nums help">{a.calls}</td>
              <td className="text-right tabular-nums font-semibold whitespace-nowrap">{fmtMoney(a.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {c.articles.length > limit && <p className="help mt-2">Показаны {limit} самых дорогих из {c.articles.length}.</p>}
    </div>
  );
}

/** Столбики расхода по дням (стек по фазам). */
export function CostDays({ c, days }: { c: CostBreakdown; days: number }) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0); since.setUTCDate(since.getUTCDate() - (days - 1));
  const list = Array.from({ length: days }, (_, i) => { const d = new Date(since); d.setUTCDate(since.getUTCDate() + i); const key = d.toISOString().slice(0, 10); return c.byDay.find((x) => x.day === key) ?? { day: key, total: 0, phases: null }; });
  const max = Math.max(0.000_001, ...list.map((d) => d.total));
  const keys = activePhases(c.phases);
  return (
    <div>
      <div className="flex h-32 items-end gap-[3px]">
        {list.map((d) => (
          <div key={d.day} className="flex h-full flex-1 flex-col items-stretch justify-end" title={`${d.day}: ${fmtMoney(d.total)}`}>
            {d.total > 0 && d.phases ? (
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-t" style={{ height: `${Math.max(2, (d.total / max) * 100)}%` }}>
                {keys.map((k) => (d.phases![k] > 0 ? <div key={k} className={PHASE_COLOR[k]} style={{ height: `${(d.phases![k] / d.total) * 100}%` }} /> : null))}
              </div>
            ) : (
              <div className="w-full rounded-t bg-ink/5" style={{ height: "2%" }} />
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between help"><span>{list[0]?.day}</span><span>макс. {fmtMoney(max)} в день</span><span>{list[list.length - 1]?.day}</span></div>
    </div>
  );
}
