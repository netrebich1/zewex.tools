import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { NewsNav } from "@/components/news/NewsNav";
import { addEntities } from "@/actions/news";
import { canManageProject, requireProject } from "@/lib/news/access";
import { BASE_PATH } from "@/lib/news/types";

export const dynamic = "force-dynamic";

/** Рейтинг из scripts/news/views-analyze.ts (NewsProject.viewsReport), обновляется раз в неделю deploy/news-views.sh. */
type Origin = "ua" | "world" | null;
type Stat = { articles: number; views: number; avg: number; index: number };
type Person = Stat & { rank: number; name: string; kind: string; origin: Origin; entityId: string | null; tracked: boolean; sites: Record<string, { n: number; v: number }>; events: { label: string; n: number }[]; top: { title: string; url: string; site: string; views: number } | null };
type Report = {
  period: string; articles: number; sites: { site: string; articles: number; median: number }[]; people: Person[];
  events: (Stat & { code: string; label: string; ua?: Stat; world?: Stat })[];
  topArticles: { site: string; title: string; url: string; views: number; index?: number; event: string; origin?: Origin; persons: string[] }[];
};

const TABS = { top: "Топ-50: все", ua: "Украинские", world: "Иностранные", events: "События", articles: "Лучшие статьи" } as const;
const KINDS: Record<string, string> = { ua_star: "звезда", world_star: "звезда", ua_blogger: "блогер", world_blogger: "блогер", royal: "королевская семья", sport: "спорт", other: "" };
/** Группа новой сущности по типу из рейтинга. */
const GRP: Record<string, string> = { ua_star: "ua_second", ua_blogger: "ua_blogger", world_star: "world", world_blogger: "world_blogger", royal: "royal", sport: "sport" };
const fmtN = (n: number) => n.toLocaleString("ru-RU");
const sitesText = (p: Person) => Object.entries(p.sites).sort((a, b) => b[1].v - a[1].v).map(([k, x]) => `${k}: ${x.n} ст., ${fmtN(x.v)}`).join(" · ");
const OriginBadge = ({ o }: { o: Origin }) => (o === "ua" ? <span className="badge bg-info-soft text-info">UA</span> : o === "world" ? <span className="badge bg-ink/5 text-ink-2">EN</span> : null);

export default async function NewsViewsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const { project, list } = await requireProject(me, sp(q, "project"));
  if (!project) return <Empty title="Проектов пока нет" hint="Создайте проект в настройках." action={<Link href={`${BASE_PATH}/settings`} className="btn-brand">Настройки</Link>} />;
  const manage = canManageProject(me, project);
  const stored = await prisma.newsProject.findUnique({ where: { id: project.id }, select: { viewsReport: true, viewsReportAt: true } });
  const r = (stored?.viewsReport ?? null) as Report | null;
  const tab = (Object.keys(TABS).includes(sp(q, "tab") ?? "") ? sp(q, "tab") : "top") as keyof typeof TABS;
  const sort = sp(q, "sort") === "index" ? "index" : "views";
  const link = (t: string, s = sort) => `${BASE_PATH}/views?project=${project.id}&tab=${t}${s === "index" ? "&sort=index" : ""}`;

  // Политиков в рейтинге звёзд не показываем: о них пишут не из-за шоубиза.
  const people = (r?.people ?? []).filter((p) => p.kind !== "politic").sort((a, b) => (sort === "index" ? b.index - a.index : b.views - a.views));
  const shown = tab === "top" ? people.slice(0, 50) : tab === "ua" ? people.filter((p) => p.origin === "ua") : tab === "world" ? people.filter((p) => p.origin === "world") : [];
  const count = { ua: people.filter((p) => p.origin === "ua").length, world: people.filter((p) => p.origin === "world").length };
  const sum = (o: "ua" | "world") => people.filter((p) => p.origin === o).reduce((x, p) => x + p.views, 0);

  return (
    <>
      <NewsNav projects={list.map((p) => ({ id: p.id, name: p.name }))} current={project.id} />
      <PageHeader
        title="Просмотры у конкурентов"
        subtitle={r ? `За ${r.period}: ${fmtN(r.articles)} статей о звёздах на ${r.sites.length} сайтах с открытыми счётчиками. Обновлено ${stored?.viewsReportAt?.toLocaleDateString("ru-RU", { timeZone: "Europe/Kyiv" })}, дальше — автоматически каждый понедельник утром за последние 30 дней.` : "Рейтинг ещё не посчитан."}
      />
      {!r ? <Empty title="Рейтинга пока нет" hint="Он считается автоматически каждый понедельник утром." /> : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {Object.entries(TABS).map(([k, label]) => (
              <Link key={k} href={link(k)} className={`tab ${tab === k ? "active" : ""}`}>
                {label}{k === "ua" ? ` (${count.ua})` : k === "world" ? ` (${count.world})` : ""}
              </Link>
            ))}
            {["top", "ua", "world"].includes(tab) && (
              <span className="ml-auto flex items-center gap-1.5 text-[13px] text-muted">
                Сортировать:
                <Link href={link(tab, "views")} className={`tab ${sort === "views" ? "active" : ""}`}>по просмотрам</Link>
                <Link href={link(tab, "index")} className={`tab ${sort === "index" ? "active" : ""}`}>по индексу</Link>
              </span>
            )}
          </div>

          {["top", "ua", "world"].includes(tab) && (
            <Card
              title={tab === "top" ? "50 персон с наибольшими просмотрами" : tab === "ua" ? `Украинские звёзды и блогеры — ${fmtN(sum("ua"))} просмотров` : `Иностранные звёзды в украинских СМИ — ${fmtN(sum("world"))} просмотров`}
              description="Просмотры — сумма по статьям о человеке. Индекс учитывает, что сайты разного масштаба: каждая статья сравнивается со средней статьёй своего сайта (1 — как обычная статья, 3 — втрое сильнее), и это складывается. Индекс честнее показывает интерес, просмотры — объём. «Не отслеживаем» — человека нет в «Сущностях»: кнопка «В сущности» добавит его в мониторинг."
            >
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th className="col-sm">#</th><th>Персона</th><th className="col-sm">Статей</th><th className="col-sm">Просмотров</th><th className="col-sm">В среднем</th><th className="col-sm">Индекс</th><th className="col-md">О чём пишут</th><th className="col-md">Лучшая статья</th></tr></thead>
                  <tbody>
                    {shown.map((p, i) => (
                      <tr key={`${p.name}-${p.rank}`}>
                        <td className="col-sm tabular-nums text-muted">{i + 1}</td>
                        <td>
                          <span className="font-medium">{p.name}</span> {tab === "top" && <OriginBadge o={p.origin} />} <span className="help">{KINDS[p.kind] ?? ""}</span>{" "}
                          {p.tracked ? null : manage ? (
                            <ActionForm action={addEntities} hidden={{ project: project.id, lines: `${p.name} | person | 1.3 | ${p.name} | ${GRP[p.kind] ?? (p.origin === "ua" ? "ua_second" : "world")}` }} className="inline">
                              <SubmitButton className="btn-ghost btn-sm" pendingText="Добавляю…">В сущности</SubmitButton>
                            </ActionForm>
                          ) : <Badge>не отслеживаем</Badge>}
                          <div className="help">{sitesText(p)}</div>
                        </td>
                        <td className="col-sm tabular-nums">{p.articles}</td>
                        <td className="col-sm tabular-nums font-medium">{fmtN(p.views)}</td>
                        <td className="col-sm tabular-nums">{fmtN(p.avg)}</td>
                        <td className="col-sm tabular-nums">{p.index}</td>
                        <td className="col-md help">{p.events.map((e) => `${e.label} (${e.n})`).join(", ")}</td>
                        <td className="col-md help max-w-[320px]">{p.top ? <><a href={p.top.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 hover:underline">{p.top.title}</a><span>{p.top.site}, {fmtN(p.top.views)}</span></> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {tab === "events" && (
            <Card
              title="Какие события собирают просмотры"
              description="Индекс — во сколько раз статья такого типа сильнее средней статьи того же сайта (1 — обычная статья). Отдельно — статьи об украинцах и об иностранцах. Тип события модель определяет по заголовку."
            >
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Событие</th><th className="col-sm">Индекс</th><th className="col-sm">Статей</th><th className="col-sm">В среднем</th><th className="col-sm">Украинцы: индекс / статей</th><th className="col-sm">Иностранцы: индекс / статей</th></tr></thead>
                  <tbody>
                    {r.events.filter((e) => e.articles).map((e) => (
                      <tr key={e.code}>
                        <td className="font-medium">{e.label}</td>
                        <td className="col-sm tabular-nums font-medium">{e.index}</td>
                        <td className="col-sm tabular-nums">{e.articles}</td>
                        <td className="col-sm tabular-nums">{fmtN(e.avg)}</td>
                        <td className="col-sm tabular-nums">{e.ua?.articles ? `${e.ua.index} / ${e.ua.articles}` : "—"}</td>
                        <td className="col-sm tabular-nums">{e.world?.articles ? `${e.world.index} / ${e.world.articles}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {tab === "articles" && (
            <Card title="Самые сильные статьи месяца" description="Отобраны по индексу: насколько статья обогнала среднюю статью своего сайта.">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th className="col-sm">#</th><th>Статья</th><th className="col-sm">Просмотров</th><th className="col-sm">Индекс</th><th className="col-md">Событие</th></tr></thead>
                  <tbody>
                    {r.topArticles.map((a, i) => (
                      <tr key={a.url}>
                        <td className="col-sm tabular-nums text-muted">{i + 1}</td>
                        <td><a href={a.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{a.title}</a> {a.origin !== undefined && <OriginBadge o={a.origin} />}<div className="help">{a.site}{a.persons.length ? ` · ${a.persons.join(", ")}` : ""}</div></td>
                        <td className="col-sm tabular-nums font-medium">{fmtN(a.views)}</td>
                        <td className="col-sm tabular-nums">{a.index ?? "—"}</td>
                        <td className="col-md help">{a.event}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <p className="help mt-4">Сайты: {r.sites.map((s) => `${s.site} — ${fmtN(s.articles)} статей, средняя ${fmtN(s.median)} просм.`).join("; ")}. Viva, Obozrevatel, Фокус и иностранные сайты не показывают просмотры, их здесь нет. Lux FM у части статей прячет счётчик: такие статьи посчитаны, просмотры нет. Свежие статьи ещё добирают просмотры.</p>
        </>
      )}
    </>
  );
}
