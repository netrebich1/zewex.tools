import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canCreateKey, keyWhere } from "@/lib/permissions";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { fmtDate, fmtMoney, monthStart } from "@/lib/utils";
import { Icon } from "@/components/Icons";

export const dynamic = "force-dynamic";

export default async function KeysPage() {
  const me = await requireUser();
  const where = keyWhere(me);
  if (!where) redirect("/?denied=1");
  const keys = await prisma.apiKey.findMany({
    where,
    orderBy: [{ provider: { order: "asc" } }, { label: "asc" }],
    include: { provider: true, owner: { select: { name: true } }, team: { select: { name: true } }, _count: { select: { bindings: true } } },
  });
  const spend = await prisma.usageLog.groupBy({ by: ["apiKeyId"], _sum: { costUsd: true }, where: { createdAt: { gte: monthStart() }, apiKeyId: { in: keys.map((k) => k.id) } } });
  const spendMap = new Map(spend.map((s) => [s.apiKeyId, s._sum.costUsd ?? 0]));
  const byProvider = new Map<string, typeof keys>();
  for (const k of keys) byProvider.set(k.provider.name, [...(byProvider.get(k.provider.name) ?? []), k]);
  const addBtn = canCreateKey(me) ? <Link href="/keys/new" className="btn-brand"><Icon.plus width={16} height={16} /> Добавить ключ</Link> : undefined;

  return (
    <>
      <PageHeader title="Ключи" subtitle="Ключ бывает личным, командным или общим. На него ссылаются правила: один ключ можно подключить к нескольким сервисам и командам." actions={addBtn} />
      {keys.length === 0 ? (
        <Empty title="Ключей пока нет" hint={addBtn ? "Добавьте первый ключ, затем подключите его к сервисам и командам." : "Ключи, доступные вам, появятся здесь."} action={addBtn} />
      ) : (
        <div className="space-y-4">
          {[...byProvider.entries()].map(([providerName, list]) => (
            <Card key={providerName} title={providerName}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Название</th><th>Ключ</th><th>Чей</th><th>Статус</th><th>Проверка</th><th>Расход за месяц</th><th>Правил</th></tr></thead>
                  <tbody>
                    {list.map((k) => {
                      const spent = spendMap.get(k.id) ?? 0;
                      const over = k.monthlyLimitUsd != null && spent >= k.monthlyLimitUsd;
                      return (
                        <tr key={k.id}>
                          <td><Link href={`/keys/${k.id}`} className="font-medium hover:underline">{k.label}</Link></td>
                          <td className="font-mono text-[12px] text-muted">{k.secretHint}</td>
                          <td>{k.owner ? <Badge tone="brand">личный · {k.owner.name}</Badge> : k.team ? <Badge tone="ink">команда · {k.team.name}</Badge> : <Badge>общий</Badge>}</td>
                          <td>{k.status === "ACTIVE" ? <Badge tone="ok">активен</Badge> : <Badge tone="danger">выключен</Badge>}</td>
                          <td>{k.lastCheckOk == null ? <span className="text-muted">—</span> : k.lastCheckOk ? <span className="text-ok" title={k.lastCheckNote ?? ""}>✓ {fmtDate(k.lastCheckedAt)}</span> : <span className="text-danger" title={k.lastCheckNote ?? ""}>✕ ошибка</span>}</td>
                          <td className={over ? "text-danger font-medium" : ""}>{fmtMoney(spent)}{k.monthlyLimitUsd != null ? <span className="text-muted"> / {fmtMoney(k.monthlyLimitUsd)}</span> : null}</td>
                          <td>{k._count.bindings}</td>
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
