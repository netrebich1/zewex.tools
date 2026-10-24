import Link from "next/link";
import { Card, PageHeader, sp, type SearchParams } from "@/components/ui";
import { requireUploader } from "@/lib/uploader/access";
import { agentRows, runRows, todayRows } from "@/lib/uploader/views";
import { ERROR_LABELS, isDay, type ErrorKind } from "@/lib/uploader/types";
import { TZ } from "@/lib/pins/runs/stats";
import { addDays, formatRu, todayKey } from "@/lib/pins/schedule/math";
import { StartRunForm, type StartSite } from "@/components/uploader/StartRunForm";
import { AccountBadge, AgentBadge, RunBadge, TaskBadge, ago, dt } from "@/components/uploader/ui";

export const dynamic = "force-dynamic";

/** «Сегодня»: сайты с файлом на день, профиль, состояние аккаунта, залито ли, последняя попытка; запуск. */
export default async function UploaderTodayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUploader();
  const q = await searchParams;
  const today = todayKey(new Date(), TZ);
  const day = isDay(sp(q, "day") ?? "") ? (sp(q, "day") as string) : today;
  const [rows, agents, runs] = await Promise.all([todayRows(me, day), agentRows(me), runRows(me, 5)]);
  const now = new Date();
  const withFile = rows.filter((r) => r.file);
  const uploaded = withFile.filter((r) => r.uploaded).length;
  const noProfile = withFile.filter((r) => !r.account?.profileId).length;
  const sites: StartSite[] = withFile.map((r) => {
    const a = r.account;
    const paused = a && (a.status === "paused" || a.status === "limited") && a.pausedUntil && a.pausedUntil > now;
    const why = !a?.profileId ? "нет профиля" : a.status === "needs_login" ? "нужен вход" : a.status === "off" ? "выключен" : a.status === "banned" ? "заблокирован" : paused ? `пауза до ${dt(a.pausedUntil)}` : r.lastTask && ["QUEUED", "LEASED"].includes(r.lastTask.status) ? "уже в очереди" : null;
    return { id: r.site.id, name: r.site.name, count: r.file!.count, ready: !why, why, uploaded: !!r.uploaded };
  });
  const quick = (d: string, label: string) => <Link href={`/pinterest/uploader?day=${d}`} className={`badge px-3 py-1 max-sm:!py-1.5 max-sm:min-h-8 ${day === d ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{label}</Link>;

  return (
    <>
      <PageHeader title={`Заливка на ${formatRu(day)}`} subtitle="Файл выгрузки каждого сайта агент загружает в Pinterest через профиль Dolphin Anty и ставит отметку в «Проектах». Запуск кнопкой или по расписанию агента." />
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {quick(today, "Сегодня")}{quick(addDays(today, 1), "Завтра")}{quick(addDays(today, -1), "Вчера")}
          <span className="help ml-2">Сайтов с файлом: <b>{withFile.length}</b> · залито: <b>{uploaded}</b>{noProfile ? <> · <span className="text-warn">без профиля: {noProfile}</span> (<Link href="/pinterest/uploader/mapping" className="underline">сопоставить</Link>)</> : null}</span>
        </div>
        <Card title="Запустить заливку" description="Отмечены сайты, у которых есть файл на день и нет отметки «залито». Агент идёт по сайтам по очереди (или по несколько, если задано), с паузами как у человека.">
          {withFile.length ? <StartRunForm sites={sites} agents={agents.map((a) => ({ id: a.id, name: a.name, status: a.status, parallel: a.settings.parallel }))} day={day} /> : <p className="help">На {formatRu(day)} готовых пинов нет ни у одного сайта.</p>}
        </Card>
        <Card title={`Сайты · ${rows.length}`}>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Сайт</th><th>Файл на день</th><th>Профиль Dolphin</th><th>Аккаунт</th><th>Залито</th><th>Последняя попытка</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.site.id} className={r.file && !r.uploaded && !r.account?.profileId ? "bg-warn-soft/40" : ""}>
                <td className="font-medium">{r.site.accessId ? <Link href={`/pinterest/projects/${r.site.accessId}?tab=uploads`} className="hover:underline">{r.site.name}</Link> : r.site.name}</td>
                <td>{r.file ? <><span className="tabular-nums">{r.file.count}</span> <span className="help">{r.file.fileName}{r.file.issues ? ` · проблем ${r.file.issues}` : ""}</span></> : <span className="help">—</span>}</td>
                <td>{r.account?.profileId ? <span title={r.account.profileId}>{r.account.profileName ?? r.account.profileId}</span> : <Link href="/pinterest/uploader/mapping" className="text-warn underline">не задан</Link>}</td>
                <td>{r.account ? <><AccountBadge status={r.account.status} />{r.account.pinUsername ? <span className="help ml-1">@{r.account.pinUsername}</span> : null}</> : <span className="help">—</span>}</td>
                <td>{r.uploaded ? <span className="badge bg-ok-soft text-ok">✓ {dt(r.uploaded.at)}{r.uploaded.source === "auto" ? " · авто" : ""}</span> : <span className="help">нет</span>}</td>
                <td className="text-[12.5px]">{r.lastTask ? <Link href={`/pinterest/uploader/runs/${r.lastTask.runId}`} className="hover:underline"><TaskBadge status={r.lastTask.status} /> {r.lastTask.errorKind ? <span className="text-danger">{ERROR_LABELS[r.lastTask.errorKind as ErrorKind] ?? r.lastTask.error}</span> : r.lastTask.finishedAt ? ago(r.lastTask.finishedAt, now) : ""}</Link> : <span className="help">—</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Агенты" actions={<Link href="/pinterest/uploader/agents" className="btn-ghost btn-sm">Все агенты</Link>}>
            {agents.length ? <ul className="space-y-1.5 text-[13.5px]">{agents.map((a) => <li key={a.id} className="flex flex-wrap items-center gap-2"><AgentBadge status={a.status} /><b>{a.name}</b><span className="help">{a.userName} · {a.state ?? ""} · {ago(a.lastSeenAt, now)}{a.schedule.enabled ? ` · расписание ${a.schedule.time}` : ""}</span></li>)}</ul> : <p className="help">Агентов нет. <Link href="/pinterest/uploader/agents" className="underline">Добавить</Link>.</p>}
          </Card>
          <Card title="Последние запуски" actions={<Link href="/pinterest/uploader/runs" className="btn-ghost btn-sm">Все запуски</Link>}>
            {runs.length ? <ul className="space-y-1.5 text-[13.5px]">{runs.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2"><RunBadge status={r.status} /><Link href={`/pinterest/uploader/runs/${r.id}`} className="hover:underline">{formatRu(r.day)} · {r.agent.name}</Link><span className="help">{r.done}/{r.total} готово{r.failed ? `, ошибок ${r.failed}` : ""}{r.skipped ? `, пропущено ${r.skipped}` : ""} · {ago(r.createdAt, now)}</span></li>)}</ul> : <p className="help">Запусков ещё не было.</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
