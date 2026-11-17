import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { NewsNav } from "@/components/news/NewsNav";
import { addSource, updateSource } from "@/actions/news";
import { canManageProject, requireProject } from "@/lib/news/access";
import { discoverFeeds, activeProxies } from "@/lib/news/sources";
import { agoText, fmtKyiv } from "@/lib/news/query";
import { BASE_PATH, SOURCE_KIND_LABELS, TIER_LABELS, parseSettings } from "@/lib/news/types";

export const dynamic = "force-dynamic";

type Row = Awaited<ReturnType<typeof prisma.newsSource.findMany>>[number];
const joinList = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");

export default async function NewsSourcesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const { project, list } = await requireProject(me, sp(q, "project"));
  if (!project) return <Empty title="Проектов пока нет" hint="Создайте проект в настройках." action={<Link href={`${BASE_PATH}/settings`} className="btn-brand">Настройки</Link>} />;
  const manage = canManageProject(me, project);
  const s = parseSettings(project.settings);
  const discover = sp(q, "discover")?.trim();
  const [rows, counts, found] = await Promise.all([
    prisma.newsSource.findMany({ where: { projectId: project.id }, orderBy: [{ isActive: "desc" }, { tier: "asc" }, { weight: "desc" }, { name: "asc" }] }),
    prisma.newsItem.groupBy({ by: ["sourceId", "status"], where: { projectId: project.id, foundAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: { _all: true } }),
    discover && manage ? discoverFeeds(discover, await activeProxies()) : Promise.resolve(null),
  ]);
  const editing = rows.find((r) => r.id === sp(q, "edit")) ?? null;
  const week = (id: string) => {
    const mine = counts.filter((c) => c.sourceId === id);
    const all = mine.reduce((a, c) => a + c._count._all, 0);
    const passed = mine.filter((c) => c.status === "classified" || c.status === "queued").reduce((a, c) => a + c._count._all, 0);
    return { all, passed };
  };
  const health = (r: Row) => {
    if (!r.isActive) return { tone: "neutral" as const, text: "выключен" };
    if (r.errorStreak >= 3) return { tone: "danger" as const, text: `ошибка ${r.errorStreak} раза подряд` };
    if (r.lastError) return { tone: "warn" as const, text: "ошибка в последний раз" };
    if (!r.lastFetchAt) return { tone: "neutral" as const, text: "ещё не опрашивался" };
    if (r.kind !== "trends" && (!r.lastNewAt || Date.now() - r.lastNewAt.getTime() > 48 * 3600_000)) return { tone: "warn" as const, text: "48 ч без новых — проверить" };
    return { tone: "ok" as const, text: "работает" };
  };
  const groups = [
    { title: "Сайты: украинские медиа и первоисточники", rows: rows.filter((r) => (r.kind === "rss" || r.kind === "sitemap") && r.tier !== "world") },
    { title: "Google News и Trends", rows: rows.filter((r) => r.kind.startsWith("gnews") || r.kind === "trends") },
    { title: "Мировые медиа (ранний сигнал «ещё нет в UA»)", rows: rows.filter((r) => r.tier === "world" && !r.kind.startsWith("gnews")) },
  ];

  return (
    <>
      <NewsNav projects={list.map((p) => ({ id: p.id, name: p.name }))} current={project.id} />
      <PageHeader
        title="Источники"
        subtitle={`Ленты сайтов, запросы Google News и Trends. Большие СМИ берутся только своими рубриками: фильтр «оставить рубрики» или «оставить адреса». Плюс каждый прогон: ${s.gnewsQueries.length} нишевых запросов Google News и запросы по сущностям (настраиваются в «Настройках»).`}
      />

      {manage && (
        <div className="mb-5 grid gap-4 lg:grid-cols-2">
          <Card title="Найти ленты сайта" description="Модуль проверит главную (ссылки на RSS), /feed, /rss, news-sitemap и покажет, что работает и насколько свежее.">
            <form method="get" className="flex flex-wrap gap-2">
              <input type="hidden" name="project" value={project.id} />
              <input name="discover" defaultValue={discover ?? ""} className="input min-w-0 flex-1" placeholder="vogue.ua или https://site.ua/showbiz/" />
              <button className="btn-primary">Проверить</button>
            </form>
            {found && (
              <div className="mt-3 space-y-2">
                {found.error && <p className="help text-warn">{found.error}</p>}
                {found.found.length === 0 ? <p className="help">Работающих лент не найдено. Можно добавить сайт как запрос Google News: <code>site:{discover?.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</code>.</p> : found.found.map((f) => (
                  <ActionForm key={f.url} action={addSource} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2" hidden={{ project: project.id, kind: f.kind, url: f.url, name: f.title || f.url, tier: "competitor", weight: "1" }}>
                    <div className="min-w-0 flex-1 text-[14px]">
                      <div className="truncate font-medium">{f.title || f.url}</div>
                      <div className="help truncate">{f.url} · {f.kind === "sitemap" ? "news-sitemap" : "RSS"} · {f.items} материалов · свежий {agoText(f.newest)}</div>
                    </div>
                    <SubmitButton className="btn-primary btn-sm" pendingText="…">Добавить</SubmitButton>
                  </ActionForm>
                ))}
              </div>
            )}
          </Card>
          <Card title="Добавить источник вручную">
            <SourceForm projectId={project.id} />
          </Card>
        </div>
      )}

      {editing && manage && (
        <div id="edit" className="mb-5">
          <Card
            title={`Источник: ${editing.name}`}
            description="«Проверить сейчас» скачивает ленту и показывает, сколько в ней материалов и насколько они свежие, — без записи в базу."
            actions={
              <>
                <ActionForm action={updateSource} className="inline" hidden={{ id: editing.id, op: "test" }}><SubmitButton className="btn-primary btn-sm" pendingText="Проверяю…">Проверить сейчас</SubmitButton></ActionForm>
                <ActionForm action={updateSource} className="inline" hidden={{ id: editing.id, op: "toggle" }}><SubmitButton className="btn-ghost btn-sm" pendingText="…">{editing.isActive ? "Выключить" : "Включить"}</SubmitButton></ActionForm>
                <ActionForm action={updateSource} className="inline" hidden={{ id: editing.id, op: "delete" }}><SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…" confirm={`Удалить источник «${editing.name}»?`}>Удалить</SubmitButton></ActionForm>
                <Link href={`${BASE_PATH}/sources?project=${project.id}`} className="btn-ghost btn-sm">Закрыть</Link>
              </>
            }
          >
            <SourceForm projectId={project.id} row={editing} />
          </Card>
        </div>
      )}

      <div className="space-y-5">
        {groups.map((g) => (
          <Card key={g.title} title={`${g.title} (${g.rows.length})`}>
            {g.rows.length === 0 ? <p className="help">Нет источников.</p> : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Источник</th>
                      <th className="col-sm">Вес</th>
                      <th>Состояние</th>
                      <th className="col-md">За 7 дней</th>
                      <th className="col-sm"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r) => {
                      const h = health(r);
                      const w = week(r.id);
                      const ls = (r.lastStats ?? {}) as { items?: number; fresh?: number; passed?: number; proxy?: boolean };
                      return (
                        <tr key={r.id} className={r.isActive ? "" : "opacity-60"}>
                          <td className="max-w-[420px]">
                            <div className="font-medium">{r.name} {r.profile && <Badge tone="brand">профильный</Badge>} {r.viaProxy && <Badge>прокси</Badge>}</div>
                            <div className="help truncate">{SOURCE_KIND_LABELS[r.kind] ?? r.kind} · {TIER_LABELS[r.tier] ?? r.tier} · {r.url}</div>
                            {(joinList(r.includeCats) || joinList(r.includeUrls) || joinList(r.excludeCats)) && (
                              <div className="help truncate">
                                {joinList(r.includeCats) && `рубрики: ${joinList(r.includeCats)} `}{joinList(r.includeUrls) && `адреса: ${joinList(r.includeUrls)} `}{joinList(r.excludeCats) && `кроме: ${joinList(r.excludeCats)}`}
                              </div>
                            )}
                          </td>
                          <td className="col-sm tabular-nums">{r.weight}</td>
                          <td>
                            <Badge tone={h.tone}>{h.text}</Badge>
                            <div className="help mt-0.5">
                              {r.lastFetchAt ? `опрос ${agoText(r.lastFetchAt)}` : ""}{ls.items != null ? ` · в ленте ${ls.items}, новых ${ls.fresh ?? 0}, прошло ${ls.passed ?? 0}` : ""}{ls.proxy ? " · через прокси" : ""}
                            </div>
                            {r.lastError && <div className="help line-clamp-2 text-danger">{r.lastError}</div>}
                          </td>
                          <td className="col-md help whitespace-nowrap">{w.all} собрано · {w.passed} прошло{r.lastNewAt ? ` · новое ${fmtKyiv(r.lastNewAt)}` : ""}</td>
                          <td className="col-sm whitespace-nowrap text-right">
                            {manage && <Link href={`${BASE_PATH}/sources?project=${project.id}&edit=${r.id}#edit`} className="btn-ghost btn-sm">Изменить</Link>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}

function SourceForm({ projectId, row }: { projectId: string; row?: Row }) {
  return (
    <ActionForm action={row ? updateSource : addSource} className="grid gap-2 sm:grid-cols-2" hidden={row ? { id: row.id, op: "save" } : { project: projectId }}>
      <label className="block sm:col-span-2"><span className="label">Адрес ленты или запрос Google News</span><input name="url" className="input" defaultValue={row?.url} placeholder="https://site.ua/rss или site:vogue.ua" /></label>
      <label className="block"><span className="label">Название</span><input name="name" className="input" defaultValue={row?.name} /></label>
      <label className="block"><span className="label">Тип</span>
        <select name="kind" className="input" defaultValue={row?.kind ?? "rss"}>{Object.entries(SOURCE_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>
      <label className="block"><span className="label">Ярус</span>
        <select name="tier" className="input" defaultValue={row?.tier ?? "competitor"}>{Object.entries(TIER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </label>
      <label className="block"><span className="label">Вес 0.3–2.0</span><input name="weight" className="input" defaultValue={row?.weight ?? 1} /></label>
      <label className="block sm:col-span-2"><span className="label">Оставить только рубрики (через запятую, часть названия)</span><input name="includeCats" className="input" defaultValue={joinList(row?.includeCats)} placeholder="зірки, стиль, шоу" /></label>
      <label className="block"><span className="label">Убрать рубрики</span><input name="excludeCats" className="input" defaultValue={joinList(row?.excludeCats)} placeholder="гороскоп" /></label>
      <label className="block"><span className="label">Оставить адреса (часть URL)</span><input name="includeUrls" className="input" defaultValue={joinList(row?.includeUrls)} placeholder="showbiz., /lady/" /></label>
      <label className="block"><span className="label">Интервал, мин (пусто — как у проекта)</span><input name="intervalMin" className="input" defaultValue={row?.intervalMin ?? ""} /></label>
      <label className="block"><span className="label">Язык</span><input name="lang" className="input" defaultValue={row?.lang ?? ""} placeholder="uk / en" /></label>
      <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="profile" defaultChecked={row?.profile ?? false} /> Профильный (без проверки нишевых слов)</label>
      <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="viaProxy" defaultChecked={row?.viaProxy ?? false} /> Всегда через прокси</label>
      <div className="sm:col-span-2"><SubmitButton className="btn-brand" pendingText="Сохраняю…">{row ? "Сохранить" : "Добавить источник"}</SubmitButton></div>
    </ActionForm>
  );
}
