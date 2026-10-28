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
  event: "События и премии",
  trend: "Тренды и термины",
  "": "Без группы",
};
const TYPES: Record<string, string> = { person: "персона", brand: "бренд", event: "событие", trend: "тренд", product: "продукт" };
const aliasList = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

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
  const groups = Object.keys(GROUPS).map((g) => ({ g, rows: rows.filter((r) => (GROUPS[r.grp] ? r.grp : "") === g) })).filter((x) => x.rows.length);

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
                <li>Счётчик справа — сколько материалов за 7 дней нашёл бесплатный фильтр и сколько из них LLM признал нашей темой.</li>
              </ul>
            </Card>
          )}
        </div>
      )}

      {rows.length === 0 ? <Empty title="Сущностей пока нет" hint="Добавьте звёзд, бренды и события, которые важны сайту." /> : (
        <div className="space-y-5">
          {groups.map(({ g, rows: rs }) => (
            <Card key={g} title={`${GROUPS[g]} (${rs.length})`}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Сущность</th><th className="col-sm">Вес</th><th className="col-md">Варианты</th><th className="col-sm">За 7 дней</th><th className="col-sm"></th></tr></thead>
                  <tbody>
                    {rs.map((r) => {
                      const c = count.get(r.id);
                      return (
                        <tr key={r.id} className={r.isActive ? "" : "opacity-50"}>
                          <td><span className="font-medium">{r.name}</span> <span className="help">{TYPES[r.type] ?? r.type}</span> {r.weight >= s.topEntityWeight && <Badge tone="brand">первый ряд</Badge>}{!r.isActive && <Badge>выкл.</Badge>}</td>
                          <td className="col-sm tabular-nums">{r.weight}</td>
                          <td className="col-md help max-w-[360px] truncate">{aliasList(r.aliases).join(", ") || "—"}</td>
                          <td className="col-sm help whitespace-nowrap">{c ? `${c.all} / ${c.passed}` : "—"}</td>
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
