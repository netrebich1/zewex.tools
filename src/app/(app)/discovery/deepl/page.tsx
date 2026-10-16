import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { JOB_TONE } from "@/components/deepl/DeeplNav";
import { DeeplHeader } from "@/components/deepl/DeeplHeader";
import { listJobs } from "@/lib/deepl/jobs";
import { describeSettings, JOB_STATUS_LABELS, parseSettings } from "@/lib/deepl/types";
import { fmtDate, fmtMoney } from "@/lib/utils";
import { fmtChars } from "@/lib/deepl/keys";

export const dynamic = "force-dynamic";


export default async function DeeplHome() {
  const me = await requireUser();
  const jobs = await listJobs(me, 100);
  const live = jobs.filter((j) => j.status === "QUEUED" || j.status === "RUNNING");
  const week = jobs.filter((j) => Date.now() - new Date(j.createdAt).getTime() < 7 * 86_400_000);
  const weekDone = week.reduce((a, j) => a + j.counts.done + j.counts.warning, 0);
  const weekChars = week.reduce((a, j) => a + j.deeplChars, 0);
  const inWork = live.reduce((a, j) => a + j.counts.pending + j.counts.processing, 0);

  return (
    <>
      <DeeplHeader />
      <PageHeader
        title="DeepL Articler"
        subtitle="Пакетная адаптация статей: берём статьи WordPress по статусу и дате, переводим DeepL по цепочке языков (например UK → EN → DE → UK), правим H2, вычитываем после перевода и возвращаем ключи."
        actions={<Link href="/discovery/deepl/new" className="btn-brand">Новый прогон</Link>}
      />

      <div className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">
        {[
          { label: "Прогонов в работе", value: String(live.length), href: undefined as string | undefined },
          { label: "Статей в очереди и в работе", value: String(inWork) },
          { label: "Статей готово за 7 дней", value: String(weekDone), href: undefined },
          { label: "Символов DeepL за 7 дней", value: fmtChars(weekChars), href: "/discovery/deepl/keys" },
        ].map((s) => (
          <Link key={s.label} href={s.href ?? "/discovery/deepl"} className="kpi block hover:border-brand">
            <div className="kpi-value">{s.value}</div>
            <div className="help">{s.label}</div>
          </Link>
        ))}
      </div>

      {jobs.length === 0 ? (
        <Empty title="Прогонов пока нет" hint="Выберите сайт, статус и даты статей — обработка пойдёт в фоне, вкладку можно закрыть." action={<Link href="/discovery/deepl/new" className="btn-primary">Создать прогон</Link>} />
      ) : (
        <Card title="Прогоны" description="Откройте прогон, чтобы посмотреть статьи по этапам, скопировать итог или опубликовать.">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Прогон</th>
                  <th>Статус</th>
                  <th>Статьи</th>
                  <th>Опубликовано</th>
                  <th>Расход</th>
                  <th>Создан</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const done = j.counts.done + j.counts.warning + j.counts.error;
                  return (
                    <tr key={j.id}>
                      <td>
                        <Link href={`/discovery/deepl/runs/${j.id}`} className="font-medium hover:underline">{j.name}</Link>
                        <div className="help line-clamp-1">{j.siteName} · {describeSettings(parseSettings(j.settings))}</div>
                      </td>
                      <td>
                        <Badge tone={JOB_TONE[j.status] ?? "neutral"}>{JOB_STATUS_LABELS[j.status] ?? j.status}</Badge>
                        {j.stopRequested && <span className="help ml-2">останавливается…</span>}
                      </td>
                      <td className="whitespace-nowrap">
                        {done}/{j.total}
                        {j.counts.warning > 0 && <span className="help ml-2 text-warn">проверить {j.counts.warning}</span>}
                        {j.counts.error > 0 && <span className="help ml-2 text-danger">ошибок {j.counts.error}</span>}
                      </td>
                      <td>{j.published || "—"}</td>
                      <td className="help whitespace-nowrap">{fmtMoney(j.costUsd)} · {fmtChars(j.deeplChars)} симв.</td>
                      <td className="help whitespace-nowrap">{fmtDate(j.createdAt)}</td>
                      <td className="text-right"><Link href={`/discovery/deepl/runs/${j.id}`} className="btn-primary btn-sm">Открыть →</Link></td>
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
