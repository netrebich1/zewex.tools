import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canAccessPinSite, siteAccessWhere } from "@/lib/sites/access";
import { Badge, Card, Empty, PageHeader, type SearchParams, sp } from "@/components/ui";
import { mergeRecipe, PROJECT_SLUG, runDefaultsFrom } from "@/lib/pins/types";
import { RUN_STATUS_LABELS, runStatusTone } from "@/components/pins/labels";
import { fmtDate } from "@/lib/utils";
import { SiteCalendar } from "@/components/pins/SiteCalendar";
import { siteStock } from "@/lib/pins/runs/stats";
import { PinsSiteSettings } from "@/components/sites/PinsRecipeForm";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { toggleSiteActive } from "@/actions/pins";
import { RescheduleTool } from "@/components/pins/RescheduleTool";
import { siteOverDays } from "@/lib/pins/runs/reschedule";
import { todayKey } from "@/lib/pins/schedule/math";
import { TZ } from "@/lib/pins/runs/stats";

export const dynamic = "force-dynamic";

/** Сайт в сервисе Pinterest Pins: запас пинов, прогоны и настройки сервиса для сайта (доски, стили, язык). */
export default async function SitePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const tab = sp(await searchParams, "tab") ?? "overview";
  const site = await prisma.pinSite.findUnique({ where: { id }, include: { boards: { orderBy: { sortOrder: "asc" } }, sets: { orderBy: { name: "asc" } }, team: true, _count: { select: { runs: true } } } });
  if (!site || !(await canAccessPinSite(me, site))) notFound();
  const r = mergeRecipe(site.recipe);
  const [runs, stock, lastRun, wps, over] = await Promise.all([
    prisma.pinRun.findMany({ where: { siteId: id, NOT: { name: "__system__" } }, orderBy: { createdAt: "desc" }, take: 50 }),
    siteStock(id, 35),
    prisma.pinRun.findFirst({ where: { siteId: id, NOT: { name: "__system__" } }, orderBy: { createdAt: "desc" }, select: { settings: true } }),
    site.wpConnectionId ? Promise.resolve([]) : prisma.siteAccess.findMany({ where: { ...(await siteAccessWhere(me)), kind: "wordpress" }, orderBy: { name: "asc" }, select: { id: true, name: true, projects: true } })
      .then((rows) => rows.filter((w) => { const pr = (w.projects as string[] | null) ?? []; return !pr.length || pr.includes(PROJECT_SLUG); })),
    tab === "overview" ? siteOverDays(id) : Promise.resolve([]),
  ]);
  const immediate = over.reduce((n, d) => n + d.immediate, 0);
  const fmtDay = (k: string) => k.split("-").reverse().slice(0, 2).join(".");
  const target = runDefaultsFrom(site.recipe, lastRun?.settings ?? null).schedule.pinsPerDay;
  const tabs = [["overview", "Обзор"], ["runs", "Прогоны"], ["settings", "Настройки"]];
  const styles = [r.sets.aiSetIds.length && `наборов ИИ ${r.sets.aiSetIds.length}`, `Canvas-стилей ${r.sets.canvasStyleIds.length || "все"}`, r.sets.pinoraTypes.length && `Pinora ${r.sets.pinoraTypes.length}`].filter(Boolean).join(" · ");

  return (
    <>
      <PageHeader back={{ href: "/pinterest/pins/sites", label: "Сайты" }} title={site.name} subtitle={`${site.team.name} · досок ${site.boards.length} · ${styles} · язык ${r.text.language}${site.isActive ? "" : " · в архиве"}`} actions={<>{site.wpConnectionId && <Link href={`/sites/${site.wpConnectionId}`} className="btn-ghost">Доступ и команды</Link>}<a href={`/api/pins/export/all?site=${id}`} className="btn-ghost">Выгрузить все пины</a><Link href={`/pinterest/pins/runs/new?site=${id}`} className="btn-brand">Новый прогон</Link></>} />
      <div className="mb-4 flex gap-2">
        {tabs.map(([k, l]) => <Link key={k} href={`/pinterest/pins/sites/${id}?tab=${k}`} className={`badge px-3 py-1 max-sm:!py-1.5 max-sm:min-h-8 ${tab === k ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{l}</Link>)}
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          <Card title="Запас пинов по дням" description={`Ориентир: ${target} в день (из последнего прогона). Серым — дни без пинов, жёлтым — недобор, зелёным — норма.`}>
            {immediate > 0 && (
              <div className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
                <b>В {over.length} дн. больше 100 пинов: {immediate} опубликуются сразу.</b> Pinterest ставит по времени только 100 пинов файла дня — первые 100 идут по расписанию, остальные выгружаются без даты и выходят сразу при загрузке файла.
                {" "}Дни: {over.slice(0, 6).map((d) => `${fmtDay(d.day)} (${d.total})`).join(", ")}{over.length > 6 ? "…" : ""}. Если так не задумано — перераспределите график ниже.
              </div>
            )}
            <SiteCalendar days={stock} target={target} />
          </Card>
          <Card title="Перераспределить график" description="Изменить, сколько пинов сайта выходит в день, для уже запланированных пинов: ровно N в день или «плавный рост» ступенями. Сначала покажем «было → станет», запишем только после подтверждения.">
            <RescheduleTool siteId={id} today={todayKey(new Date(), TZ)} current={target} />
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Настройки сайта" description={`Досок: ${site.boards.length}. ${styles}. Доски, стили и язык — на вкладке «Настройки».`}>
              <Link href={`/pinterest/pins/sites/${id}?tab=settings`} className="btn-primary">Открыть настройки</Link>
            </Card>
            <Card title="Прогоны" description={`Всего прогонов: ${site._count.runs}. Сколько пинов делать, расписание и откуда брать ссылки — задаётся при запуске каждого прогона.`}>
              <Link href={`/pinterest/pins/runs/new?site=${id}`} className="btn-primary">Новый прогон</Link>
            </Card>
          </div>
        </div>
      )}

      {tab === "runs" && (
        <Card title="Прогоны сайта">
          {runs.length === 0 ? <Empty title="Прогонов ещё не было" /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Прогон</th><th>Статус</th><th>Этап</th><th>Создан</th></tr></thead>
              <tbody>{runs.map((x) => (
                <tr key={x.id}><td><Link href={`/pinterest/pins/runs/${x.id}`} className="font-medium underline decoration-line hover:decoration-ink">{x.name || x.id.slice(0, 8)}</Link></td><td><Badge tone={runStatusTone(x.status)}>{RUN_STATUS_LABELS[x.status]}</Badge></td><td className="text-muted">{x.stage}</td><td className="text-muted">{fmtDate(x.createdAt)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      )}

      {tab === "settings" && (
        <div className="space-y-4">
          <PinsSiteSettings site={site} wps={wps} />
          <ActionForm action={toggleSiteActive} hidden={{ id }}>
            {site.isActive
              ? <SubmitButton className="btn-ghost" confirm="Убрать сайт из Pinterest Pins в архив? Прогоны и настройки сохранятся." pendingText="…">Убрать сайт в архив</SubmitButton>
              : <SubmitButton className="btn-ghost" pendingText="…">Вернуть сайт из архива</SubmitButton>}
          </ActionForm>
        </div>
      )}
    </>
  );
}
