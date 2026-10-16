import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { DomainsNav, STATUS_TONE } from "@/components/domains/DomainsNav";
import { listRuns } from "@/lib/domains/runs";
import { RUN_STATUS_LABELS } from "@/lib/domains/types";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DomainsHome() {
  const me = await requireUser();
  const runs = await listRuns(me, 100);
  const live = runs.filter((r) => r.status === "QUEUED" || r.status === "RUNNING").length;
  const totalAvailable = runs.reduce((a, r) => a + r.totalAvailable, 0);
  const totalSelected = runs.reduce((a, r) => a + r.selected, 0);

  return (
    <>
      <DomainsNav />
      <PageHeader
        title="Подбор доменов"
        subtitle="Бренды × приставки трёх уровней × зоны. Свободные домены проверяются по RDAP, выдача Google подсказывает приставки конкурентов, ИИ выбирает лучшие."
        actions={<Link href="/gambling/domains/new" className="btn-brand">Новый подбор</Link>}
      />

      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: "Подборов в работе", value: live },
          { label: "Свободных доменов найдено", value: totalAvailable },
          { label: "Выбрано для регистрации", value: totalSelected },
        ].map((s) => (
          <div key={s.label} className="kpi">
            <div className="kpi-value">{s.value}</div>
            <div className="help">{s.label}</div>
          </div>
        ))}
      </div>

      {runs.length === 0 ? (
        <Empty title="Подборов пока нет" hint="Вставьте список брендов, зоны и приставки — проверка пройдёт в фоне." action={<Link href="/gambling/domains/new" className="btn-primary">Создать подбор</Link>} />
      ) : (
        <Card title="Подборы" description="Нажмите на подбор, чтобы выбрать домены, запустить ИИ-отбор или выгрузить файл.">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Подбор</th>
                  <th>Статус</th>
                  <th>Бренды</th>
                  <th>Страна</th>
                  <th>Проверено</th>
                  <th>Свободно</th>
                  <th>Выбрано</th>
                  <th>Создан</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const pct = r.progress && r.progress.brandsTotal ? Math.round((r.progress.brandIndex / r.progress.brandsTotal) * 100) : null;
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/gambling/domains/runs/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                        {r.error && <div className="help text-danger line-clamp-1">{r.error}</div>}
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{RUN_STATUS_LABELS[r.status] ?? r.status}</Badge>
                        {r.status === "RUNNING" && pct != null && <span className="help ml-2">{pct}% · {r.progress?.brand}</span>}
                      </td>
                      <td>{r.brands} <span className="help">· {r.perBrand} на бренд · зон: {r.tlds}</span></td>
                      <td className="uppercase">{r.countryCode}</td>
                      <td>{r.totalChecked}</td>
                      <td className="font-medium">{r.totalAvailable}</td>
                      <td>{r.selected}</td>
                      <td className="help whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                      <td className="text-right"><Link href={`/gambling/domains/runs/${r.id}`} className="btn-primary btn-sm">Открыть →</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
