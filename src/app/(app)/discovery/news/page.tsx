import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Alert, Badge, Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { NewsNav } from "@/components/news/NewsNav";
import { LiveRefresh } from "@/components/news/LiveRefresh";
import { makeBriefAction, runNow, setClusterStatus, takeToWork } from "@/actions/news";
import { CopyButton } from "@/components/news/CopyButton";
import { FORMATS } from "@/lib/news/brief";
import { requireProject } from "@/lib/news/access";
import { agoText, feed, fmtKyiv, spendByDay, summary, trendsOf, type FeedCard } from "@/lib/news/query";
import { BASE_PATH, CATEGORY_LABELS, CLUSTER_STATUS_LABELS, PRIORITY_LABELS, RUN_SCOPES } from "@/lib/news/types";
import { fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

const scoreTone = (s: number) => (s >= 70 ? "bg-danger-soft text-danger" : s >= 50 ? "bg-brand-soft text-warn" : "bg-ink/5 text-ink-2");

export default async function NewsFeedPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const { project, list } = await requireProject(me, sp(q, "project"));
  if (!project) {
    return (
      <>
        <PageHeader title="Новости для Discover" subtitle="Мониторинг новостей, которые могут залететь в Google Discover и Google News." />
        <Empty title="Проектов пока нет" hint={me.role === "ADMIN" ? "Создайте проект (сайт) в настройках модуля." : "Попросите администратора добавить проект вашей команды."} action={me.role === "ADMIN" ? <Link href={`${BASE_PATH}/settings`} className="btn-brand">Создать проект</Link> : undefined} />
      </>
    );
  }
  const filter = { cat: sp(q, "cat") || undefined, urgent: sp(q, "urgent") === "1", notUa: sp(q, "notua") === "1", all: sp(q, "all") === "1", status: sp(q, "status") || undefined, priority: sp(q, "pr") || undefined, sort: (sp(q, "sort") === "fresh" ? "fresh" : "score") as "fresh" | "score", hours: Number(sp(q, "h")) || 6 };
  const [{ cards, hidden, total, lastRunAt }, sum, trends, spend] = await Promise.all([feed(project.id, filter), summary(project.id), trendsOf(project.id), spendByDay(project.id)]);
  const link = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams({ project: project.id });
    const merged = { cat: filter.cat, urgent: filter.urgent ? "1" : undefined, notua: filter.notUa ? "1" : undefined, all: filter.all ? "1" : undefined, status: filter.status, pr: filter.priority, sort: filter.sort === "fresh" ? "fresh" : undefined, h: filter.sort === "fresh" && filter.hours !== 6 ? String(filter.hours) : undefined, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    return `${BASE_PATH}?${u.toString()}`;
  };
  const budget = sum.settings.monthlyBudgetUsd;

  return (
    <>
      <NewsNav projects={list.map((p) => ({ id: p.id, name: p.name }))} current={project.id} />
      <PageHeader
        title="Лента"
        subtitle={`Кластеры за сутки, отсортированные по баллу: почему новость первая, кто уже написал. Топ-${sum.settings.topN}, срочные от ${sum.settings.urgentScore} баллов. Прогон раз в ${sum.settings.intervalMin} мин.`}
        actions={
          <ActionForm action={runNow} className="flex flex-wrap items-center gap-2" hidden={{ project: project.id }}>
            <select name="scope" className="input !w-auto" defaultValue="all" aria-label="Что прогнать">
              {RUN_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <SubmitButton className="btn-brand" pendingText="Ставлю…">Прогнать сейчас</SubmitButton>
          </ActionForm>
        }
      />
      <p className="help -mt-4 mb-4">
        Последний прогон: {sum.lastRun ? `${agoText(sum.lastRun.finishedAt ?? sum.lastRun.createdAt)}${sum.lastRun.status === "failed" ? " — с ошибкой" : ""}` : "ещё не было"}
        {sum.nextRunAt && !sum.active ? ` · следующий плановый в ${fmtKyiv(sum.nextRunAt, false)}` : ""}
        {spend.avgRun != null ? ` · средний прогон ${fmtMoney(spend.avgRun)}` : ""}
      </p>
      <LiveRefresh projectId={project.id} />
      {!project.isActive && <div className="mb-4"><Alert tone="warn">Проект выключен: плановые прогоны не идут. Включить — в настройках.</Alert></div>}
      {sum.lastRun?.status === "failed" && sum.lastRun.error && <div className="mb-4"><Alert tone="danger">Последний прогон: {sum.lastRun.error}</Alert></div>}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: `Карточек в ленте (всего за сутки ${sum.cardsTotal})`, value: String(sum.cards) },
          { label: "Срочных за сутки", value: String(sum.urgent) },
          { label: `Материалов за сутки: новых ${sum.fresh}, прошло фильтры ${Math.max(0, sum.passed)}`, value: String(sum.fetched) },
          { label: `Расход: сегодня ${fmtMoney(sum.spend.day)}, бюджет ${fmtMoney(budget)}/мес`, value: fmtMoney(sum.spend.month), href: `${BASE_PATH}/runs?project=${project.id}` },
        ].map((k) => (
          <Link key={k.label} href={k.href ?? link({})} className="kpi block hover:border-brand">
            <div className="kpi-value">{k.value}</div>
            <div className="help">{k.label}</div>
          </Link>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Link href={link({ cat: undefined })} className={`tab ${!filter.cat ? "active" : ""}`}>Все</Link>
        {sum.settings.targetCategories.map((c) => <Link key={c} href={link({ cat: c })} className={`tab ${filter.cat === c ? "active" : ""}`}>{CATEGORY_LABELS[c] ?? c}</Link>)}
        <span className="mx-1 h-4 w-px bg-line" />
        <Link href={link({ pr: filter.priority === "must" ? undefined : "must" })} className={`tab ${filter.priority === "must" ? "active" : ""}`}>Обязательно написать</Link>
        <Link href={link({ urgent: filter.urgent ? undefined : "1" })} className={`tab ${filter.urgent ? "active" : ""}`}>Только срочные</Link>
        <Link href={link({ notua: filter.notUa ? undefined : "1" })} className={`tab ${filter.notUa ? "active" : ""}`}>Ещё нет в UA</Link>
        <Link href={link({ status: filter.status === "in_work" ? undefined : "in_work" })} className={`tab ${filter.status === "in_work" ? "active" : ""}`}>В работе</Link>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[14px]">
        <span className="help">Показывать:</span>
        <Link href={link({ sort: undefined, h: undefined, all: undefined })} className={`tab ${filter.sort !== "fresh" ? "active" : ""}`}>Топ по баллу за сутки</Link>
        <Link href={link({ sort: "fresh", h: undefined, all: undefined })} className={`tab ${filter.sort === "fresh" ? "active" : ""}`}>Свежее, новые сверху</Link>
        {filter.sort === "fresh" && (
          <span className="flex items-center gap-1">
            <span className="help ml-2">за</span>
            {[2, 6, 12, 24].map((h) => <Link key={h} href={link({ sort: "fresh", h: String(h) })} className={`tab ${filter.hours === h ? "active" : ""}`}>{h} ч</Link>)}
          </span>
        )}
        <span className="help ml-auto">
          {lastRunAt ? `Последний прогон начался ${fmtKyiv(lastRunAt, false)}: метки «нове» и «+источники» — что он добавил` : ""}
        </span>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          {cards.length === 0 ? (
            <Empty title={sum.lastRun ? "За сутки подходящих новостей нет" : "Лента появится после первого прогона"} hint={sum.lastRun ? "Снимите фильтры или проверьте источники и сущности." : "Нажмите «Прогнать сейчас» — первый прогон займёт несколько минут."} />
          ) : (
            cards.map((c, i) => <ClusterCard key={c.id} c={c} rank={i + 1} fresh={filter.sort === "fresh"} />)
          )}
          {hidden > 0 && !filter.all && (
            <div className="text-center"><Link href={link({ all: "1" })} className="btn-ghost">Показать ещё {hidden} ниже топ-{sum.settings.topN}</Link></div>
          )}
          {filter.all && filter.sort !== "fresh" && total > sum.settings.topN && <p className="help text-center">Показаны все {total} кластеров за сутки.</p>}
          {filter.sort === "fresh" && cards.length > 0 && <p className="help text-center">Показаны все {total} кластеров с публикациями за последние {filter.hours} ч, новые сверху.</p>}
        </div>

        <div className="space-y-4">
          <Card title="Google Trends: Украина" description="Последние 12 часов. Война и политика отсекаются стоп-словами, наши — с нишевыми словами или сущностями.">
            {trends.length === 0 ? <p className="help">Трендов пока нет — появятся после прогона.</p> : (
              <ul className="space-y-2 text-[14px]">
                {trends.slice(0, 15).map((t) => (
                  <li key={t.id} className={t.relevant ? "" : "opacity-60"}>
                    <span className={t.relevant ? "font-medium" : ""}>{t.title}</span>
                    {t.traffic && <span className="help"> · {t.traffic}</span>}
                    {t.relevant && <Badge tone="brand">наше</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Очередь">
            <p className="help">Ждут классификации: <b className="text-ink">{sum.waiting}</b>. Классифицировано за сутки: {sum.classified} из лимита {sum.settings.classifyPerDay}.</p>
          </Card>
        </div>
      </div>
    </>
  );
}

const PRIORITY_TONE: Record<string, string> = { must: "bg-danger-soft text-danger", should: "bg-brand-soft text-warn", maybe: "bg-ink/5 text-ink-2" };

function StatusButton({ id, status, label, tone = "btn-ghost" }: { id: string; status: string; label: string; tone?: string }) {
  return (
    <ActionForm action={setClusterStatus} className="inline" hidden={{ id, status }}>
      <SubmitButton className={`${tone} btn-sm`} pendingText="…">{label}</SubmitButton>
    </ActionForm>
  );
}

function ClusterCard({ c, rank, fresh }: { c: FeedCard; rank: number; fresh?: boolean }) {
  const notUa = c.worldCount > 0 && c.uaCount === 0;
  const title = c.titleUk || c.title;
  const showOriginal = !!c.titleUk && c.titleUk.trim() !== c.title.trim();
  const firstWhy = c.priorityWhy[0] ?? [...c.parts].filter((p) => p.points > 0).sort((a, b) => b.points - a.points).map((p) => `${p.label}: ${p.why}`)[0];
  const angles = c.angles?.angles ?? [];
  return (
    <details id={`c-${c.id}`} className="card group overflow-hidden" open={!!c.angles && c.status === "in_work"}>
      <summary className="flex cursor-pointer list-none gap-3 p-3 sm:p-4 [&::-webkit-details-marker]:hidden">
        <div className="relative h-20 w-24 shrink-0 overflow-hidden rounded-lg bg-ink/5 sm:h-24 sm:w-32">
          {c.imageUrl ? (
            // Картинка источника — только превью в ленте, на сайт её не копируем.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          ) : <div className="flex h-full items-center justify-center text-[12px] text-muted">нет фото</div>}
          <span className={`absolute left-1 top-1 rounded-md px-1.5 py-0.5 text-[13px] font-bold ${scoreTone(c.score)}`}>{c.score}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-muted">#{rank}</span>
            {c.isNew && <span className="badge bg-info-soft text-info">нове</span>}
            {!c.isNew && c.newSources > 0 && <span className="badge bg-info-soft text-info">+{c.newSources} {c.newSources === 1 ? "источник" : "источника"}</span>}
            {fresh && <span className="text-[12px] text-muted">последняя публикация {agoText(c.lastItemAt)}</span>}
            {c.priority && <span className={`badge ${PRIORITY_TONE[c.priority] ?? ""}`}>{PRIORITY_LABELS[c.priority] ?? c.priority}</span>}
            {notUa && <Badge tone="brand">Ещё нет в UA</Badge>}
            {c.category && <Badge>{CATEGORY_LABELS[c.category] ?? c.category}</Badge>}
            {c.sensitive && <Badge tone="warn">Чувствительная тема</Badge>}
            {c.status !== "new" && <Badge tone="ok">{CLUSTER_STATUS_LABELS[c.status]}{c.brief ? " · ТЗ готово" : c.angles ? " · углы готовы" : ""}</Badge>}
          </div>
          <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug sm:text-[16px]">{title}</h3>
          {showOriginal && <p className="line-clamp-1 text-[12.5px] text-muted">Оригинал: {c.title}</p>}
          <p className="help mt-1">
            {c.sourceCount} {c.sourceCount === 1 ? "источник" : c.sourceCount < 5 ? "источника" : "источников"} · первая публикация {fmtKyiv(c.firstPublishedAt, false)} ({agoText(c.firstPublishedAt)})
            {c.mainEntityName ? ` · ${c.mainEntityName}` : ""}
          </p>
          {firstWhy && <p className="mt-0.5 line-clamp-2 text-[13px] text-ink-2">↑ {firstWhy}</p>}
        </div>
      </summary>
      <div className="space-y-5 border-t border-line px-3 py-4 sm:px-4">
        {c.sensitive && <Alert tone="warn">Проверь уместность для бьюти-сайта.</Alert>}

        {(c.summaryUk || c.whyUs) && (
          <div className="grid gap-4 md:grid-cols-2">
            {c.summaryUk && (
              <div>
                <h4 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-muted">Суть</h4>
                <p className="text-[14px] leading-relaxed">{c.summaryUk}</p>
              </div>
            )}
            {c.whyUs && (
              <div>
                <h4 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-muted">Почему зайдёт у нас</h4>
                <p className="text-[14px] leading-relaxed">{c.whyUs}</p>
              </div>
            )}
          </div>
        )}

        <div>
          <h4 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-muted">
            {c.priority ? `${PRIORITY_LABELS[c.priority]} — почему` : "Почему сейчас"}
          </h4>
          {c.priorityWhy.length > 0 && (
            <ul className="mb-3 list-disc space-y-1 pl-5 text-[14px]">
              {c.priorityWhy.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <details className="rounded-lg border border-line">
            <summary className="cursor-pointer px-3 py-2 text-[13px] text-muted">Как сложился балл {c.score} (сигналы)</summary>
            <ul className="space-y-1.5 px-3 pb-3">
              {c.parts.map((p) => (
                <li key={p.key} className="flex gap-3 text-[14px]">
                  <span className={`w-14 shrink-0 text-right font-semibold tabular-nums ${p.points < 0 ? "text-danger" : p.points === 0 ? "text-muted" : ""}`}>{p.points > 0 ? "+" : ""}{p.points}{p.max ? <span className="font-normal text-muted">/{p.max}</span> : null}</span>
                  <span><b className="font-medium">{p.label}.</b> <span className="text-ink-2">{p.why}</span></span>
                </li>
              ))}
            </ul>
            {c.history.length > 1 && <p className="help px-3 pb-3">Балл по прогонам: {c.history.slice(-8).map((h) => h.score).join(" → ")}</p>}
          </details>
        </div>

        <div>
          <h4 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">Что уже написали ({c.sources.length})</h4>
          {c.angles?.competitorsAngle && <p className="mb-2 text-[14px] text-ink-2">Общий угол конкурентов: {c.angles.competitorsAngle}</p>}
          <ul className="space-y-1.5 text-[14px]">
            {c.sources.slice(0, 12).map((s) => (
              <li key={s.url} className="flex flex-wrap gap-x-2">
                <span className="w-12 shrink-0 tabular-nums text-muted">{fmtKyiv(s.at, false)}</span>
                <span className="font-medium">{s.domain}</span>
                {s.tier === "world" && <Badge>мир</Badge>}
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-ink-2 hover:underline">{s.title}</a>
              </li>
            ))}
          </ul>
          {c.sources.length > 12 && <p className="help mt-1">и ещё {c.sources.length - 12}</p>}
        </div>

        <div className="rounded-xl border border-line bg-surface-2 p-3 sm:p-4">
          <h4 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">Как писать</h4>
          {angles.length === 0 ? (
            <div className="space-y-2">
              <p className="text-[14px] text-ink-2">Нажмите «В работу» — модуль предложит 3 угла с учётом того, что уже написали конкуренты, и стиля редакции. Выберете угол — получите ТЗ для Claude.</p>
              <ActionForm action={takeToWork} className="inline" hidden={{ id: c.id }}>
                <SubmitButton className="btn-brand" pendingText="Думаю над углами… ~20 с">В работу — предложить углы</SubmitButton>
              </ActionForm>
            </div>
          ) : (
            <div className="space-y-3">
              {c.angles?.gaps && c.angles.gaps.length > 0 && <p className="text-[14px] text-ink-2">Чего нет ни у кого: {c.angles.gaps.join("; ")}</p>}
              <ol className="space-y-2">
                {angles.map((a, i) => (
                  <li key={i} className={`rounded-lg border p-3 ${c.angleIdx === i ? "border-brand bg-brand-soft/40" : "border-line bg-surface"}`}>
                    <div className="mb-0.5 text-[12px] text-muted">Угол {i + 1}{a.kind ? ` · ${a.kind}` : ""}{a.format && FORMATS[a.format] ? ` · ${FORMATS[a.format].words}` : ""} · новизна {a.novelty}/5 · польза {a.usefulness}/5</div>
                    <div className="font-semibold">{a.title}</div>
                    <p className="mt-1 text-[14px]">{a.angle}</p>
                    <p className="mt-1 text-[13px] text-ink-2">Почему сработает: {a.why}</p>
                    <ActionForm action={makeBriefAction} className="mt-2" hidden={{ id: c.id, idx: String(i) }}>
                      <SubmitButton className={c.angleIdx === i ? "btn-ghost btn-sm" : "btn-primary btn-sm"} pendingText="Пишу ТЗ… ~30 с">{c.angleIdx === i ? "Пересобрать ТЗ по этому углу" : "Беру этот угол → ТЗ"}</SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ol>
              <ActionForm action={takeToWork} className="inline" hidden={{ id: c.id, op: "again" }}>
                <SubmitButton className="btn-ghost btn-sm" pendingText="Думаю…">Предложить другие углы</SubmitButton>
              </ActionForm>
            </div>
          )}
          {c.brief && (
            <div className="mt-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-semibold">ТЗ для Claude</span>
                <span className="help">собрано {agoText(c.briefAt)}</span>
                <span className="ml-auto"><CopyButton text={c.brief} label="Скопировать ТЗ" /></span>
              </div>
              <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 text-[13px] leading-relaxed">{c.brief}</pre>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="help">Статус: {CLUSTER_STATUS_LABELS[c.status]}</span>
          {c.status !== "published" && <StatusButton id={c.id} status="published" label="Опубликовано" />}
          {c.status !== "rejected" && <StatusButton id={c.id} status="rejected" label="Не наша тема" />}
          {c.status !== "new" && <StatusButton id={c.id} status="new" label="Вернуть в новые" />}
        </div>
      </div>
    </details>
  );
}
