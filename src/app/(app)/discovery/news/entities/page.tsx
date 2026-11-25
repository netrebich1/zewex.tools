import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { Badge, Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { NewsNav } from "@/components/news/NewsNav";
import { addEntities, updateEntity } from "@/actions/news";
import { canManageProject, requireProject } from "@/lib/news/access";
import { BASE_PATH, parseSettings } from "@/lib/news/types";

export const dynamic = "force-dynamic";

const GROUPS: Record<string, string> = {
  ua_top: "Украинские звёзды первого ряда",
  ua_second: "Второй ряд, шоу",
  world: "Мировые звёзды",
  ua_brand: "Украинские дизайнеры и бренды",
  world_brand: "Мировые fashion-бренды",
  beauty: "Бьюти-бренды и ретейлеры",
  ua_blogger: "Украинские блогеры и тиктокеры",
  world_blogger: "Мировые блогеры",
  royal: "Королевские семьи",
  sport: "Спортсмены",
  event: "События и премии",
  trend: "Тренды и термины",
  "": "Без группы",
};
const TYPES: Record<string, string> = { person: "персона", brand: "бренд", event: "событие", trend: "тренд", product: "продукт" };
const aliasList = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
/** Статистика конкурентов за последний посчитанный месяц (scripts/news/views-analyze.ts): только сайты с открытыми просмотрами. */
type CompStats = { period: string; origin?: "ua" | "world" | null; rank: number; articles: number; views: number; avg: number; index: number; sites: Record<string, { n: number; v: number }>; events: { label: string; n: number }[]; top: { title: string; url: string; site: string; views: number } | null };
const comp = (v: unknown) => (v && typeof v === "object" ? (v as CompStats) : null);
const fmtN = (n: number) => n.toLocaleString("ru-RU");
const sitesText = (c: CompStats) => Object.entries(c.sites).sort((a, b) => b[1].v - a[1].v).map(([k, x]) => `${k}: ${x.n} ст., ${fmtN(x.v)}`).join(" · ");
type Origin = "ua" | "world" | "other";
/** Украинская персона, иностранная или не персона (бренды, события, тренды): по группе, для спортсменов и «без группы» — по рейтингу просмотров. */
const originOf = (r: { type: string; grp: string; compStats: unknown }): Origin =>
  r.type !== "person" ? "other" : r.grp.startsWith("ua_") ? "ua" : r.grp.startsWith("world") || r.grp === "royal" ? "world" : (comp(r.compStats)?.origin ?? "other");
const ORIGIN_TABS: Record<string, string> = { all: "Все", ua: "Украинские", world: "Иностранные", other: "Бренды, события, прочее" };

export default async function NewsEntitiesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const { project, list } = await requireProject(me, sp(q, "project"));
  if (!project) return <Empty title="Проектов пока нет" hint="Создайте проект в настройках." action={<Link href={`${BASE_PATH}/settings`} className="btn-brand">Настройки</Link>} />;
  const manage = canManageProject(me, project);
  const s = parseSettings(project.settings);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [rows, hits] = await Promise.all([
    prisma.newsEntity.findMany({ where: { projectId: project.id }, orderBy: [{ weight: "desc" }, { name: "asc" }] }),
    prisma.newsItem.findMany({ where: { projectId: project.id, foundAt: { gte: since }, matched: { not: Prisma.DbNull } }, select: { matched: true, status: true } }),
  ]);
  const count = new Map<string, { all: number; passed: number }>();
  for (const h of hits) {
    for (const m of Array.isArray(h.matched) ? (h.matched as { id: string }[]) : []) {
      const c = count.get(m.id) ?? { all: 0, passed: 0 };
      c.all++;
      if (h.status === "classified") c.passed++;
      count.set(m.id, c);
    }
  }
  const editing = rows.find((r) => r.id === sp(q, "edit")) ?? null;
  const tab = (["ua", "world", "other"].includes(sp(q, "o") ?? "") ? sp(q, "o") : "all") as "all" | Origin;
  const byViews = sp(q, "sort") === "views";
  const tabLink = (o: string, sort = byViews) => `${BASE_PATH}/entities?project=${project.id}${o !== "all" ? `&o=${o}` : ""}${sort ? "&sort=views" : ""}`;
  const shownRows = rows.filter((r) => tab === "all" || originOf(r) === tab).sort((a, b) => (byViews ? (comp(b.compStats)?.views ?? -1) - (comp(a.compStats)?.views ?? -1) : 0));
  const tabCount = (o: Origin) => rows.filter((r) => originOf(r) === o).length;
  const groups = Object.keys(GROUPS).map((g) => ({ g, rows: shownRows.filter((r) => (GROUPS[r.grp] ? r.grp : "") === g) })).filter((x) => x.rows.length);
  const withStats = rows.filter((r) => comp(r.compStats)).length;

  return (
    <>
      <NewsNav projects={list.map((p) => ({ id: p.id, name: p.name }))} current={project.id} />
      <PageHeader
        title="Сущности"
        subtitle={`Персоны, бренды и события, за которыми следит Discover. Сущность из списка пропускает материал через фильтр и добавляет баллы (вес 2.0 = +5 к «соответствию нише»). С весом от ${s.topEntityWeight} — «первый ряд»: запрос в Google News каждый прогон, остальные — по очереди.`}
      />

      {manage && (
        <div className="mb-5 grid gap-4 lg:grid-cols-2">
          <Card title="Добавить сущности" description="По одной в строке: «Имя | тип | вес | варианты написания через запятую | группа». Кроме имени всё можно не писать. Варианты — фамилия, русское и латинское написание: окончания модуль отрезает сам.">
            <ActionForm action={addEntities} className="space-y-3" hidden={{ project: project.id }}>
              <textarea name="lines" className="input min-h-[150px] font-mono text-[13px]" placeholder={"Надя Дорофєєва | person | 1.8 | Дорофєєва, Дорофеева, Dorofeeva | ua_top\nJacquemus | brand | 1.0 | Жакмюс | world_brand"} />
              <p className="help">Группы: {Object.entries(GROUPS).filter(([k]) => k).map(([k, v]) => `${k} — ${v}`).join("; ")}.</p>
              <SubmitButton className="btn-brand" pendingText="Добавляю…">Добавить</SubmitButton>
            </ActionForm>
          </Card>
          {editing ? (
            <Card title={`Изменить: ${editing.name}`} actions={<Link href={`${BASE_PATH}/entities?project=${project.id}`} className="btn-ghost btn-sm">Закрыть</Link>}>
              <ActionForm action={updateEntity} className="grid gap-2 sm:grid-cols-2" hidden={{ id: editing.id, op: "save" }}>
                <label className="block"><span className="label">Имя</span><input name="name" className="input" defaultValue={editing.name} /></label>
                <label className="block"><span className="label">Тип</span>
                  <select name="type" className="input" defaultValue={editing.type}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </label>
                <label className="block"><span className="label">Вес 0.3–2.0</span><input name="weight" className="input" defaultValue={editing.weight} /></label>
                <label className="block"><span className="label">Группа</span>
                  <select name="grp" className="input" defaultValue={editing.grp}>{Object.entries(GROUPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </label>
                <label className="block sm:col-span-2"><span className="label">Варианты написания (через запятую)</span><textarea name="aliases" className="input min-h-[70px]" defaultValue={aliasList(editing.aliases).join(", ")} /></label>
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  <SubmitButton className="btn-brand" pendingText="Сохраняю…">Сохранить</SubmitButton>
                </div>
              </ActionForm>
              <div className="mt-3 flex flex-wrap gap-2">
                <ActionForm action={updateEntity} className="inline" hidden={{ id: editing.id, op: "toggle" }}><SubmitButton className="btn-ghost btn-sm" pendingText="…">{editing.isActive ? "Выключить" : "Включить"}</SubmitButton></ActionForm>
                <ActionForm action={updateEntity} className="inline" hidden={{ id: editing.id, op: "delete" }}><SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…" confirm={`Удалить «${editing.name}»?`}>Удалить</SubmitButton></ActionForm>
              </div>
            </Card>
          ) : (
            <Card title="Как это работает">
              <ul className="list-disc space-y-1 pl-5 text-[14px] text-ink-2">
                <li>Материал без сущности проходит фильтр, только если в нём есть нишевое слово или источник профильный.</li>
                <li>Сущность с латинским написанием ловит новости мировых медиа — так появляется сигнал «ещё нет в UA».</li>
                <li>Короткие имена (Зара, Діор) совпадают только с близкими формами слова, чтобы не ловить «зарплату».</li>
                <li>Счётчик «За 7 дней» — сколько материалов нашёл бесплатный фильтр и сколько из них LLM признал нашей темой.</li>
                <li>«Конкуренты, месяц» — сколько статей о персоне вышло на сайтах с открытыми просмотрами и сколько они собрали. Наведите курсор — разбивка по сайтам.</li>
              </ul>
            </Card>
          )}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {Object.entries(ORIGIN_TABS).map(([k, label]) => (
          <Link key={k} href={tabLink(k)} className={`tab ${tab === k ? "active" : ""}`}>{label} ({k === "all" ? rows.length : tabCount(k as Origin)})</Link>
        ))}
        <span className="ml-auto flex items-center gap-1.5 text-[13px] text-muted">
          Порядок:
          <Link href={tabLink(tab, false)} className={`tab ${!byViews ? "active" : ""}`}>по весу</Link>
          <Link href={tabLink(tab, true)} className={`tab ${byViews ? "active" : ""}`}>по просмотрам у конкурентов</Link>
        </span>
      </div>
      {withStats > 0 && (
        <p className="help mb-4">
          Просмотры у конкурентов есть у {withStats} сущностей. Полный рейтинг всех звёзд, включая тех, кого мы ещё не отслеживаем, с разбивкой на украинских и иностранных, новыми и растущими — на странице{" "}
          <Link href={`${BASE_PATH}/views?project=${project.id}`} className="font-medium underline">«Просмотры»</Link>.
        </p>
      )}

      {rows.length === 0 ? <Empty title="Сущностей пока нет" hint="Добавьте звёзд, бренды и события, которые важны сайту." /> : (
        <div className="space-y-5">
          {groups.map(({ g, rows: rs }) => (
            <Card key={g} title={`${GROUPS[g]} (${rs.length})`}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Сущность</th><th className="col-sm">Вес</th><th className="col-md">Варианты</th><th className="col-sm">За 7 дней</th><th className="col-sm">Конкуренты, месяц</th><th className="col-sm"></th></tr></thead>
                  <tbody>
                    {rs.map((r) => {
                      const c = count.get(r.id);
                      const cs = comp(r.compStats);
                      return (
                        <tr key={r.id} className={r.isActive ? "" : "opacity-50"}>
                          <td><span className="font-medium">{r.name}</span> <span className="help">{TYPES[r.type] ?? r.type}</span> {r.weight >= s.topEntityWeight && <Badge tone="brand">первый ряд</Badge>}{!r.isActive && <Badge>выкл.</Badge>}</td>
                          <td className="col-sm tabular-nums">{r.weight}</td>
                          <td className="col-md help max-w-[360px] truncate">{aliasList(r.aliases).join(", ") || "—"}</td>
                          <td className="col-sm help whitespace-nowrap">{c ? `${c.all} / ${c.passed}` : "—"}</td>
                          <td className="col-sm help whitespace-nowrap" title={cs ? sitesText(cs) : undefined}>{cs ? `${cs.articles} ст. · ${fmtN(cs.views)}` : "—"}</td>
                          <td className="col-sm text-right">{manage && <Link href={`${BASE_PATH}/entities?project=${project.id}&edit=${r.id}`} className="btn-ghost btn-sm">Изменить</Link>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
