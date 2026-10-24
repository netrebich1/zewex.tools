import Link from "next/link";
import { Card, Empty, PageHeader } from "@/components/ui";
import { requireUploader } from "@/lib/uploader/access";
import { runRows } from "@/lib/uploader/views";
import { formatRu } from "@/lib/pins/schedule/math";
import { RunBadge, dt } from "@/components/uploader/ui";

export const dynamic = "force-dynamic";

export default async function UploaderRunsPage() {
  const me = await requireUploader();
  const runs = await runRows(me, 100);
  return (
    <>
      <PageHeader title="Запуски" subtitle="Каждый запуск — пачка визитов агента в профили Dolphin: заливка файлов, затем через 10 минут проверка истории загрузок." />
      {runs.length === 0 ? <Empty title="Запусков ещё не было" hint="Нажмите «Запустить заливку» на вкладке «Сегодня»." action={<Link href="/pinterest/uploader" className="btn-brand">Сегодня</Link>} /> : (
        <Card>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Создан</th><th>День файлов</th><th>Агент</th><th>Статус</th><th>Готово</th><th>Ошибок</th><th>Пропущено</th><th>Источник</th><th>Завершён</th></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap"><Link href={`/pinterest/uploader/runs/${r.id}`} className="font-medium hover:underline">{dt(r.createdAt)}</Link></td>
                <td>{formatRu(r.day)}</td>
                <td>{r.agent.name}</td>
                <td><RunBadge status={r.status} />{r.phase === "verify" && r.status !== "DONE" ? <span className="help ml-1">проверка {r.verifyAttempts}</span> : null}</td>
                <td className="tabular-nums">{r.done}/{r.total}</td>
                <td className="tabular-nums">{r.failed || ""}</td>
                <td className="tabular-nums">{r.skipped || ""}</td>
                <td className="help">{r.source === "schedule" ? "расписание" : "кнопка"}</td>
                <td className="help whitespace-nowrap">{r.finishedAt ? dt(r.finishedAt) : "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}
    </>
  );
}
