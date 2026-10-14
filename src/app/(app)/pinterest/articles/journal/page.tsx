import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, Empty, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requeueErrorGroupAction, resolveErrorGroupAction } from "@/actions/articlesModeration";
import { artSiteWhere, articleWhere } from "@/lib/articles/access";
import { stageLabel } from "@/lib/articles/stages";
import { PROJECT_SLUG } from "@/lib/articles/types";
import { fmtDate, fmtMoney } from "@/lib/utils";
import { seesTeamCosts } from "@/lib/permissions";

export const dynamic = "force-dynamic";

type Tab = "errors" | "ai" | "costs";

/** Понятные названия и подсказки частых ошибок (оригинал ErrorsPage.tsx:31-52, адаптировано к текстам наших этапов). */
const KNOWN: Array<{ re: RegExp; title: string; hint: string; kind: "bug" | "external" }> = [
  { re: /sections still empty|пустые секции|incomplete content|не дописал/i, kind: "bug", title: "ИИ не дописал часть секций текста", hint: "Обычно разовый сбой модели. «Вернуть в работу» — готовые секции сохранятся." },
  { re: /лимиту токенов|finish_reason=length|оборвался/i, kind: "bug", title: "Ответ ИИ оборвался (слишком длинный)", hint: "Разовый сбой. «Вернуть в работу» обычно помогает." },
  { re: /не подставлены переменные|Нет промта для шага/i, kind: "bug", title: "Промт рецепта не готов", hint: "Откройте рецепт → Промты: добавьте промт шага или уберите неизвестные переменные. Затем «Вернуть в работу»." },
  { re: /не удалось скачать фото/i, kind: "external", title: "Сайт-источник не отдал фото", hint: "Чужой сайт блокирует скачивание. Выберите другое фото." },
  { re: /Мало фото|не хватило фото|WAITING_FOR_PHOTOS/i, kind: "external", title: "Не хватает хороших фото", hint: "Не поломка. Статья в разделе «Мало фото»: добрать фото или отложить." },
  { re: /BILLING|баланс|402|insufficient|no_credits|закончился/i, kind: "external", title: "У ИИ-провайдера закончились деньги", hint: "Пополните баланс или включите другой ключ в разделе «Ключи». Статьи вернутся в работу кнопкой." },
  { re: /401|ключ отклон|auth|нет правила|no_binding|Не назначен ключ/i, kind: "external", title: "Ключ ИИ не назначен или отклонён", hint: "Проверьте на странице ключа галочку «Статьи» и слот. Затем «Вернуть в работу»." },
  { re: /429|rate limit|лимит запросов|слишком много/i, kind: "external", title: "Провайдер ограничил частоту запросов", hint: "Временно. Воркер повторит сам; если висит — «Вернуть в работу»." },
  { re: /All providers failed|AI не ответил|timeout|таймаут|ECONN|fetch failed/i, kind: "bug", title: "Модель ИИ или сеть не ответили", hint: "Временный сбой. Если много подряд — сообщите. Иначе «Вернуть в работу»." },
  { re: /media|upload|wp-json|WordPress|HTTP 5\d\d|rest_/i, kind: "external", title: "Ошибка сайта WordPress при публикации", hint: "Проблема на стороне хостинга (место, права, PHP) или доступа. Проверьте сайт в разделе «Сайты» → «Проверить»." },
];
const explain = (msg: string) => KNOWN.find((k) => k.re.test(msg));

export default async function JournalPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const canCosts = seesTeamCosts(me);
  const tab: Tab = (["errors", "ai", "costs"] as Tab[]).find((t) => t === sp(q, "tab")) ?? "errors";
  const siteId = sp(q, "site");
  const articleId = sp(q, "article");
  const days = Math.min(90, Math.max(1, Number(sp(q, "days")) || 7));
  const since = new Date(Date.now() - days * 86400_000);

  const sites = await prisma.artSite.findMany({ where: await artSiteWhere(me), select: { id: true, name: true, teamId: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const siteIds = sites.map((s) => s.id);
  const qs = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const all = { tab, site: siteId, article: articleId, days: days === 7 ? undefined : String(days), ...patch };
    for (const [k, v] of Object.entries(all)) if (v) u.set(k, v);
    const s = u.toString();
    return `/pinterest/articles/journal${s ? `?${s}` : ""}`;
  };

  const header = (
    <>
      <PageHeader back={{ href: "/pinterest/articles", label: "Статьи" }} title="Журнал" subtitle="Ошибки конвейера по группам, вызовы ИИ и расходы по сайтам и этапам." />
      <Card className="mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <Link href={qs({ tab: "errors", article: undefined })} className={`tab ${tab === "errors" ? "active" : ""}`}>Ошибки</Link>
          <Link href={qs({ tab: "ai" })} className={`tab ${tab === "ai" ? "active" : ""}`}>Вызовы ИИ</Link>
          {canCosts && <Link href={qs({ tab: "costs", article: undefined })} className={`tab ${tab === "costs" ? "active" : ""}`}>Расходы</Link>}
          <span className="ml-auto inline-flex gap-1">
            {[1, 7, 30].map((d) => (
              <Link key={d} href={qs({ days: d === 7 ? undefined : String(d) })} className={`btn-ghost btn-sm ${days === d ? "bg-ink/10" : ""}`}>{d === 1 ? "сутки" : `${d} дн.`}</Link>
            ))}
          </span>
        </div>
        {sites.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            <Link href={qs({ site: undefined })} className={`badge px-3 py-1 ${!siteId ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>Все сайты</Link>
            {sites.map((s) => (
              <Link key={s.id} href={qs({ site: s.id })} className={`badge px-3 py-1 ${siteId === s.id ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{s.name}</Link>
            ))}
          </div>
        )}
      </Card>
    </>
  );

  /* ───────── Ошибки ───────── */
  if (tab === "errors") {
    const visible: Prisma.ArtErrorWhereInput = me.role === "ADMIN" ? {} : { OR: [{ siteId: { in: siteIds } }, { siteId: null, teamId: { in: me.teamIds } }] };
    const where: Prisma.ArtErrorWhereInput = { ...visible, ...(siteId ? { siteId } : {}), resolvedAt: null, createdAt: { gte: since } };
    const rows = await prisma.artError.findMany({ where, orderBy: { createdAt: "desc" }, take: 3000, include: { article: { select: { id: true, keyword: true, status: true, stage: true } } } });
    const hour = Date.now() - 3600_000;
    const prevHour = hour - 3600_000;
    const burning = new Map<string, { title: string; stage: string; now: number; prev: number }>();
    for (const r of rows) {
      const t = r.createdAt.getTime();
      if (t < prevHour) continue;
      const e = burning.get(r.signature) ?? { title: explain(r.message)?.title ?? r.message.slice(0, 120), stage: r.stage, now: 0, prev: 0 };
      if (t >= hour) e.now++;
      else e.prev++;
      burning.set(r.signature, e);
    }
    const hot = [...burning.values()].filter((e) => e.now > 0).sort((a, b) => b.now - a.now).slice(0, 8);

    type Group = { signature: string; stage: string; n: number; articles: Set<string>; sites: Set<string>; first: Date; last: Date; example: string; lastArticle: { id: string; keyword: string; status: string } | null; failed: number };
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const g = groups.get(r.signature) ?? { signature: r.signature, stage: r.stage, n: 0, articles: new Set<string>(), sites: new Set<string>(), first: r.createdAt, last: r.createdAt, example: r.message, lastArticle: r.article ? { id: r.article.id, keyword: r.article.keyword, status: r.article.status } : null, failed: 0 };
      g.n++;
      if (r.articleId) g.articles.add(r.articleId);
      if (r.siteId) g.sites.add(r.siteId);
      if (r.createdAt < g.first) g.first = r.createdAt;
      if (r.createdAt > g.last) {
        g.last = r.createdAt;
        g.example = r.message;
        g.lastArticle = r.article ? { id: r.article.id, keyword: r.article.keyword, status: r.article.status } : g.lastArticle;
      }
      if (r.article?.status === "FAILED") g.failed++;
      groups.set(r.signature, g);
    }
    const list = [...groups.values()].sort((a, b) => b.last.getTime() - a.last.getTime());

    return (
      <>
        {header}
        <div className="space-y-4">
          <Card title="Горит сейчас (последний час)" description="Сравнение с предыдущим часом: если ошибка растёт — это поломка, сообщите разработчику.">
            {hot.length === 0 ? (
              <p className="help">За последний час новых ошибок нет.</p>
            ) : (
              <ul className="space-y-1 text-[14px]">
                {hot.map((h, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <Badge tone={h.now > h.prev ? "danger" : "warn"}>{h.now} за час</Badge>
                    <span className="help">было {h.prev}</span>
                    <span className="font-medium">{h.title}</span>
                    <span className="help">· {stageLabel(h.stage)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {list.length === 0 ? (
            <Empty title="Неустранённых ошибок нет" hint={`За ${days} дн. по выбранным сайтам.`} />
          ) : (
            <Card title={`Группы ошибок · ${list.length}`} description="Одна строка — одна сигнатура (текст без чисел и id). «Устранено» скрывает группу; «Вернуть в работу» ставит статьи группы со статусом «Ошибка» обратно в очередь с текущего этапа.">
              <div className="space-y-3">
                {list.map((g) => {
                  const ex = explain(g.example);
                  return (
                    <div key={g.signature} className="rounded-xl border border-line p-3">
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="danger">{g.n}</Badge>
                            <Badge>{stageLabel(g.stage)}</Badge>
                            {ex && <Badge tone={ex.kind === "bug" ? "warn" : "neutral"}>{ex.kind === "bug" ? "поломка" : "внешняя причина"}</Badge>}
                            <span className="font-medium">{ex?.title ?? g.signature.replace(/^[^:]+:\s*/, "").slice(0, 140)}</span>
                          </div>
                          <div className="help mt-1 whitespace-pre-wrap break-words">{g.example.slice(0, 500)}</div>
                          {ex && <div className="help mt-1"><b>Что делать:</b> {ex.hint}</div>}
                          <div className="help mt-1">
                            статей: {g.articles.size} · сайтов: {g.sites.size} · {fmtDate(g.first)} — {fmtDate(g.last)}
                            {g.lastArticle && (
                              <>
                                {" · последняя: "}
                                <Link href={`/pinterest/articles/articles/${g.lastArticle.id}`} className="underline">{g.lastArticle.keyword}</Link>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <ActionForm action={requeueErrorGroupAction} hidden={{ signature: g.signature, siteId: siteId ?? "", days: String(days) }} className="inline">
                            <SubmitButton className="btn-primary btn-sm" pendingText="…">Вернуть в работу{g.failed ? ` (${g.failed})` : ""}</SubmitButton>
                          </ActionForm>
                          <ActionForm action={resolveErrorGroupAction} hidden={{ signature: g.signature, siteId: siteId ?? "", days: String(days) }} className="inline">
                            <SubmitButton className="btn-ghost btn-sm" pendingText="…">Устранено</SubmitButton>
                          </ActionForm>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      </>
    );
  }

  /* ───────── Вызовы ИИ ───────── */
  if (tab === "ai") {
    const project = await prisma.project.findUnique({ where: { slug: PROJECT_SLUG }, select: { id: true } });
    let refIds: string[] | null = null;
    if (articleId) refIds = [articleId];
    else if (siteId) refIds = (await prisma.article.findMany({ where: { ...(await articleWhere(me)), siteId, updatedAt: { gte: since } }, select: { id: true }, take: 2000 })).map((a) => a.id);
    else if (me.role !== "ADMIN") refIds = (await prisma.article.findMany({ where: { ...(await articleWhere(me)), updatedAt: { gte: since } }, select: { id: true }, take: 5000 })).map((a) => a.id);
    const logs = project
      ? await prisma.usageLog.findMany({
          where: { projectId: project.id, createdAt: { gte: since }, ...(refIds ? { refId: { in: refIds } } : {}) },
          orderBy: { createdAt: "desc" },
          take: 300,
          include: { provider: { select: { name: true } }, model: { select: { name: true, modelId: true } }, slot: { select: { key: true, name: true } }, user: { select: { name: true } } },
        })
      : [];
    const artIds = [...new Set(logs.map((l) => l.refId).filter((x): x is string => !!x))];
    const arts = artIds.length ? await prisma.article.findMany({ where: { id: { in: artIds } }, select: { id: true, keyword: true, site: { select: { name: true } } } }) : [];
    const totalCost = logs.reduce((a, l) => a + (l.costUsd ?? 0), 0);
    const failed = logs.filter((l) => !l.ok).length;
    return (
      <>
        {header}
        <Card title={`Вызовы ИИ · ${logs.length}${logs.length === 300 ? "+" : ""}`} description={`${articleId ? "Фильтр по статье. " : ""}За ${days} дн.: ${fmtMoney(totalCost)}, ошибок ${failed}.`} actions={articleId ? <Link href={qs({ article: undefined })} className="btn-ghost btn-sm">Снять фильтр статьи</Link> : null}>
          {!project ? (
            <p className="help">Проект «articles» не найден в портале — выполните seed.</p>
          ) : logs.length === 0 ? (
            <p className="help">Вызовов за период нет.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Когда</th>
                    <th>Статья</th>
                    <th>Слот</th>
                    <th>Провайдер · модель</th>
                    <th>Токены</th>
                    <th>Время</th>
                    <th>Стоимость</th>
                    <th>Итог</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => {
                    const a = arts.find((x) => x.id === l.refId);
                    return (
                      <tr key={l.id}>
                        <td className="whitespace-nowrap">{fmtDate(l.createdAt)}</td>
                        <td className="max-w-xs">
                          {a ? (
                            <>
                              <Link href={`/pinterest/articles/articles/${a.id}`} className="hover:underline">{a.keyword}</Link>
                              <div className="help">{a.site.name} · <Link href={qs({ article: a.id })} className="underline">только эта</Link></div>
                            </>
                          ) : (
                            <span className="help">{l.refId ? l.refId.slice(0, 8) : "—"}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap">{l.slot?.name ?? l.slot?.key ?? "—"}</td>
                        <td className="whitespace-nowrap">{l.provider.name}{l.model ? ` · ${l.model.modelId}` : ""}</td>
                        <td className="whitespace-nowrap help">{l.inputTokens.toLocaleString("ru-RU")} / {l.outputTokens.toLocaleString("ru-RU")}</td>
                        <td className="whitespace-nowrap help">{(l.durationMs / 1000).toFixed(1)} с</td>
                        <td className="whitespace-nowrap">{canCosts ? fmtMoney(l.costUsd) : "—"}</td>
                        <td>{l.ok ? <Badge tone="ok">ок</Badge> : <span title={l.error ?? ""}><Badge tone="danger">ошибка</Badge></span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </>
    );
  }

  /* ───────── Расходы ───────── */
  if (!canCosts) {
    return (
      <>
        {header}
        <Empty title="Расходы скрыты" hint="Нужно право «Расход: команда» или «все» — попросите администратора." />
      </>
    );
  }
  const aWhere = { ...(await articleWhere(me)), ...(siteId ? { siteId } : {}) };
  const [stageRows, articleTotals] = await Promise.all([
    prisma.artStageLog.findMany({ where: { startedAt: { gte: since }, costUsd: { gt: 0 }, article: aWhere }, select: { stage: true, costUsd: true, article: { select: { siteId: true } } }, take: 20000 }),
    prisma.article.groupBy({ by: ["siteId"], where: { ...aWhere, createdAt: { gte: since } }, _sum: { costUsd: true }, _count: { _all: true } }),
  ]);
  const stages = [...new Set(stageRows.map((r) => r.stage))];
  const matrix = new Map<string, Map<string, number>>();
  for (const r of stageRows) {
    const m = matrix.get(r.article.siteId) ?? new Map<string, number>();
    m.set(r.stage, (m.get(r.stage) ?? 0) + r.costUsd);
    matrix.set(r.article.siteId, m);
  }
  const siteRows = [...new Set([...matrix.keys(), ...articleTotals.map((t) => t.siteId)])].map((sid) => ({ id: sid, name: sites.find((s) => s.id === sid)?.name ?? sid.slice(0, 8), byStage: matrix.get(sid) ?? new Map<string, number>(), articles: articleTotals.find((t) => t.siteId === sid)?._count._all ?? 0, total: articleTotals.find((t) => t.siteId === sid)?._sum.costUsd ?? 0 }));
  const grand = siteRows.reduce((a, s) => a + s.total, 0);
  const stageTotal = (st: string) => siteRows.reduce((a, s) => a + (s.byStage.get(st) ?? 0), 0);
  return (
    <>
      {header}
      <Card title={`Расходы за ${days} дн. · ${fmtMoney(grand)}`} description="По этапам — из журнала этапов (ArtStageLog.costUsd); «Всего» — по статьям, созданным за период (Article.costUsd).">
        {siteRows.length === 0 ? (
          <p className="help">Расходов за период нет.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Сайт</th>
                  <th>Статей</th>
                  {stages.map((s) => <th key={s} className="whitespace-nowrap">{stageLabel(s)}</th>)}
                  <th>Всего</th>
                </tr>
              </thead>
              <tbody>
                {siteRows.map((s) => (
                  <tr key={s.id}>
                    <td className="font-medium">{s.name}</td>
                    <td>{s.articles}</td>
                    {stages.map((st) => <td key={st} className="whitespace-nowrap">{s.byStage.get(st) ? fmtMoney(s.byStage.get(st)) : <span className="text-muted">—</span>}</td>)}
                    <td className="font-semibold whitespace-nowrap">{fmtMoney(s.total)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="font-semibold">Итого</td>
                  <td className="font-semibold">{siteRows.reduce((a, s) => a + s.articles, 0)}</td>
                  {stages.map((st) => <td key={st} className="font-semibold whitespace-nowrap">{fmtMoney(stageTotal(st))}</td>)}
                  <td className="font-semibold whitespace-nowrap">{fmtMoney(grand)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
