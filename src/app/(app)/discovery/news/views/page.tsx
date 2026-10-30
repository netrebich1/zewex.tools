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

/** Рейтинг по месяцам из scripts/news/views-analyze.ts (NewsViewsMonth), считается 1-го числа deploy/news-views.sh. */
type Origin = "ua" | "world" | null;
type Stat = { articles: number; views: number; avg: number; index: number };
type Person = Stat & { rank: number; name: string; kind: string; origin: Origin; entityId: string | null; tracked: boolean; sites: Record<string, { n: number; v: number }>; events: { label: string; n: number }[]; top: { title: string; url: string; site: string; views: number } | null };
type Report = {
  month?: string; period: string; articles: number; sites: { site: string; articles: number; median: number }[]; people: Person[];
  events: (Stat & { code: string; label: string; ua?: Stat; world?: Stat })[];
  topArticles: { site: string; title: string; url: string; views: number; index?: number; event: string; origin?: Origin; persons: string[] }[];
};

const TABS = { top: "Топ-50: все", ua: "Украинские", world: "Иностранные", new: "Новые", up: "Растут", down: "Падают", events: "События", articles: "Лучшие статьи" } as const;
type Tab = keyof typeof TABS;
const KINDS: Record<string, string> = { ua_star: "звезда", world_star: "звезда", ua_blogger: "блогер", world_blogger: "блогер", royal: "королевская семья", sport: "спорт", other: "" };
/** Группа новой сущности по типу из рейтинга. */
const GRP: Record<string, string> = { ua_star: "ua_second", ua_blogger: "ua_blogger", world_star: "world", world_blogger: "world_blogger", royal: "royal", sport: "sport" };
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
const fmtN = (n: number) => n.toLocaleString("ru-RU");
const sitesText = (p: Person) => Object.entries(p.sites).sort((a, b) => b[1].v - a[1].v).map(([k, x]) => `${k}: ${x.n} ст., ${fmtN(x.v)}`).join(" · ");
/** Один человек в разных месяцах: наша сущность или имя. */
const keyOf = (p: Person) => p.entityId ?? p.name.toLowerCase();
const OriginBadge = ({ o }: { o: Origin }) => (o === "ua" ? <span className="badge bg-info-soft text-info">UA</span> : o === "world" ? <span className="badge bg-ink/5 text-ink-2">EN</span> : null);
/** Рост: индекс (просмотры относительно средней статьи сайта) вырос в полтора раза и минимум на 3 «средние статьи». */
const rising = (p: Person, was?: Person) => !!was && p.index >= was.index * 1.5 && p.index - was.index >= 3;
const falling = (p: Person, was?: Person) => !!was && p.index <= was.index / 2 && was.index - p.index >= 3;

function Change({ p, was }: { p: Person; was?: Person }) {
  if (!was) return <Badge tone="brand">новый</Badge>;
  const d = was.views ? Math.round(((p.views - was.views) / was.views) * 100) : 0;
  return (
    <span className="whitespace-nowrap">
      <span className={d > 0 ? "text-ok" : d < 0 ? "text-danger" : ""}>{d > 0 ? "▲" : d < 0 ? "▼" : ""} {d > 0 ? "+" : ""}{d}%</span>
      <div className="help">было {fmtN(was.views)}, #{was.rank}</div>
    </span>
  );
}

export default async function NewsViewsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const { project, list } = await requireProject(me, sp(q, "project"));
  if (!project) return <Empty title="Проектов пока нет" hint="Создайте проект в настройках." action={<Link href={`${BASE_PATH}/settings`} className="btn-brand">Настройки</Link>} />;
  const manage = canManageProject(me, project);
  const months = await prisma.newsViewsMonth.findMany({ where: { projectId: project.id }, orderBy: { month: "desc" }, select: { month: true, updatedAt: true } });
  const month = months.find((m) => m.month === sp(q, "m"))?.month ?? months[0]?.month;
  const prevMonth = months.find((m) => month && m.month < month)?.month;
  const [cur, prev] = await Promise.all([
    month ? prisma.newsViewsMonth.findUnique({ where: { projectId_month: { projectId: project.id, month } } }) : null,
    prevMonth ? prisma.newsViewsMonth.findUnique({ where: { projectId_month: { projectId: project.id, month: prevMonth } } }) : null,
  ]);
  const r = (cur?.data ?? null) as Report | null;
  const pr = (prev?.data ?? null) as Report | null;
  const tab = (Object.keys(TABS).includes(sp(q, "tab") ?? "") ? sp(q, "tab") : "top") as Tab;
  const sort = sp(q, "sort") === "index" ? "index" : "views";
  const link = (patch: { tab?: string; sort?: string; m?: string }) => {
    const u = new URLSearchParams({ project: project.id, tab: patch.tab ?? tab });
    const s = patch.sort ?? sort;
    if (s === "index") u.set("sort", "index");
    const m = patch.m ?? month;
    if (m && m !== months[0]?.month) u.set("m", m);
    return `${BASE_PATH}/views?${u.toString()}`;
  };

  // Политиков в рейтинге звёзд не показываем: о них пишут не из-за шоубиза.
  const stars = (x: Report | null) => (x?.people ?? []).filter((p) => p.kind !== "politic");
  const people = stars(r).sort((a, b) => (sort === "index" ? b.index - a.index : b.views - a.views));
  const before = new Map(stars(pr).map((p) => [keyOf(p), p]));
  const nowKeys = new Set(people.map(keyOf));
  const was = (p: Person) => before.get(keyOf(p));
  const lists: Record<string, Person[]> = {
    top: people.slice(0, 50),
    ua: people.filter((p) => p.origin === "ua"),
    world: people.filter((p) => p.origin === "world"),
    new: pr ? people.filter((p) => !was(p)) : [],
    up: people.filter((p) => rising(p, was(p))).sort((a, b) => b.index - was(b)!.index - (a.index - was(a)!.index)),
    down: people.filter((p) => falling(p, was(p))).sort((a, b) => a.index - was(a)!.index - (b.index - was(b)!.index)),
  };
  const gone = pr ? stars(pr).filter((p) => !nowKeys.has(keyOf(p)) && p.articles >= 5).slice(0, 30) : [];
  const shown = lists[tab] ?? [];
  const count = (t: Tab) => (["ua", "world", "new", "up", "down"].includes(t) && lists[t] ? ` (${lists[t].length})` : "");
  const sum = (o: "ua" | "world") => people.filter((p) => p.origin === o).reduce((x, p) => x + p.views, 0);
  const TITLES: Record<string, string> = {
    top: "50 персон с наибольшими просмотрами",
    ua: `Украинские звёзды и блогеры — ${fmtN(sum("ua"))} просмотров`,
    world: `Иностранные звёзды в украинских СМИ — ${fmtN(sum("world"))} просмотров`,
    new: `Новые: о них не писали в ${prevMonth ? monthName(prevMonth) : "прошлом месяце"} (меньше двух статей)`,
    up: "Резко выросли: индекс в полтора раза выше прошлого месяца",
    down: "Резко упали: индекс вдвое ниже прошлого месяца",
  };

  return (
    <>
      <NewsNav projects={list.map((p) => ({ id: p.id, name: p.name }))} current={project.id} />
      <PageHeader
        title="Просмотры у конкурентов"
        subtitle={r ? `${monthName(month!)} (${r.period}): ${fmtN(r.articles)} статей о звёздах на ${r.sites.length} сайтах с открытыми счётчиками. Новый месяц считается автоматически 1-го числа.` : "Рейтинг ещё не посчитан."}
      />
      {!r ? <Empty title="Рейтинга пока нет" hint="Он считается автоматически 1-го числа за прошлый месяц." /> : (
        <>
          {months.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[13px]">
              <span className="help">Месяц:</span>
              {months.map((m) => <Link key={m.month} href={link({ m: m.month })} className={`tab ${m.month === month ? "active" : ""}`}>{monthName(m.month)}</Link>)}
            </div>
          )}
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {(Object.entries(TABS) as [Tab, string][]).filter(([k]) => pr || !["new", "up", "down"].includes(k)).map(([k, label]) => (
              <Link key={k} href={link({ tab: k })} className={`tab ${tab === k ? "active" : ""}`}>{label}{count(k)}</Link>
            ))}
            {["top", "ua", "world", "new"].includes(tab) && (
              <span className="ml-auto flex items-center gap-1.5 text-[13px] text-muted">
                Сортировать:
                <Link href={link({ sort: "views" })} className={`tab ${sort === "views" ? "active" : ""}`}>по просмотрам</Link>
                <Link href={link({ sort: "index" })} className={`tab ${sort === "index" ? "active" : ""}`}>по индексу</Link>
              </span>
            )}
          </div>

          {tab in lists && (
            <Card
              title={TITLES[tab]}
              description={`Просмотры — сумма по статьям о человеке за месяц. Индекс учитывает, что сайты разного масштаба: каждая статья сравнивается со средней статьёй своего сайта (1 — как обычная статья, 3 — втрое сильнее), и это складывается. ${pr ? `«Было» — ${monthName(prevMonth!)}.` : ""} «В сущности» — человека нет в мониторинге, кнопка добавит.`}
            >
              {shown.length === 0 ? <p className="help">Никого.</p> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th className="col-sm">#</th><th>Персона</th><th className="col-sm">Статей</th><th className="col-sm">Просмотров</th><th className="col-sm">Индекс</th>{pr && <th className="col-sm">К прошлому месяцу</th>}<th className="col-md">О чём пишут</th><th className="col-md">Лучшая статья</th></tr></thead>
                    <tbody>
                      {shown.map((p, i) => {
                        const w = was(p);
                        return (
                          <tr key={`${p.name}-${p.rank}`}>
                            <td className="col-sm tabular-nums text-muted">{i + 1}</td>
                            <td>
                              <span className="font-medium">{p.name}</span> {["top", "new", "up", "down"].includes(tab) && <OriginBadge o={p.origin} />} <span className="help">{KINDS[p.kind] ?? ""}</span>{" "}
                              {p.tracked ? null : manage ? (
                                <ActionForm action={addEntities} hidden={{ project: project.id, lines: `${p.name} | person | 1.3 | ${p.name} | ${GRP[p.kind] ?? (p.origin === "ua" ? "ua_second" : "world")}` }} className="inline">
                                  <SubmitButton className="btn-ghost btn-sm" pendingText="Добавляю…">В сущности</SubmitButton>
                                </ActionForm>
                              ) : <Badge>не отслеживаем</Badge>}
                              <div className="help">{sitesText(p)}</div>
                            </td>
                            <td className="col-sm tabular-nums">{p.articles}{w ? <div className="help">было {w.articles}</div> : null}</td>
                            <td className="col-sm tabular-nums font-medium">{fmtN(p.views)}<div className="help">в ср. {fmtN(p.avg)}</div></td>
                            <td className="col-sm tabular-nums">{p.index}{w ? <div className="help">было {w.index}</div> : null}</td>
                            {pr && <td className="col-sm"><Change p={p} was={w} /></td>}
                            <td className="col-md help">{p.events.map((e) => `${e.label} (${e.n})`).join(", ")}</td>
                            <td className="col-md help max-w-[320px]">{p.top ? <><a href={p.top.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 hover:underline">{p.top.title}</a><span>{p.top.site}, {fmtN(p.top.views)}</span></> : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {tab === "down" && gone.length > 0 && (
                <p className="help mt-4">Пропали (в {monthName(prevMonth!)} было от 5 статей, сейчас меньше двух): {gone.map((p) => `${p.name} (${p.articles} ст., ${fmtN(p.views)})`).join(", ")}.</p>
              )}
            </Card>
          )}

          {tab === "events" && (
            <Card
              title="Какие события собирают просмотры"
              description="Индекс — во сколько раз статья такого типа сильнее средней статьи того же сайта (1 — обычная статья). Отдельно — статьи об украинцах и об иностранцах. Тип события модель определяет по заголовку."
            >
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Событие</th><th className="col-sm">Индекс</th>{pr && <th className="col-sm">Было</th>}<th className="col-sm">Статей</th><th className="col-sm">В среднем</th><th className="col-sm">Украинцы: индекс / статей</th><th className="col-sm">Иностранцы: индекс / статей</th></tr></thead>
                  <tbody>
                    {r.events.filter((e) => e.articles).map((e) => {
                      const w = pr?.events.find((x) => x.code === e.code);
                      return (
                        <tr key={e.code}>
                          <td className="font-medium">{e.label}</td>
                          <td className="col-sm tabular-nums font-medium">{e.index}</td>
                          {pr && <td className="col-sm tabular-nums help">{w ? w.index : "—"}</td>}
                          <td className="col-sm tabular-nums">{e.articles}</td>
                          <td className="col-sm tabular-nums">{fmtN(e.avg)}</td>
                          <td className="col-sm tabular-nums">{e.ua?.articles ? `${e.ua.index} / ${e.ua.articles}` : "—"}</td>
                          <td className="col-sm tabular-nums">{e.world?.articles ? `${e.world.index} / ${e.world.articles}` : "—"}</td>
                        </tr>
                      );
                    })}
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

          <p className="help mt-4">Сайты: {r.sites.map((s) => `${s.site} — ${fmtN(s.articles)} статей, средняя ${fmtN(s.median)} просм.`).join("; ")}. Берём только сайты, где число просмотров можно прочитать, не накручивая его. Табло ІД, NV и Обозреватель счётчики показывают, но закрыты защитой от серверов — для них нужен прокси. У Фокуса, Viva, RBC, Факти ICTV и иностранных сайтов открытых счётчиков нет. Lux FM и Хочу у части статей прячут счётчик: такие статьи посчитаны, просмотры нет. Просмотры сняты в момент подсчёта: статьи конца месяца ещё добирают.</p>
        </>
      )}
    </>
  );
}
