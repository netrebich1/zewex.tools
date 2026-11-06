import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { AutoForm } from "@/components/projects/AutoForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { isAdmin, requireUploader } from "@/lib/uploader/access";
import { agentRows } from "@/lib/uploader/views";
import { agentLatestVersion, downloads, olderVersion } from "@/lib/uploader/release";
import { setRows } from "@/lib/uploader/sets";
import { saveAgentAction, uploadAgentBuildAction } from "@/actions/uploader";
import { agentTeamOptions, myReadiness, teamTokenRows } from "@/lib/uploader/teams";
import { TeamReadinessCard } from "@/components/uploader/TeamReadiness";
import { AgentTokenForm, RevokeAgentButton } from "@/components/uploader/AgentControls";
import { AgentBadge, ago } from "@/components/uploader/ui";

export const dynamic = "force-dynamic";

const TZS = ["Europe/Kyiv", "Europe/Warsaw", "Europe/Berlin", "Europe/Moscow", "Asia/Tbilisi", "America/New_York"];

/** Агенты: токены, состояние, параллельность, расписание; скачивание сборки; загрузка сборки (админ). */
export default async function UploaderAgentsPage() {
  const me = await requireUploader();
  const [agents, latest, dl, sets, teams, tokens, ready] = await Promise.all([agentRows(me), agentLatestVersion(), downloads(), setRows(me), agentTeamOptions(me), teamTokenRows(me), myReadiness(me)]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const hasToken = new Set(tokens.filter((t) => t.hint).map((t) => t.teamId));
  const noTeam = agents.filter((a) => !a.teamId);
  const noToken = [...new Set(agents.map((a) => a.teamId).filter((t): t is string => !!t && !hasToken.has(t)))];
  const now = new Date();
  return (
    <>
      <PageHeader title="Агенты" subtitle="Агент — программа «Zewex Uploader» на ПК сотрудника рядом с Dolphin Anty. Он держит связь с порталом, получает задания и заливает файлы." />
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          {noTeam.length > 0 && <div className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-[13.5px]"><b>Без команды: {noTeam.map((a) => a.name).join(", ")}.</b> Выберите команду в карточке агента — без неё он не получит токен Dolphin.</div>}
          {noToken.length > 0 && <div className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-[13.5px]"><b>Нет токена Dolphin API у команды: {noToken.map((t) => teamName.get(t) ?? t).join(", ")}.</b> Без него агенты команды не прочитают и не откроют профили. Токен вводит администратор или лид команды в <Link href="/pinterest/uploader/settings" className="underline">Настройках</Link> (кабинет dolphin-anty.com → API).</div>}
          <TeamReadinessCard rows={ready} />
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
                    <label className="block"><span className="label">Команда (токен Dolphin)</span>
                      <select name="teamId" className="input py-1" defaultValue={a.teamId ?? ""}>
                        <option value="" disabled>— выберите —</option>
                        {teams.map((t) => <option key={t.id} value={t.id}>{t.name}{hasToken.has(t.id) ? "" : " · нет токена"}</option>)}
                        {a.teamId && !teamName.has(a.teamId) ? <option value={a.teamId}>чужая команда</option> : null}
                      </select>
                    </label>
                    <label className="block"><span className="label">Профилей одновременно</span><input name="parallel" type="number" min={1} max={5} className="input py-1 w-[90px]" defaultValue={a.settings.parallel} /></label>
                    <label className="flex items-center gap-1.5 text-[13px] pb-2"><input type="checkbox" name="enabled" defaultChecked={a.schedule.enabled} /> Запускать каждый день в</label>
                    <input name="time" type="time" className="input py-1 w-[110px]" defaultValue={a.schedule.time} />
                    <select name="tz" className="input py-1" defaultValue={a.schedule.tz}>{[...new Set([a.schedule.tz, ...TZS])].map((tz) => <option key={tz} value={tz}>{tz}</option>)}</select>
                    <label className="block"><span className="label">Набор сайтов</span>
                      <select name="setId" className="input py-1" defaultValue={a.schedule.setId ?? ""}>
                        <option value="">все сайты с профилем</option>
                        {sets.map((st) => <option key={st.id} value={st.id}>{st.name} ({st.siteIds.length})</option>)}
                      </select>
                    </label>
                  </AutoForm>
                  <p className="help mt-1">Расписание срабатывает, только если агент на связи: берутся сайты набора (или все ваши с профилем), у которых есть файл на сегодня и нет отметки «залито». Наборы — на <Link href="/pinterest/uploader/sets" className="underline">странице «Наборы»</Link>.</p>
                </div>
              ))}</div>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Добавить агента"><AgentTokenForm teams={teams} defaultTeamId={me.activeTeamId ?? (teams.length === 1 ? teams[0].id : null)} /></Card>
          <Card title="Скачать" description="Всё лежит на нашем сервере. Ничего дополнительно ставить не нужно.">
            <div className="space-y-2">
              {dl.agent ? <a href={dl.agent.url} className="btn-brand w-full">Zewex Uploader {dl.agent.version} · {dl.agent.sizeMb} МБ</a> : <span className="btn-ghost w-full opacity-60">Zewex Uploader (сборка появится после деплоя)</span>}
              {dl.dolphin ? <a href={dl.dolphin.url} className="btn-ghost w-full">Dolphin Anty · {dl.dolphin.sizeMb} МБ{dl.dolphin.date ? ` · ${dl.dolphin.date}` : ""}</a> : <span className="btn-ghost w-full opacity-60">Dolphin Anty (нет файла)</span>}
              <Link href="/pinterest/uploader/guide" className="btn-ghost w-full">Инструкция по установке</Link>
            </div>
          </Card>
          {isAdmin(me) && (
            <Card title="Загрузить сборку вручную (админ)" description="Обычно не нужно: сборка собирается на сервере при каждом деплое (scripts/uploader/build-agent.sh). Сюда — только если собирали отдельно.">
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
