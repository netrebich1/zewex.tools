import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { seesAllSites } from "@/lib/permissions";
import { Badge, Card, Empty, PageHeader, type SearchParams, sp } from "@/components/ui";
import { canSeeFinance, siteAccessWhere } from "@/lib/projects/access";
import { projectSummaries, stripFinance, type ProjectSummary } from "@/lib/projects/summary";
import { alertsTone, projectAlerts, type Alert } from "@/lib/projects/alerts";
import { PROJECT_STATUSES, statusLabel, statusTone } from "@/lib/projects/steps";
import { fmtMoney } from "@/lib/utils";
import { formatRu } from "@/lib/pins/schedule/math";

export const dynamic = "force-dynamic";

const dateShort = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) : "—");
const ago = (iso: string | null, now: number) => { if (!iso) return "—"; const d = Math.floor((now - new Date(iso).getTime()) / 86400000); return d <= 0 ? "сегодня" : d === 1 ? "вчера" : `${d} дн. назад`; };

/** Список проектов: все видимые сайты с автоматикой из инструментов и ручным слоем. Деньги — только главным админам. */
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const finance = canSeeFinance(me);
  const fTeam = sp(q, "team") ?? "", fStatus = sp(q, "status") ?? "", fOwner = sp(q, "owner") ?? "", fQ = (sp(q, "q") ?? "").toLowerCase(), fAlerts = sp(q, "alerts") === "1", fArchived = sp(q, "archived") === "1";
  const [teams, sites] = await Promise.all([
    prisma.team.findMany({ where: seesAllSites(me) ? {} : { id: { in: me.teamIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.siteAccess.findMany({ where: await siteAccessWhere(me), orderBy: { name: "asc" }, select: { id: true, name: true, baseUrl: true, teamId: true } }),
  ]);
  const ids = sites.map((s) => s.id);
  const [cards, summariesRaw, overdue, lastEvents, financeAgg] = await Promise.all([
    prisma.prjCard.findMany({ where: { accessId: { in: ids } }, include: { steps: { select: { state: true } } } }),
    projectSummaries(ids),
    prisma.prjTask.groupBy({ by: ["cardId"], where: { card: { accessId: { in: ids } }, status: { not: "done" }, dueAt: { lt: new Date() } }, _count: { _all: true } }),
    prisma.prjEvent.groupBy({ by: ["cardId"], where: { card: { accessId: { in: ids } } }, _max: { at: true } }),
    finance ? prisma.prjFinance.groupBy({ by: ["cardId", "kind"], where: { card: { accessId: { in: ids } } }, _sum: { amountUsd: true } }) : Promise.resolve([]),
  ]);
  const ownerIds = [...new Set(cards.map((c) => c.ownerId).filter((x): x is string => !!x))];
  const owners = ownerIds.length ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, email: true } }) : [];
  const ownerName = (id: string | null) => { const u = owners.find((x) => x.id === id); return u ? u.name || u.email : null; };
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? "другая команда";
  const now = Date.now();

  const rows = sites.map((site) => {
    const card = cards.find((c) => c.accessId === site.id) ?? null;
    const s0 = summariesRaw.get(site.id)!;
    const s = finance ? s0 : stripFinance(s0);
    const overdueN = card ? overdue.find((o) => o.cardId === card.id)?._count._all ?? 0 : 0;
    const lastEventAt = card ? lastEvents.find((e) => e.cardId === card.id)?._max.at ?? null : null;
    const alerts = projectAlerts(s, card ? { status: card.status, nextDueAt: card.nextDueAt } : null, { overdue: overdueN }, lastEventAt);
    const stepsDone = card ? card.steps.filter((x) => x.state === "done" || x.state === "skip").length : 0;
    const stepsAll = card ? card.steps.length : 0;
    const fin = { income: 0, expense: 0 };
    if (card) for (const f of financeAgg) if (f.cardId === card.id) fin[f.kind === "income" ? "income" : "expense"] += Number(f._sum.amountUsd ?? 0);
    const lastAct = [s.lastActivityAt, lastEventAt?.toISOString() ?? null].filter(Boolean).sort().at(-1) ?? null;
    const started = s.pins.runs.total > 0 || s.articles.total > 0 || s.blog.total > 0 || (card ? card.status !== "NEW" : false);
    return { site, card, s, alerts, tone: alertsTone(alerts), overdueN, stepsDone, stepsAll, fin, lastAct, status: card?.status ?? "NEW", started };
  }).filter((r) => {
    if (!fArchived && (r.status === "ARCHIVED")) return false;
    if (fTeam && r.site.teamId !== fTeam) return false;
    if (fStatus && r.status !== fStatus) return false;
    if (fOwner && (r.card?.ownerId ?? "") !== fOwner) return false;
    if (fQ && !`${r.site.name} ${r.site.baseUrl}`.toLowerCase().includes(fQ)) return false;
    if (fAlerts && !r.alerts.length) return false;
    return true;
  }).sort((a, b) => {
    // Сначала где запас пинов кончается, потом по имени.
    const days = (r: typeof a) => (r.s.pins.tool ? r.s.pins.schedule.stockRunDays : 999);
    return days(a) - days(b) || a.site.name.localeCompare(b.site.name);
  });

  const kpi = {
    active: rows.filter((r) => r.status === "ACTIVE").length,
    noPins: rows.filter((r) => r.alerts.some((a) => a.key === "no_pins" || a.key === "stock_out")).length,
    low: rows.filter((r) => r.alerts.some((a) => a.key === "stock_low")).length,
    notUploaded: rows.reduce((a, r) => a + r.s.pins.uploads.pendingDays, 0),
    overdue: rows.reduce((a, r) => a + r.overdueN, 0),
    cost: rows.reduce((a, r) => a + r.s.cost.total + r.fin.expense, 0),
    income: rows.reduce((a, r) => a + r.fin.income, 0),
  };
  const link = (patch: Record<string, string>) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries({ team: fTeam, status: fStatus, owner: fOwner, q: sp(q, "q") ?? "", alerts: fAlerts ? "1" : "", archived: fArchived ? "1" : "", ...patch })) if (v) u.set(k, v); const s = u.toString(); return `/pinterest/projects${s ? `?${s}` : ""}`; };

  return (
    <>
      <PageHeader title="Проекты" subtitle="Каждый сайт — проект: прогоны и запас пинов, выгрузки и заливка в Pinterest, статьи, этапы, задачи и история. Автоматика подтягивается сама, руками — только статусы, задачи и заметки." actions={<Link href="/sites/new" className="btn-ghost">Добавить сайт</Link>} />
      {sites.length === 0 ? (
        <Empty title="Сайтов пока нет" hint="Проект появляется сам, как только сайт добавлен в «Сайты» и виден вам." action={<Link href="/sites/new" className="btn-primary">Добавить сайт</Link>} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="В работе" value={kpi.active} />
            <Kpi label="Без пинов" value={kpi.noPins} tone={kpi.noPins ? "danger" : undefined} href={link({ alerts: "1" })} />
            <Kpi label="Запас < 7 дн." value={kpi.low} tone={kpi.low ? "warn" : undefined} href={link({ alerts: "1" })} />
            <Kpi label="Не залито (дней)" value={kpi.notUploaded} tone={kpi.notUploaded ? "warn" : undefined} />
            <Kpi label="Просрочено задач" value={kpi.overdue} tone={kpi.overdue ? "danger" : undefined} href="/pinterest/projects/tasks" />
            {finance ? <Kpi label="Расход / доход" value={`${fmtMoney(kpi.cost)} / ${fmtMoney(kpi.income)}`} small /> : <Kpi label="Проектов" value={rows.length} />}
          </div>

          <Card>
            <form method="get" action="/pinterest/projects" className="grid gap-2 sm:grid-cols-[1fr_160px_160px_160px_auto]">
              <input name="q" className="input py-2" defaultValue={sp(q, "q") ?? ""} placeholder="Поиск по сайту или адресу" />
              <select name="team" className="input py-2" defaultValue={fTeam}><option value="">Все команды</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              <select name="status" className="input py-2" defaultValue={fStatus}><option value="">Все статусы</option>{PROJECT_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
              <select name="owner" className="input py-2" defaultValue={fOwner}><option value="">Любой ответственный</option>{owners.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}</select>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[13px] whitespace-nowrap"><input type="checkbox" name="alerts" value="1" defaultChecked={fAlerts} /> только с сигналами</label>
                <label className="flex items-center gap-1.5 text-[13px] whitespace-nowrap"><input type="checkbox" name="archived" value="1" defaultChecked={fArchived} /> архив</label>
                <button type="submit" className="btn-primary btn-sm">Показать</button>
              </div>
            </form>
            <ProjectRows rows={rows.filter((r) => r.started)} finance={finance} teamName={teamName} ownerName={ownerName} now={now} />
            {rows.some((r) => !r.started) && (
              <details className="mt-4" open={rows.every((r) => !r.started)}>
                <summary className="cursor-pointer text-[14px] font-semibold">Ещё не начаты — {rows.filter((r) => !r.started).length} {plural(rows.filter((r) => !r.started).length, "сайт", "сайта", "сайтов")}<span className="help font-normal ml-2 inline">нет ни одного прогона пинов и ни одной статьи</span></summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {rows.filter((r) => !r.started).map((r) => (
                    <Link key={r.site.id} href={`/pinterest/projects/${r.site.id}`} className="rounded-xl border border-line px-3.5 py-2.5 hover:bg-surface-2 transition">
                      <div className="flex items-center justify-between gap-2"><span className="font-medium truncate">{r.site.name}</span><Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge></div>
                      <div className="help truncate">{teamName(r.site.teamId)}{r.card?.ownerId ? ` · ${ownerName(r.card.ownerId)}` : ""}{r.card?.nextAction ? ` · ${r.card.nextAction}` : r.s.pins.tool ? " · Pins подключён, прогонов нет" : " · Pins не подключён"}</div>
                    </Link>
                  ))}
                </div>
              </details>
            )}
            <p className="help mt-3">Сверху — сайты, где уже идёт работа; цвет точки — сигнал (красная — пинов нет или прогон упал, жёлтая — запас меньше недели или не отмечена заливка). «Пины до» — последний день с запланированными пинами, как в календаре запаса. Заливку отмечают в карточке на вкладке «Выгрузки».</p>
          </Card>
        </div>
      )}
    </>
  );
}

function Kpi({ label, value, tone, href, small }: { label: string; value: number | string; tone?: "danger" | "warn"; href?: string; small?: boolean }) {
  const body = (
    <div className="kpi">
      <div className="help">{label}</div>
      <div className={`kpi-value ${small ? "!text-[18px] sm:!text-[20px]" : ""} ${tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : ""}`}>{value}</div>
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{body}</Link> : body;
}

type Row = { site: { id: string; name: string; baseUrl: string; teamId: string }; card: { ownerId: string | null; nextAction: string | null; nextDueAt: Date | null } | null; s: ProjectSummary; alerts: Alert[]; tone: string; overdueN: number; stepsDone: number; stepsAll: number; fin: { income: number; expense: number }; lastAct: string | null; status: string };

/** Строки проектов: главное крупно (пины до, залито), остальное мелко. Без пустых колонок. */
function ProjectRows({ rows, finance, teamName, ownerName, now }: { rows: Row[]; finance: boolean; teamName: (id: string) => string; ownerName: (id: string | null) => string | null; now: number }) {
  if (!rows.length) return <p className="help mt-3">По фильтру ничего нет.</p>;
  return (
    <div className="mt-3 divide-y divide-line/70">
      {rows.map((r) => {
        const p = r.s.pins;
        const href = `/pinterest/projects/${r.site.id}`;
        const dot = r.tone === "danger" ? "bg-danger" : r.tone === "warn" ? "bg-warn" : r.tone === "neutral" ? "bg-ink/30" : "bg-ok";
        const stockTone = !p.tool ? "" : p.schedule.stockRunDays === 0 ? "text-danger" : p.schedule.stockRunDays < 7 ? "text-warn" : "";
        const bar = Math.min(100, Math.round((p.schedule.stockRunDays / 30) * 100));
        const owner = ownerName(r.card?.ownerId ?? null);
        return (
          <div key={r.site.id} className="grid items-center gap-x-5 gap-y-2 py-3 lg:grid-cols-[minmax(220px,1.3fr)_170px_170px_150px_minmax(140px,1fr)_auto]">
            <div className="flex items-start gap-2.5 min-w-0">
              <span title={r.alerts.map((a) => a.text).join(" · ") || "Сигналов нет"} className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><Link href={href} className="font-semibold hover:underline truncate">{r.site.name}</Link><Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge></div>
                <div className="help truncate">{teamName(r.site.teamId)}{owner ? ` · ${owner}` : ""}{r.stepsAll ? ` · этапы ${r.stepsDone}/${r.stepsAll}` : ""}{r.lastAct ? ` · ${ago(r.lastAct, now)}` : ""}</div>
                {r.alerts.length > 0 && <div className={`text-[12.5px] ${r.tone === "danger" ? "text-danger" : r.tone === "warn" ? "text-warn" : "text-muted"}`}>{r.alerts.slice(0, 2).map((a) => a.text).join(" · ")}</div>}
              </div>
            </div>
            <div>
              <div className="help">Пины до</div>
              {!p.tool ? <div className="text-muted">Pins не подключён</div> : p.schedule.throughDay ? (
                <>
                  <div className={`font-semibold tabular-nums ${stockTone}`}>{formatRu(p.schedule.throughDay)} <span className="font-normal text-[12.5px]">· {p.schedule.stockRunDays} дн.</span></div>
                  <div className="mt-1 h-1.5 w-full max-w-[140px] rounded-full bg-ink/10"><div className={`h-1.5 rounded-full ${p.schedule.stockRunDays < 7 ? "bg-warn" : "bg-ok"}`} style={{ width: `${bar}%` }} /></div>
                  <div className="help">{p.pins.planned} пинов · {p.pins.pages} стат.{p.schedule.targetPerDay ? ` · ${p.schedule.targetPerDay}/день` : ""}</div>
                </>
              ) : <div className="font-semibold text-danger">нет</div>}
            </div>
            <div>
              <div className="help">Залито в Pinterest</div>
              {!p.tool || !p.exports.days ? <div className="text-muted">{p.tool ? "выгрузок не было" : "—"}</div> : p.uploads.pendingDays ? (
                <><div className="font-semibold text-warn">{p.uploads.pendingDays} дн. без отметки</div><div className="help">{p.uploads.lastDay ? `отмечено по ${formatRu(p.uploads.lastDay)}` : "ничего не отмечено"}</div></>
              ) : <><div className="font-semibold text-ok">✓ по {formatRu(p.uploads.lastDay!)}</div><div className="help">все {p.exports.days} дн. выгрузки</div></>}
            </div>
            <div>
              <div className="help">Статьи</div>
              {!r.s.articles.tool && !r.s.blog.tool ? <div className="text-muted">—</div> : (
                <>
                  <div className="font-semibold tabular-nums">{r.s.articles.published + r.s.blog.published}</div>
                  <div className="help">{r.s.articles.tool ? `подборки ${r.s.articles.published}${r.s.articles.inWork ? ` (+${r.s.articles.inWork})` : ""}` : ""}{r.s.articles.tool && r.s.blog.tool ? " · " : ""}{r.s.blog.tool ? `блог ${r.s.blog.published}${r.s.blog.inWork ? ` (+${r.s.blog.inWork})` : ""}` : ""}{r.s.articles.failed + r.s.blog.failed ? <span className="text-danger"> · ошибок {r.s.articles.failed + r.s.blog.failed}</span> : null}</div>
                </>
              )}
            </div>
            <div className="min-w-0">
              <div className="help">Что дальше</div>
              {r.card?.nextAction ? <><div className="truncate">{r.card.nextAction}</div>{r.card.nextDueAt && <div className={`help ${r.card.nextDueAt.getTime() < now ? "text-danger" : ""}`}>до {r.card.nextDueAt.toLocaleDateString("ru-RU")}</div>}</> : <div className="text-muted">{p.runs.last ? <>прогон {dateShort(p.runs.last.createdAt)}{p.runs.total > 1 ? ` · всего ${p.runs.total}` : ""}</> : "—"}</div>}
              {r.overdueN > 0 && <div className="help text-danger">просрочено задач: {r.overdueN}</div>}
            </div>
            <div className="text-right tabular-nums whitespace-nowrap">
              {finance ? <><div className="font-semibold">{fmtMoney(r.s.cost.total + r.fin.expense)}</div><div className="help">{r.fin.income ? <span className="text-ok">+{fmtMoney(r.fin.income)}</span> : "расход"}</div></> : <Link href={href} className="btn-ghost btn-sm">Открыть</Link>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
