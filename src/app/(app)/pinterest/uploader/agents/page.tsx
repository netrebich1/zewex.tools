import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { AutoForm } from "@/components/projects/AutoForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { isAdmin, requireUploader } from "@/lib/uploader/access";
import { agentRows } from "@/lib/uploader/views";
import { agentLatestVersion, agentZipExists, olderVersion } from "@/lib/uploader/release";
import { saveAgentAction, uploadAgentBuildAction } from "@/actions/uploader";
import { AgentTokenForm, RevokeAgentButton } from "@/components/uploader/AgentControls";
import { AgentBadge, ago } from "@/components/uploader/ui";

export const dynamic = "force-dynamic";

const TZS = ["Europe/Kyiv", "Europe/Warsaw", "Europe/Berlin", "Europe/Moscow", "Asia/Tbilisi", "America/New_York"];

/** Агенты: токены, состояние, параллельность, расписание; скачивание сборки; загрузка сборки (админ). */
export default async function UploaderAgentsPage() {
  const me = await requireUploader();
  const [agents, latest] = await Promise.all([agentRows(me), agentLatestVersion()]);
  const hasZip = await agentZipExists(latest);
  const now = new Date();
  return (
    <>
      <PageHeader title="Агенты" subtitle="Агент — программа «Zewex Uploader» на ПК сотрудника рядом с Dolphin Anty. Он держит связь с порталом, получает задания и заливает файлы." />
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card title={`Мои агенты · ${agents.length}`}>
            {agents.length === 0 ? <p className="help">Агентов нет. Добавьте справа, скачайте программу и вставьте в неё токен.</p> : (
              <div className="space-y-3">{agents.map((a) => (
                <div key={a.id} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
                    <AgentBadge status={a.status} />
                    <b>{a.name}</b>
                    <span className="help">{a.userName} · токен {a.tokenHint}… · версия {a.version ?? "—"}{a.version && olderVersion(a.version, latest) ? <span className="text-warn"> (есть {latest})</span> : null} · {a.state ?? ""} · {ago(a.lastSeenAt, now)}</span>
                    <span className="ml-auto"><RevokeAgentButton id={a.id} /></span>
                  </div>
                  {a.hostInfo && <div className="help mt-1">{[a.hostInfo.os, a.hostInfo.dolphin ? `Dolphin ${a.hostInfo.dolphin}` : null, a.hostInfo.profiles != null ? `профилей ${a.hostInfo.profiles}` : null].filter(Boolean).join(" · ")}</div>}
                  <AutoForm action={saveAgentAction} hidden={{ agentId: a.id }} className="mt-2 flex flex-wrap items-end gap-3" showOk>
                    <label className="block"><span className="label">Название</span><input name="name" className="input py-1 w-[180px]" defaultValue={a.name} /></label>
                    <label className="block"><span className="label">Профилей одновременно</span><input name="parallel" type="number" min={1} max={5} className="input py-1 w-[90px]" defaultValue={a.settings.parallel} /></label>
                    <label className="flex items-center gap-1.5 text-[13px] pb-2"><input type="checkbox" name="enabled" defaultChecked={a.schedule.enabled} /> Запускать каждый день в</label>
                    <input name="time" type="time" className="input py-1 w-[110px]" defaultValue={a.schedule.time} />
                    <select name="tz" className="input py-1" defaultValue={a.schedule.tz}>{[...new Set([a.schedule.tz, ...TZS])].map((tz) => <option key={tz} value={tz}>{tz}</option>)}</select>
                  </AutoForm>
                  <p className="help mt-1">Расписание срабатывает, только если агент на связи: берутся все ваши сайты с профилем и файлом на сегодня без отметки «залито».</p>
                </div>
              ))}</div>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Добавить агента"><AgentTokenForm /></Card>
          <Card title="Программа агента" description={hasZip ? `Текущая сборка: ${latest}.` : "Сборка ещё не загружена."}>
            <div className="space-y-2">
              {hasZip ? <a href="/api/uploader/agent" className="btn-brand w-full">Скачать Zewex Uploader {latest}</a> : <span className="btn-ghost w-full opacity-60">Скачать (пока нет сборки)</span>}
              <Link href="/pinterest/uploader/guide" className="btn-ghost w-full">Как установить и запустить</Link>
            </div>
          </Card>
          {isAdmin(me) && (
            <Card title="Загрузить сборку (админ)" description="ZIP из agent/uploader/build.ps1. После загрузки агенты увидят новую версию при следующем выходе на связь.">
              <ActionForm action={uploadAgentBuildAction} className="space-y-2">
                <label className="block"><span className="label">Версия</span><input name="version" className="input" placeholder="1.0.0" required /></label>
                <label className="block"><span className="label">ZIP</span><input name="zip" type="file" accept=".zip" className="input" required /></label>
                <SubmitButton className="btn-primary" pendingText="Загружаю…">Опубликовать</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
