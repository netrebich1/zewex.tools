import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { SocialNav } from "@/components/social/SocialNav";
import { listRuns } from "@/lib/social/runs";
import { networkOf, parseSettings, RUN_STATUS_LABELS, RUN_TONE } from "@/lib/social/types";
import { fmtDate, fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SocialHome() {
  const me = await requireUser();
  const runs = await listRuns(me, 100);
  return (
    <>
      <SocialNav />
      <PageHeader
        title="Соцсети"
        subtitle="Из статей сайта — посты под каждую соцсеть: свой текст, фото статьи, расписание. На выходе файлы для импорта в Metricool. Pinterest здесь нет — пины делает сервис пинов."
        actions={<Link href="/discovery/social/new" className="btn-brand">Новый прогон</Link>}
      />
      {runs.length === 0 ? (
        <Empty title="Прогонов пока нет" hint="Вставьте ссылки на статьи, отметьте сети — посты напишутся в фоне, вкладку можно закрыть." action={<Link href="/discovery/social/new" className="btn-primary">Создать прогон</Link>} />
      ) : (
        <Card title="Прогоны" description="Откройте прогон, чтобы проверить посты, поправить текст и скачать файлы для Metricool.">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Прогон</th>
                  <th>Статус</th>
                  <th>Статьи</th>
                  <th className="col-sm">Расход</th>
                  <th className="col-sm">Создан</th>
                  <th className="col-sm"></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const s = parseSettings(r.settings);
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/discovery/social/runs/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                        <div className="help line-clamp-1">{s.networks.map((k) => networkOf(k)?.label ?? k).join(", ")} · с {s.schedule.startDate}, {s.schedule.perDay} в день</div>
                      </td>
                      <td><Badge tone={RUN_TONE[r.status] ?? "neutral"}>{RUN_STATUS_LABELS[r.status] ?? r.status}</Badge></td>
                      <td className="whitespace-nowrap">
                        {r.counts.done}/{r.total}
                        {r.counts.error > 0 && <span className="help ml-2 text-danger">ошибок {r.counts.error}</span>}
                      </td>
                      <td className="col-sm help whitespace-nowrap">{fmtMoney(r.costUsd)}</td>
                      <td className="col-sm help whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                      <td className="col-sm text-right"><Link href={`/discovery/social/runs/${r.id}`} className="btn-primary btn-sm">Открыть →</Link></td>
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
