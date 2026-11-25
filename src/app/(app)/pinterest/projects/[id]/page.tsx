import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { canSeeFinance, loadAccessForUser } from "@/lib/projects/access";
import { ensureCard, projectFeed } from "@/lib/projects/card";
import { projectSummaries, stripFinance } from "@/lib/projects/summary";
import { projectAlerts } from "@/lib/projects/alerts";
import { assigneesFor, listTasks } from "@/lib/projects/tasks";
import { accessTeamIds } from "@/lib/sites/access";
import { ProjectHeader } from "@/components/projects/ProjectHeader";
import { StepsChecklist } from "@/components/projects/StepsChecklist";
import { CardForm } from "@/components/projects/CardForm";
import { WorkTab } from "@/components/projects/WorkTab";
import { UploadsTab } from "@/components/projects/UploadsTab";
import { TasksList } from "@/components/projects/TasksList";
import { ClustersTab } from "@/components/projects/ClustersTab";
import { FinanceTab } from "@/components/projects/FinanceTab";
import { Timeline } from "@/components/projects/Timeline";
import { formatRu } from "@/lib/pins/schedule/math";
import { fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS = [["overview", "Обзор"], ["work", "Работа"], ["uploads", "Выгрузки"], ["clusters", "Кластеры"], ["tasks", "Задачи"], ["finance", "Финансы"], ["feed", "История"]] as const;
type Tab = (typeof TABS)[number][0];

/** Карточка проекта: автоматика из инструментов + ручной слой. Деньги — только главным админам. */
export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const q = await searchParams;
  const finance = canSeeFinance(me);
  const access = await loadAccessForUser(me, id);
  if (!access) notFound();
  const tabs = TABS.filter(([k]) => finance || k !== "finance");
  const tab = (tabs.some(([k]) => k === sp(q, "tab")) ? sp(q, "tab") : "overview") as Tab;
  const card = await ensureCard(id);
  const [team, summaries, members, tasks, feed, strategyRows] = await Promise.all([
    prisma.team.findFirst({ where: { id: access.teamId }, select: { name: true } }),
    projectSummaries([id], { crossUrls: true }),
    assigneesFor(accessTeamIds(access)),
    listTasks(me, { scope: "all", accessId: id, done: true }),
    projectFeed(card.id),
    prisma.prjCard.findMany({ where: { NOT: { id: card.id } }, select: { strategies: true }, take: 300 }),
  ]);
  const s = finance ? summaries.get(id)! : stripFinance(summaries.get(id)!);
  const openTasks = tasks.filter((t) => t.status !== "done");
  const overdue = openTasks.filter((t) => t.dueAt && new Date(t.dueAt).getTime() < Date.now()).length;
  const alerts = projectAlerts(s, card, { overdue }, feed[0] ? new Date(feed[0].at) : null);
  const userIds = [...new Set([...feed.map((f) => f.userId), ...card.steps.map((x) => x.doneById), card.ownerId].filter((x): x is string => !!x))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
  const userName = (uid: string | null): string | null => { const u = users.find((x) => x.id === uid); if (u) return u.name || u.email; return members.find((m) => m.id === uid)?.name ?? null; };
  const strategyHints = [...new Set(strategyRows.flatMap((r) => (r.strategies as string[] | null) ?? []))].sort();
  const p = s.pins;
  const href = (t: Tab) => `/pinterest/projects/${id}?tab=${t}`;

  return (
    <>
      <PageHeader back={{ href: "/pinterest/projects", label: "Проекты" }} title={access.name} subtitle={`${team?.name ?? "—"} · ${access.baseUrl}`}
        actions={<><Link href={`/sites/${id}`} className="btn-ghost">Доступ и команды</Link>{p.tool?.ids[0] && <Link href={`/pinterest/pins/sites/${p.tool.ids[0]}`} className="btn-ghost">Pinterest Pins</Link>}{s.articles.tool?.ids[0] && <Link href={`/pinterest/articles/sites/${s.articles.tool.ids[0]}`} className="btn-ghost">Статьи</Link>}{s.blog.tool?.ids[0] && <Link href={`/pinterest/blog/sites/${s.blog.tool.ids[0]}`} className="btn-ghost">Блог</Link>}</>} />
      <ProjectHeader accessId={id} card={card} members={members} alerts={alerts} />
      <div className="mb-4 flex flex-wrap gap-2">{tabs.map(([k, l]) => <Link key={k} href={href(k)} className={`badge px-3 py-1 max-sm:!py-1.5 max-sm:min-h-8 ${tab === k ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{l}{k === "tasks" && openTasks.length ? <span className="ml-1 opacity-70">{openTasks.length}</span> : null}{k === "uploads" && p.uploads.pendingDays ? <span className="ml-1 text-warn">{p.uploads.pendingDays}</span> : null}</Link>)}</div>

      {tab === "overview" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Пины до" value={p.tool ? (p.schedule.throughDay ? formatRu(p.schedule.throughDay) : "нет") : "—"} sub={p.tool ? `${p.schedule.stockRunDays} дн. подряд · готово к выгрузке ${p.schedule.futureReady}` : "Pins не подключён"} tone={p.tool && p.schedule.stockRunDays < 7 ? (p.schedule.stockRunDays === 0 ? "danger" : "warn") : undefined} />
            <Kpi label="Пинов всего" value={p.tool ? p.pins.planned : "—"} sub={p.tool ? `${p.pins.pages} статей в прогонах${p.pins.perPageAvg ? ` · ${p.pins.perPageAvg} на статью` : ""} · прогонов ${p.runs.total}` : ""} />
            <Kpi label="Залито в Pinterest" value={p.tool ? (p.uploads.lastDay ? `по ${formatRu(p.uploads.lastDay)}` : "не отмечено") : "—"} sub={p.tool ? (p.uploads.pendingDays ? `без отметки ${p.uploads.pendingDays} дн. из ${p.exports.days}` : p.exports.days ? `все ${p.exports.days} дн. выгрузки отмечены` : "выгрузок не было") : ""} tone={p.uploads.pendingDays ? "warn" : undefined} />
            <Kpi label="Статьи" value={`${s.articles.published + s.blog.published}`} sub={`подборки ${s.articles.published}${s.articles.inWork ? ` (+${s.articles.inWork} в работе)` : ""} · блог ${s.blog.published}${s.blog.inWork ? ` (+${s.blog.inWork})` : ""}${(s.articles.withoutPins ?? 0) + (s.blog.withoutPins ?? 0) ? ` · без пинов ${(s.articles.withoutPins ?? 0) + (s.blog.withoutPins ?? 0)}` : ""}`} />
          </div>
          {finance && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Расход ИИ" value={fmtMoney(s.cost.total)} sub={`пины ${fmtMoney(s.cost.pins)} · статьи ${fmtMoney(s.cost.articles)} · блог ${fmtMoney(s.cost.blog)}`} />
              <Link href={href("finance")} className="kpi hover:opacity-90"><div className="help">Финансы</div><div className="kpi-value !text-[18px]">доходы и траты →</div></Link>
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <Card title="Этапы" description="Клик по кружку: не начато → в работе → сделано. Что не нужно этому проекту — «не нужно».">
              <StepsChecklist accessId={id} steps={card.steps} userName={userName} />
            </Card>
            <Card title="Карточка" description="Что дальше, стратегии, ниша, описание, Pinterest-аккаунт.">
              <CardForm accessId={id} card={card} strategyHints={strategyHints} />
            </Card>
          </div>
          {openTasks.length > 0 && (
            <Card title="Открытые задачи" actions={<Link href={href("tasks")} className="btn-ghost btn-sm">Все задачи</Link>}>
              <TasksList rows={openTasks.slice(0, 8)} />
            </Card>
          )}
          <Card title="Последнее" actions={<Link href={href("feed")} className="btn-ghost btn-sm">Вся история</Link>}>
            <Timeline accessId={id} items={feed.slice(0, 12)} userName={userName} finance={finance} filter="" meId={me.id} isAdmin={me.role === "ADMIN"} />
          </Card>
        </div>
      )}
      {tab === "work" && <WorkTab accessId={id} finance={finance} />}
      {tab === "uploads" && <UploadsTab accessId={id} userName={userName} />}
      {tab === "clusters" && <ClustersTab accessId={id} cardId={card.id} />}
      {tab === "tasks" && <Card title="Задачи по проекту" description="Исполнитель — из команд сайта. Сделанные остаются внизу."><TasksList rows={tasks} accessId={id} members={members} /></Card>}
      {tab === "finance" && finance && <FinanceTab accessId={id} cardId={card.id} summary={s} userName={userName} />}
      {tab === "feed" && <Card title="История проекта" description="Прогоны, публикации, выгрузки и заливка записываются сами; изменения статуса, этапов, стратегий и кластеров — тоже. Руками — только заметки."><Timeline accessId={id} items={feed} userName={userName} finance={finance} filter={sp(q, "kind") ?? ""} meId={me.id} isAdmin={me.role === "ADMIN"} /></Card>}
    </>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "danger" | "warn" }) {
  return (
    <div className="kpi">
      <div className="help">{label}</div>
      <div className={`kpi-value !text-[22px] sm:!text-[24px] ${tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : ""}`}>{value}</div>
      {sub && <div className="help">{sub}</div>}
    </div>
  );
}
