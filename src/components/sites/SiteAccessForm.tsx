import { Field } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { saveSiteAccess } from "@/actions/access";
import type { SiteAccess } from "@prisma/client";

export type AccessRow = SiteAccess & { teams: { teamId: string }[]; viewers: { userId: string }[] };
export type TeamMemberOption = { teamId: string; userId: string; name: string; email: string };

type Props = {
  row?: AccessRow;
  teams: { id: string; name: string }[];
  projects: { id: string; slug: string; name: string }[];
  /** Участники команд (для ограничения видимости отдельными сотрудниками). */
  members: TeamMemberOption[];
};

const chip = "inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[13px] cursor-pointer has-[:checked]:border-brand has-[:checked]:bg-brand/10 has-[:checked]:text-ink hover:border-line-2";

/**
 * Уровень системы: доступ к сайту по REST API WordPress, команда-владелец и дополнительные команды,
 * инструменты, в которые сайт интегрирован, и видимость (все участники команд или только отмеченные сотрудники).
 * Настройки инструментов (доски, стили пинов и т. п.) здесь не живут — они внутри каждого инструмента.
 */
export function SiteAccessForm({ row, teams, projects, members }: Props) {
  const pr = (row?.projects as string[] | null) ?? [];
  const extra = new Set(row?.teams.map((t) => t.teamId) ?? []);
  const viewers = new Set(row?.viewers.map((v) => v.userId) ?? []);
  const byTeam = teams.map((t) => ({ team: t, members: members.filter((m) => m.teamId === t.id) })).filter((g) => g.members.length);
  return (
    <ActionForm action={saveSiteAccess} hidden={{ id: row?.id ?? "" }} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Название"><input name="name" className="input" defaultValue={row?.name ?? ""} placeholder="site.com" /></Field>
        <Field label="Адрес сайта"><input name="baseUrl" className="input" required defaultValue={row?.baseUrl ?? ""} placeholder="https://site.com" /></Field>
        <Field label="Логин WordPress"><input name="username" className="input" required defaultValue={row?.username ?? ""} /></Field>
        <Field label="Application Password" hint={row ? "Пусто — оставить прежний." : "WordPress → Пользователи → Профиль → Application Passwords"}><input name="appPassword" className="input font-mono" autoComplete="off" required={!row} /></Field>
        <Field label="Команда-владелец" hint="Её лидеры управляют доступом; сайт сервиса числится за ней.">
          <select name="teamId" className="input" defaultValue={row?.teamId ?? teams[0]?.id}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </Field>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-line p-3 sm:p-4">
          <div className="font-medium mb-1">Также доступен командам</div>
          <p className="help mb-3">Сайт увидят участники этих команд, помимо команды-владельца.</p>
          <div className="flex flex-wrap gap-1.5">
            {teams.map((t) => <label key={t.id} className={chip}><input type="checkbox" name="teamIds" value={t.id} defaultChecked={extra.has(t.id)} className="h-3.5 w-3.5" /> {t.name}</label>)}
            {teams.length < 2 && <p className="help">Других команд нет.</p>}
          </div>
        </div>
        <div className="rounded-xl border border-line p-3 sm:p-4">
          <div className="font-medium mb-1">В какие инструменты интегрирован сайт</div>
          <p className="help mb-3">Ничего не отмечено — доступен всем инструментам. Настройки самого инструмента (например, доски и стили пинов) делаются внутри него.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {projects.map((p) => <label key={p.id} className="flex items-center gap-1.5 text-[14px]"><input type="checkbox" name="projects" value={p.slug} defaultChecked={pr.includes(p.slug)} className="h-4 w-4" /> {p.name}</label>)}
            {projects.length === 0 && <p className="help">Инструментов пока нет.</p>}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-line p-3 sm:p-4">
        <div className="font-medium mb-1">Кто видит сайт</div>
        <p className="help mb-3">Ничего не отмечено — все участники команд сайта. Отметьте сотрудников, чтобы показывать сайт только им (администраторы и лидеры команды-владельца видят всегда).</p>
        <div className="space-y-2">
          {byTeam.map(({ team, members: ms }) => (
            <div key={team.id} className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-muted w-28 shrink-0 truncate" title={team.name}>{team.name}</span>
              {ms.map((m) => <label key={`${team.id}:${m.userId}`} className={chip} title={m.email}><input type="checkbox" name="viewerIds" value={m.userId} defaultChecked={viewers.has(m.userId)} className="h-3.5 w-3.5" /> {m.name}</label>)}
            </div>
          ))}
          {!byTeam.length && <p className="help">В командах пока нет участников.</p>}
        </div>
      </div>

      <details open={!!(row?.mediaBaseUrl || row?.notes)}><summary className="help cursor-pointer">Отдельный медиа-сайт и заметка</summary>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mt-2">
          <Field label="Адрес медиа-сайта"><input name="mediaBaseUrl" className="input" defaultValue={row?.mediaBaseUrl ?? ""} /></Field>
          <Field label="Логин медиа-сайта"><input name="mediaUsername" className="input" defaultValue={row?.mediaUsername ?? ""} /></Field>
          <Field label="Application Password медиа-сайта"><input name="mediaAppPassword" className="input font-mono" autoComplete="off" /></Field>
          <Field label="Домен медиа-ссылок"><input name="mediaDomain" className="input" defaultValue={row?.mediaDomain ?? ""} /></Field>
          <div className="sm:col-span-2 lg:col-span-4"><Field label="Заметка"><input name="notes" className="input" defaultValue={row?.notes ?? ""} placeholder="Чей сайт, где хостинг…" /></Field></div>
        </div>
      </details>
      <SubmitButton className={row ? undefined : "btn-brand"} pendingText={row ? "Сохраняю…" : "Сохраняю и проверяю…"}>{row ? "Сохранить сайт" : "Добавить сайт"}</SubmitButton>
    </ActionForm>
  );
}
