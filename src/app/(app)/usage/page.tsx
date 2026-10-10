import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { usageScope, usageWhere } from "@/lib/permissions";
import { Badge, Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { fmtDate, fmtMoney, monthStart } from "@/lib/utils";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function UsagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const scope = usageScope(me);
  const onlyMine = scope !== "all" && scope.length === 0;
  const period = sp(params, "period") ?? "month";
  const since = period === "7d" ? new Date(Date.now() - 7 * 86400000) : period === "today" ? new Date(new Date().setHours(0, 0, 0, 0)) : monthStart();
  const base: Prisma.UsageLogWhereInput = { createdAt: { gte: since }, ...(usageWhere(me) as Prisma.UsageLogWhereInput) };

  const [total, byKey, byProject, byUser, recent] = await Promise.all([
    prisma.usageLog.aggregate({ where: base, _sum: { costUsd: true, inputTokens: true, outputTokens: true }, _count: true }),
    prisma.usageLog.groupBy({ by: ["apiKeyId"], where: base, _sum: { costUsd: true }, _count: true }),
    prisma.usageLog.groupBy({ by: ["projectId"], where: base, _sum: { costUsd: true }, _count: true }),
    onlyMine ? Promise.resolve([]) : prisma.usageLog.groupBy({ by: ["userId"], where: base, _sum: { costUsd: true }, _count: true }),
    prisma.usageLog.findMany({ where: base, orderBy: { createdAt: "desc" }, take: 50, include: { user: { select: { name: true } }, project: { select: { name: true } }, slot: { select: { name: true } }, provider: true, model: true, apiKey: { select: { label: true } } } }),
  ]);
  const keys = await prisma.apiKey.findMany({ where: { id: { in: byKey.map((k) => k.apiKeyId).filter((x): x is string => !!x) } }, select: { id: true, label: true, provider: { select: { name: true } } } });
  const projects = await prisma.project.findMany({ where: { id: { in: byProject.map((p) => p.projectId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const users = onlyMine ? [] : await prisma.user.findMany({ where: { id: { in: byUser.map((u) => u.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const name = <T extends { id: string }>(list: T[], id: string | null, f: (t: T) => string) => (id ? list.find((x) => x.id === id) : null) ? f(list.find((x) => x.id === id)!) : "—";

  const Tab = ({ v, label }: { v: string; label: string }) => (
    <a href={`/usage?period=${v}`} className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium border ${period === v ? "bg-ink text-bg border-ink" : "bg-surface border-line hover:border-ink/40"}`}>{label}</a>
  );
  const subtitle = scope === "all" ? "Все вызовы через портал. Стоимость считается по ценам моделей; у SERP-провайдеров цена не известна." : onlyMine ? "Ваши вызовы через портал." : "Ваши вызовы и вызовы ваших команд.";

  return (
    <>
      <PageHeader title="Расход" subtitle={subtitle} actions={<div className="flex gap-2"><Tab v="today" label="Сегодня" /><Tab v="7d" label="7 дней" /><Tab v="month" label="Месяц" /></div>} />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {[
          { l: "Вызовов", v: total._count },
          { l: "Стоимость", v: fmtMoney(total._sum.costUsd ?? 0) },
          { l: "Токены на входе", v: (total._sum.inputTokens ?? 0).toLocaleString("ru-RU") },
          { l: "Токены на выходе", v: (total._sum.outputTokens ?? 0).toLocaleString("ru-RU") },
        ].map((s) => <div key={s.l} className="card p-3 sm:p-4"><div className="text-[20px] sm:text-[24px] font-bold tracking-tight">{s.v}</div><div className="help">{s.l}</div></div>)}
      </div>
      {total._count === 0 ? <Empty title="За этот период вызовов не было" hint="Как только инструменты начнут ходить через /api/run, здесь появится статистика." /> : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="По ключам">
            <ul className="divide-y divide-line text-[14px]">
              {byKey.sort((a, b) => (b._sum.costUsd ?? 0) - (a._sum.costUsd ?? 0)).map((k) => (
                <li key={k.apiKeyId ?? "none"} className="flex justify-between gap-2 py-2"><span>{name(keys, k.apiKeyId, (x) => `${x.label} · ${x.provider.name}`)} <span className="help">{k._count}</span></span><b>{fmtMoney(k._sum.costUsd ?? 0)}</b></li>
              ))}
            </ul>
          </Card>
          <Card title="По инструментам">
            <ul className="divide-y divide-line text-[14px]">
              {byProject.sort((a, b) => (b._sum.costUsd ?? 0) - (a._sum.costUsd ?? 0)).map((p) => (
                <li key={p.projectId ?? "none"} className="flex justify-between gap-2 py-2"><span>{name(projects, p.projectId, (x) => x.name)} <span className="help">{p._count}</span></span><b>{fmtMoney(p._sum.costUsd ?? 0)}</b></li>
              ))}
            </ul>
          </Card>
          {!onlyMine && (
            <Card title="По людям">
              <ul className="divide-y divide-line text-[14px]">
                {byUser.sort((a, b) => (b._sum.costUsd ?? 0) - (a._sum.costUsd ?? 0)).map((u) => (
                  <li key={u.userId ?? "none"} className="flex justify-between gap-2 py-2"><span>{name(users, u.userId, (x) => x.name)} <span className="help">{u._count}</span></span><b>{fmtMoney(u._sum.costUsd ?? 0)}</b></li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Последние вызовы" className="lg:col-span-3">
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Когда</th>{!onlyMine && <th>Кто</th>}<th>Инструмент · слот</th><th>Провайдер · модель</th><th>Ключ</th><th>Токены</th><th>Цена</th><th>Время</th><th>Статус</th></tr></thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap text-muted">{fmtDate(r.createdAt)}</td>
                      {!onlyMine && <td>{r.user?.name ?? "—"}</td>}
                      <td>{r.project?.name ?? "—"}<span className="text-muted"> · {r.slot?.name ?? "—"}</span></td>
                      <td>{r.provider.name}{r.model ? <span className="text-muted"> · {r.model.modelId}</span> : null}</td>
                      <td>{r.apiKey?.label ?? "—"}</td>
                      <td className="text-muted">{r.inputTokens}/{r.outputTokens}</td>
                      <td>{fmtMoney(r.costUsd)}</td>
                      <td className="text-muted">{(r.durationMs / 1000).toFixed(1)}с</td>
                      <td>{r.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="danger" >{(r.error ?? "ошибка").slice(0, 40)}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
