import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Alert, Badge, Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { NewsNav } from "@/components/news/NewsNav";
import { LiveRefresh } from "@/components/news/LiveRefresh";
import { makeBriefAction, researchAction, runNow, setBriefStatus, setClusterStatus, takeToWork, toggleStar, trendSearch } from "@/actions/news";
import { CopyButton } from "@/components/news/CopyButton";
import { FORMATS } from "@/lib/news/brief";
import { embedCode } from "@/lib/news/research";
import { EmbedPreview } from "@/components/news/EmbedPreview";
import { requireProject } from "@/lib/news/access";
import { agoText, favCounts, feed, fmtKyiv, readyCounts, spendByDay, summary, trendsOf, type FeedCard, type SiteBrief } from "@/lib/news/query";
import { isQuietHour, QUIET_FROM, QUIET_TO } from "@/lib/news/runs";
import { BASE_PATH, BRIEF_STATUS_LABELS, CATEGORY_LABELS, CLUSTER_STATUS_LABELS, parseSettings, PRIORITY_LABELS, projectSites, RUN_SCOPES, type NewsSite } from "@/lib/news/types";
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
  const filter = { cat: sp(q, "cat") || undefined, urgent: sp(q, "urgent") === "1", notUa: sp(q, "notua") === "1", all: sp(q, "all") === "1", status: sp(q, "status") || undefined, priority: sp(q, "pr") || undefined, sort: (sp(q, "sort") === "fresh" ? "fresh" : "score") as "fresh" | "score", hours: Number(sp(q, "h")) || 6, fav: sp(q, "fav") === "1", favDay: Math.min(2, Math.max(0, Number(sp(q, "fd")) || 0)), ready: sp(q, "ready") === "1", site: sp(q, "site") || undefined, pub: (["wait", "done"].includes(sp(q, "pub") ?? "") ? sp(q, "pub") : undefined) as "wait" | "done" | undefined };
  const sites = projectSites(project, parseSettings(project.settings));
  const [{ cards, hidden, total, lastRunAt }, sum, trends, spend, favN, readyN] = await Promise.all([feed(project.id, filter), summary(project.id), trendsOf(project.id), spendByDay(project.id), favCounts(project.id), readyCounts(project.id)]);
  const link = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams({ project: project.id });
    const merged = { cat: filter.cat, urgent: filter.urgent ? "1" : undefined, notua: filter.notUa ? "1" : undefined, all: filter.all ? "1" : undefined, status: filter.status, pr: filter.priority, sort: filter.sort === "fresh" ? "fresh" : undefined, h: filter.sort === "fresh" && filter.hours !== 6 ? String(filter.hours) : undefined, fav: filter.fav ? "1" : undefined, fd: filter.fav && filter.favDay ? String(filter.favDay) : undefined, ready: filter.ready ? "1" : undefined, site: filter.ready ? filter.site : undefined, pub: filter.ready ? filter.pub : undefined, ...patch };
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
        {!sum.active && isQuietHour() ? ` · ночная пауза до 0${QUIET_TO}:00 (плановые с ${QUIET_FROM}:00 до 0${QUIET_TO}:00 не идут)` : sum.nextRunAt && !sum.active ? ` · следующий плановый в ${fmtKyiv(sum.nextRunAt, false)}` : ""}
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
        <Link href={link({ fav: filter.fav ? undefined : "1", fd: undefined, ready: undefined, site: undefined, pub: undefined })} className={`tab ${filter.fav ? "active" : ""}`}>★ Избранное</Link>
        <Link href={link({ ready: filter.ready ? undefined : "1", fav: undefined, fd: undefined, site: undefined, pub: undefined })} className={`tab ${filter.ready ? "active" : ""}`}>✓ ТЗ готово ({readyN.total})</Link>
      </div>

      {filter.fav && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[14px]">
          <span className="help">Избранное за:</span>
          {["Сегодня", "Вчера", "Позавчера"].map((label, d) => (
            <Link key={d} href={link({ fd: d ? String(d) : undefined })} className={`tab ${filter.favDay === d ? "active" : ""}`}>{label} ({favN[d]})</Link>
          ))}
          <span className="help">По дню, когда отмечено. Как только готово ТЗ хоть для одного сайта, новость переходит во вкладку «ТЗ готово». Старше трёх дней избранное очищается вместе с инфоповодами.</span>
        </div>
      )}

      {filter.ready && (
        <div className="mb-4 space-y-2 text-[14px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="help">Сайт:</span>
            <Link href={link({ site: undefined })} className={`tab ${!filter.site ? "active" : ""}`}>Все</Link>
            {[...new Set([...sites.map((x) => x.host), ...Object.keys(readyN.bySite)])].map((h) => (
              <Link key={h} href={link({ site: h })} className={`tab ${filter.site === h ? "active" : ""}`}>{sites.find((x) => x.host === h)?.name ?? h} ({readyN.bySite[h] ?? 0})</Link>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="help">Публикация:</span>
            <Link href={link({ pub: undefined })} className={`tab ${!filter.pub ? "active" : ""}`}>Все</Link>
            <Link href={link({ pub: "wait" })} className={`tab ${filter.pub === "wait" ? "active" : ""}`}>Ждут публикации</Link>
            <Link href={link({ pub: "done" })} className={`tab ${filter.pub === "done" ? "active" : ""}`}>Опубликовано ({readyN.published})</Link>
            <span className="help">Свежие ТЗ сверху. В карточке можно добавить ТЗ для другого сайта под другим углом.</span>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[14px]">
        <span className="help">Показывать:</span>
        <Link href={link({ sort: undefined, h: undefined, all: undefined })} className={`tab ${filter.sort !== "fresh" ? "active" : ""}`}>Топ по баллу: инфоповоды за сутки</Link>
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
          {cards.length === 0 && filter.ready ? (
            <Empty title="Готовых ТЗ пока нет" hint="В карточке новости нажмите «+ ТЗ для сайта», выберите угол — ТЗ появится здесь." />
          ) : cards.length === 0 ? (
            <Empty title={sum.lastRun ? "За сутки подходящих новостей нет" : "Лента появится после первого прогона"} hint={sum.lastRun ? "Снимите фильтры или проверьте источники и сущности." : "Нажмите «Прогнать сейчас» — первый прогон займёт несколько минут."} />
          ) : (
            cards.map((c, i) => <ClusterCard key={c.id} c={c} rank={i + 1} fresh={filter.sort === "fresh"} sites={sites} />)
          )}
          {hidden > 0 && !filter.all && (
            <div className="text-center"><Link href={link({ all: "1" })} className="btn-ghost">Показать ещё {hidden} ниже топ-{sum.settings.topN}</Link></div>
          )}
          {filter.all && filter.sort !== "fresh" && total > sum.settings.topN && <p className="help text-center">Показаны все {total} кластеров за сутки.</p>}
          {filter.sort === "fresh" && cards.length > 0 && <p className="help text-center">Показаны все {total} инфоповодов, появившихся за последние {filter.hours} ч, новые сверху. Темы, начавшиеся раньше, сюда не попадают, даже если их кто-то перепечатал сейчас.</p>}
        </div>

        <div className="space-y-4">
          <Card title="Google Trends: Украина" description="Последние 12 часов. Война и политика отсекаются стоп-словами, наши — с нишевыми словами или сущностями.">
            {trends.length === 0 ? <p className="help">Трендов пока нет — появятся после прогона.</p> : (
              <ul className="space-y-2 text-[14px]">
                {trends.slice(0, 15).map((t) => (
                  <li key={t.id} className={t.relevant ? "" : "opacity-60"}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={t.relevant ? "font-medium" : ""}>{t.title}</span>
                      {t.traffic && <span className="help">· {t.traffic}</span>}
                      {t.relevant && <Badge tone="brand">наше</Badge>}
                    </div>
                    {t.relevant && (t.cluster ? (
                      <a href={`#c-${t.cluster.id}`} className="help block text-info hover:underline">→ карточка «{t.cluster.title.slice(0, 60)}» ({t.cluster.score})</a>
                    ) : (
                      <ActionForm action={trendSearch} className="mt-0.5 inline" hidden={{ project: project.id, q: t.title }}>
                        <SubmitButton className="btn-ghost btn-sm !h-6 !px-2 text-[12px]" pendingText="Ищу…">Найти новости по тренду</SubmitButton>
                      </ActionForm>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Очередь">
            <p className="help">Ждут классификации: <b className="text-ink">{sum.waiting}</b>. Классифицировано за сутки: {sum.classified} из лимита {sum.settings.classifyPerDay}.</p>
            <p className="help mt-2">
              {sum.active ? (sum.active.status === "running" ? "Анализ идёт сейчас — карточки появятся в ленте сами." : "Анализ в очереди, начнётся через минуту.") : isQuietHour() ? `Ночная пауза: плановый анализ не идёт с ${QUIET_FROM}:00 до 0${QUIET_TO}:00 по Киеву. Вручную запустить можно.` : sum.nextRunAt ? `Следующий плановый анализ в ${fmtKyiv(sum.nextRunAt, false)}.` : ""}
            </p>
            {!sum.active && (
              <ActionForm action={runNow} className="mt-3" hidden={{ project: project.id, scope: "all" }}>
                <SubmitButton className="btn-brand btn-sm w-full" pendingText="Ставлю…">Запустить анализ сейчас</SubmitButton>
              </ActionForm>
            )}
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

function ClusterCard({ c, rank, fresh, sites }: { c: FeedCard; rank: number; fresh?: boolean; sites: NewsSite[] }) {
  const notUa = c.worldCount > 0 && c.uaCount === 0;
  const title = c.titleUk || c.title;
  const showOriginal = !!c.titleUk && c.titleUk.trim() !== c.title.trim();
  const firstWhy = c.priorityWhy[0] ?? [...c.parts].filter((p) => p.points > 0).sort((a, b) => b.points - a.points).map((p) => `${p.label}: ${p.why}`)[0];
  const siteName = (h: string) => sites.find((x) => x.host === h)?.name ?? h;
  const competitorsAngle = c.briefs.find((b) => b.angles?.competitorsAngle)?.angles?.competitorsAngle;
  return (
    <details id={`c-${c.id}`} className={`card group overflow-hidden ${c.starred ? "!border-brand/60 !bg-brand-soft/25" : ""}`} open={c.briefs.some((b) => b.status === "draft")}>
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
            {c.starred && <span className="badge bg-brand-soft text-warn">★ в избранном</span>}
            {c.briefs.map((b) => <span key={b.id} className={`badge ${b.status === "draft" ? "bg-ink/5 text-ink-2" : "bg-ok-soft text-ok"}`}>{siteName(b.site)}: {BRIEF_STATUS_LABELS[b.status] ?? b.status}</span>)}
            {c.isNew && <span className="badge bg-info-soft text-info">нове</span>}
            {!c.isNew && c.newSources > 0 && <span className="badge bg-info-soft text-info">+{c.newSources} {c.newSources === 1 ? "источник" : "источника"}</span>}
            {fresh && <span className="text-[12px] text-muted">инфоповод {agoText(c.firstPublishedAt)}</span>}
            {c.priority && <span className={`badge ${PRIORITY_TONE[c.priority] ?? ""}`}>{PRIORITY_LABELS[c.priority] ?? c.priority}</span>}
            {notUa && <Badge tone="brand">Ещё нет в UA</Badge>}
            {c.category && <Badge>{CATEGORY_LABELS[c.category] ?? c.category}</Badge>}
            {c.uaCount > 0 && <span className="badge bg-info-soft text-info" title="Украинские СМИ, которые уже написали">UA · {c.uaCount}</span>}
            {c.worldCount > 0 && <span className="badge bg-ink/5 text-ink-2" title="Англоязычные и другие мировые СМИ">EN · {c.worldCount}</span>}
            {c.sensitive && <Badge tone="warn">Чувствительная тема</Badge>}
            {c.status !== "new" && !c.briefs.length && <Badge tone="ok">{CLUSTER_STATUS_LABELS[c.status]}</Badge>}
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
          {competitorsAngle && <p className="mb-2 text-[14px] text-ink-2">Общий угол конкурентов: {competitorsAngle}</p>}
          <ul className="space-y-1.5 text-[14px]">
            {c.sources.slice(0, 12).map((s) => (
              <li key={s.url} className="flex flex-wrap gap-x-2">
                <span className="w-12 shrink-0 tabular-nums text-muted">{fmtKyiv(s.at, false)}</span>
                <span className="font-medium">{s.domain}</span>
                <span className={`badge ${s.tier === "world" ? "bg-ink/5 text-ink-2" : "bg-info-soft text-info"}`}>{s.tier === "world" ? "EN" : "UA"}</span>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-ink-2 hover:underline">{s.title}</a>
              </li>
            ))}
          </ul>
          {c.sources.length > 12 && <p className="help mt-1">и ещё {c.sources.length - 12}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ActionForm action={toggleStar} className="inline" hidden={{ id: c.id }}>
            <SubmitButton className={c.starred ? "btn-ghost btn-sm" : "btn-primary btn-sm"} pendingText={c.starred ? "…" : "Добавляю и ищу материалы в вебе… ~30 с"}>{c.starred ? "☆ Убрать из избранного" : "★ В избранное — хочу написать"}</SubmitButton>
          </ActionForm>
          {c.starred && (
            <ActionForm action={researchAction} className="inline" hidden={{ id: c.id }}>
              <SubmitButton className="btn-ghost btn-sm" pendingText="Ищу в вебе и у конкурентов… ~30 с">{c.research ? "Обновить материалы из источников" : "Собрать материалы из источников"}</SubmitButton>
            </ActionForm>
          )}
        </div>

        {c.research && (c.research.images.length > 0 || c.research.embeds.length > 0) && (
          <div>
            <h4 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">Материалы из источников</h4>
            {c.research.embeds.length > 0 && (
              <div className="mb-3">
                <p className="mb-1 text-[13px] text-ink-2">Вставки — готовый код для WordPress (блок «HTML»), главным фото быть не могут:</p>
                <EmbedPreview embeds={c.research.embeds.map((e) => ({ kind: e.kind, url: e.url, from: e.from, author: e.author, text: e.text, why: e.why, code: embedCode(e) }))} />
              </div>
            )}
            {c.research.images.length > 0 && (
              <div>
                <p className="mb-1 text-[13px] text-ink-2">Картинки источников — только ориентир, что искать (сюжет, ракурс). На сайт не копировать: искать оригинал в пресс-материалах или посте героя.</p>
                <div className="flex flex-wrap gap-2">
                  {c.research.images.slice(0, 12).map((im) => (
                    <a key={im.url} href={im.url} target="_blank" rel="noopener noreferrer" className="block w-28 overflow-hidden rounded-lg border border-line bg-ink/5" title={`${im.from}${im.w ? ` · ${im.w}${im.h ? `×${im.h}` : " px"}` : ""}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={im.url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-20 w-full object-cover" />
                      <div className="truncate px-1 py-0.5 text-[11px] text-muted">{im.from}{im.w ? ` · ${im.w}` : ""}</div>
                    </a>
                  ))}
                </div>
              </div>
            )}
            {c.research.pages.some((p) => !p.ok) && <p className="help mt-1">Не открылись: {c.research.pages.filter((p) => !p.ok).map((p) => `${p.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]} (${p.note})`).join(", ")}</p>}
          </div>
        )}

        <div className="rounded-xl border border-line bg-surface-2 p-3 sm:p-4">
          <h4 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">ТЗ по сайтам</h4>
          {c.briefs.length === 0 && <p className="mb-2 text-[14px] text-ink-2">Выберите сайт — модуль предложит 3 угла под него с учётом того, что уже написали конкуренты. Выберете угол — получите ТЗ для Claude. Ту же новость можно написать на другие сайты: у каждого свои углы, уже взятые не повторяются.</p>}
          <div className="space-y-3">
            {c.briefs.map((b) => <SiteBriefBlock key={b.id} b={b} clusterId={c.id} name={siteName(b.site)} />)}
          </div>
          {sites.some((x) => !c.briefs.some((b) => b.site === x.host)) ? (
            <div className={`flex flex-wrap items-center gap-2 ${c.briefs.length ? "mt-3" : ""}`}>
              {sites.filter((x) => !c.briefs.some((b) => b.site === x.host)).map((x) => (
                <ActionForm key={x.host} action={takeToWork} className="inline" hidden={{ id: c.id, site: x.host }}>
                  <SubmitButton className={c.briefs.length ? "btn-ghost btn-sm" : "btn-brand btn-sm"} pendingText="Думаю над углами… ~20 с">+ ТЗ для {x.name}</SubmitButton>
                </ActionForm>
              ))}
            </div>
          ) : sites.length === 0 ? <p className="help">Сайты для ТЗ не заданы — добавьте их в настройках проекта.</p> : null}
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

function SiteBriefBlock({ b, clusterId, name }: { b: SiteBrief; clusterId: string; name: string }) {
  const angles = b.angles?.angles ?? [];
  return (
    <details className="rounded-lg border border-line bg-surface" open={b.status === "draft"}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold">{name}</span>
        <span className={`badge ${b.status === "draft" ? "bg-ink/5 text-ink-2" : "bg-ok-soft text-ok"}`}>{BRIEF_STATUS_LABELS[b.status] ?? b.status}</span>
        {b.angleIdx != null && angles[b.angleIdx] && <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">Угол: {angles[b.angleIdx].title}</span>}
        {b.briefAt && <span className="help">ТЗ {agoText(b.briefAt)}</span>}
      </summary>
      <div className="space-y-3 border-t border-line px-3 py-3">
        {b.angles?.gaps && b.angles.gaps.length > 0 && <p className="text-[14px] text-ink-2">Чего нет ни у кого: {b.angles.gaps.join("; ")}</p>}
        <ol className="space-y-2">
          {angles.map((a, i) => (
            <li key={i} className={`rounded-lg border p-3 ${b.angleIdx === i ? "border-brand bg-brand-soft/40" : "border-line bg-surface-2"}`}>
              <div className="mb-0.5 text-[12px] text-muted">Угол {i + 1}{a.kind ? ` · ${a.kind}` : ""}{a.format && FORMATS[a.format] ? ` · ${FORMATS[a.format].words}` : ""} · новизна {a.novelty}/5 · польза {a.usefulness}/5</div>
              <div className="font-semibold">{a.title}</div>
              <p className="mt-1 text-[14px]">{a.angle}</p>
              <p className="mt-1 text-[13px] text-ink-2">Почему сработает: {a.why}</p>
              <ActionForm action={makeBriefAction} className="mt-2" hidden={{ brief: b.id, idx: String(i) }}>
                <SubmitButton className={b.angleIdx === i ? "btn-ghost btn-sm" : "btn-primary btn-sm"} pendingText="Пишу ТЗ… ~30 с">{b.angleIdx === i ? "Пересобрать ТЗ по этому углу" : "Беру этот угол → ТЗ"}</SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <ActionForm action={takeToWork} className="inline" hidden={{ id: clusterId, site: b.site, op: "again" }}>
            <SubmitButton className="btn-ghost btn-sm" pendingText="Думаю…">Предложить другие углы</SubmitButton>
          </ActionForm>
          {b.brief && b.status !== "published" && (
            <ActionForm action={setBriefStatus} className="inline" hidden={{ brief: b.id, op: "published" }}>
              <SubmitButton className="btn-ghost btn-sm" pendingText="…">Опубликовано на {name}</SubmitButton>
            </ActionForm>
          )}
          {b.status === "published" && (
            <ActionForm action={setBriefStatus} className="inline" hidden={{ brief: b.id, op: "ready" }}>
              <SubmitButton className="btn-ghost btn-sm" pendingText="…">Ещё не опубликовано</SubmitButton>
            </ActionForm>
          )}
          <ActionForm action={setBriefStatus} className="ml-auto inline" hidden={{ brief: b.id, op: "delete" }}>
            <SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…">Убрать ТЗ для {name}</SubmitButton>
          </ActionForm>
        </div>
        {b.brief && (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold">ТЗ для Claude — {name}</span>
              <span className="help">собрано {agoText(b.briefAt)}</span>
              <span className="ml-auto"><CopyButton text={b.brief} label="Скопировать ТЗ" /></span>
            </div>
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-2 p-3 text-[13px] leading-relaxed">{b.brief}</pre>
          </div>
        )}
      </div>
    </details>
  );
}
