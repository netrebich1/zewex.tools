import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { NewsNav } from "@/components/news/NewsNav";
import { requireProject } from "@/lib/news/access";
import { fmtKyiv, runsOf, spendByDay, summary } from "@/lib/news/query";
import { BASE_PATH, RUN_SCOPES, RUN_STATUS_LABELS } from "@/lib/news/types";
import { fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TONE: Record<string, "neutral" | "ok" | "warn" | "danger" | "brand"> = { queued: "neutral", running: "brand", done: "ok", failed: "danger" };
const scopeLabel = (s: string) => RUN_SCOPES.find((x) => x.value === s)?.label ?? (s.startsWith("source:") ? "один источник" : s);
const dur = (a: Date | null, b: Date | null) => (a && b ? `${Math.max(1, Math.round((b.getTime() - a.getTime()) / 1000))} с` : "—");

export default async function NewsRunsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const { project, list } = await requireProject(me, sp(q, "project"));
  if (!project) return <Empty title="Проектов пока нет" hint="Создайте проект в настройках." action={<Link href={`${BASE_PATH}/settings`} className="btn-brand">Настройки</Link>} />;
  const [runs, spend, sum] = await Promise.all([runsOf(project.id, 80), spendByDay(project.id), summary(project.id)]);
  const budget = sum.settings.monthlyBudgetUsd;
  const now = new Date();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  const forecast = sum.spend.month + (spend.last7 / 7) * (daysInMonth - now.getUTCDate());
  const yesterday = spend.days.find(([d]) => d === new Date(Date.now() - 86_400_000).toISOString().slice(0, 10))?.[1].usd ?? 0;
  const done = runs.filter((r) => r.status === "done");
  const withCards = done.reduce((a, r) => a + (r.st.clustersNew ?? 0), 0);

  return (
    <>
      <NewsNav projects={list.map((p) => ({ id: p.id, name: p.name }))} current={project.id} />
      <PageHeader
        title="Прогоны и расход"
        subtitle="Каждый платный вызов (классификация, эмбеддинги) пишется в общий журнал расхода портала с привязкой к прогону. Бесплатные шаги — ленты, Google News, Trends — стоят $0. При 100% бюджета платные шаги встают, материалы ждут в очереди."
        actions={<Link href="/usage" className="btn-ghost">Общий журнал расхода</Link>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { label: "Сегодня", value: fmtMoney(sum.spend.day) },
          { label: "Вчера", value: fmtMoney(yesterday) },
          { label: "7 дней", value: fmtMoney(spend.last7) },
          { label: `Месяц (бюджет ${fmtMoney(budget)})`, value: fmtMoney(sum.spend.month) },
          { label: "Прогноз до конца месяца", value: fmtMoney(forecast) },
        ].map((k) => (
          <div key={k.label} className="kpi">
            <div className={`kpi-value ${budget && k.label.startsWith("Прогноз") && forecast > budget ? "text-danger" : ""}`}>{k.value}</div>
            <div className="help">{k.label}</div>
          </div>
        ))}
      </div>
      <p className="help mb-5">
        Средний прогон за 7 дней: {spend.avgRun != null ? fmtMoney(spend.avgRun) : "—"}
        {withCards ? ` · новая карточка в ленте ≈ ${fmtMoney(done.reduce((a, r) => a + r.costUsd, 0) / withCards)}` : ""}
        {" "}· стоимость статьи и 1000 показов Discover появятся вместе с публикациями и Search Console (этапы 2–3).
      </p>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Card title="Прогоны" description="Воронка: собрано → новых → отсечено словами, рубриками, белым списком, эмбеддингом и LLM → карточки. Строка раскрывается: журнал прогона и ошибки источников.">
          {runs.length === 0 ? <p className="help">Прогонов ещё не было.</p> : (
            <div className="space-y-2">
              {runs.map((r) => {
                const st = r.st;
                const cut = (st.cutWords ?? 0) + (st.cutRubric ?? 0) + (st.cutWhitelist ?? 0);
                return (
                  <details key={r.id} className="rounded-xl border border-line">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[14px] [&::-webkit-details-marker]:hidden">
                      <span className="w-24 tabular-nums">{fmtKyiv(r.createdAt)}</span>
                      <Badge tone={TONE[r.status] ?? "neutral"}>{RUN_STATUS_LABELS[r.status] ?? r.status}{r.step ? ` · ${r.step}` : ""}</Badge>
                      <span className="help">{r.kind === "manual" ? `ручной${r.userName ? ` · ${r.userName}` : ""}` : "плановый"} · {scopeLabel(r.scope)} · {dur(r.startedAt, r.finishedAt)}</span>
                      <span className="help">
                        собрано {st.fetched ?? 0} → новых {st.fresh ?? 0} → отсеяно {cut}{st.cutEmbed ? ` + ${st.cutEmbed} эмб.` : ""} → LLM {st.classified ?? 0} (не наше {st.cutLlm ?? 0}) → кластеров +{st.clustersNew ?? 0}
                      </span>
                      <span className="ml-auto font-medium tabular-nums">{fmtMoney(r.costUsd)}</span>
                    </summary>
                    <div className="space-y-1 border-t border-line px-3 py-2 text-[13px]">
                      <p className="help">
                        Источников {st.sources ?? 0}, с ошибкой {st.sourceErrors ?? 0}{st.proxied ? `, через прокси ${st.proxied}` : ""} · дублей {st.dup ?? 0} · старше окна {st.old ?? 0} · стоп-слова {st.cutWords ?? 0}, рубрики {st.cutRubric ?? 0}, без сущности и ниши {st.cutWhitelist ?? 0}
                        {" "}· эмбеддингов {st.embedded ?? 0}{st.embedFilterOn ? "" : " (фильтр по эмбеддингу ждёт примеров)"} · ждут в очереди {st.waiting ?? 0} · обновлено кластеров {st.clustersUpdated ?? 0} · трендов {st.trends ?? 0} · алертов {st.alerts ?? 0}
                      </p>
                      {st.budgetStop && <p className="text-warn">Платные шаги пропущены: {st.budgetStop}</p>}
                      {r.error && <p className="text-danger">{r.error}</p>}
                      {(st.log ?? []).map((l, i) => <p key={i} className="mono text-ink-2">{l}</p>)}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </Card>
        <Card title="По дням">
          {spend.days.length === 0 ? <p className="help">Пока пусто.</p> : (
            <table className="table">
              <thead><tr><th>День (UTC)</th><th>Прогонов</th><th className="text-right">$</th></tr></thead>
              <tbody>
                {spend.days.map(([d, v]) => <tr key={d}><td>{d.slice(5)}</td><td>{v.runs}</td><td className="text-right tabular-nums">{fmtMoney(v.usd)}</td></tr>)}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
