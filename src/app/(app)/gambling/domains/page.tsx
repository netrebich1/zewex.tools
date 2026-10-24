import Link from "next/link";
import { RenameRun } from "@/components/domains/RenameRun";
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

      <div className="grid grid-cols-1 gap-3 mb-6 sm:grid-cols-3">
        {[
          { label: "Подборов в работе", value: live },
          { label: "Свободных доменов найдено", value: totalAvailable },
          { label: "Выбрано для регистрации", value: totalSelected },
        ].map((s) => (
          // На телефоне плитка — строка «число подпись»; `!` — .kpi вне слоёв.
          <div key={s.label} className="kpi min-w-0 !flex-row items-baseline gap-3 sm:!flex-col sm:gap-1">
            <div className="kpi-value !text-[22px] sm:!text-[30px]">{s.value}</div>
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
                  <th className="col-sm">Бренды</th>
                  <th className="col-sm">Страна</th>
                  <th className="col-sm">Проверено</th>
                  <th>Свободно</th>
                  <th>Выбрано</th>
                  <th className="col-sm">Создан</th>
                  <th className="col-sm"></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const pct = r.progress && r.progress.brandsTotal ? Math.round((r.progress.brandIndex / r.progress.brandsTotal) * 100) : null;
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/gambling/domains/runs/${r.id}`} className="font-medium hover:underline">{r.name}</Link><RenameRun id={r.id} name={r.name} compact />
                        {r.error && <div className="help text-danger line-clamp-1">{r.error}</div>}
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{RUN_STATUS_LABELS[r.status] ?? r.status}</Badge>
                        {r.status === "RUNNING" && pct != null && <span className="help ml-2">{pct}% · {r.progress?.brand}</span>}
                      </td>
                      <td className="col-sm">{r.brands} <span className="help">· {r.perBrand} на бренд · зон: {r.tlds}</span></td>
                      <td className="col-sm uppercase">{r.countries.join(", ")}</td>
                      <td className="col-sm">{r.totalChecked}</td>
                      <td className="font-medium">{r.totalAvailable}</td>
                      <td>{r.selected}</td>
                      <td className="col-sm help whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                      <td className="col-sm text-right"><Link href={`/gambling/domains/runs/${r.id}`} className="btn-primary btn-sm">Открыть →</Link></td>
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
