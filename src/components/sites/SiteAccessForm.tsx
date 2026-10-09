import { Field } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { saveSiteAccess } from "@/actions/access";
import type { SiteAccess } from "@prisma/client";

type Props = {
  row?: SiteAccess;
  teams: { id: string; name: string }[];
  projects: { id: string; slug: string; name: string }[];
};

/** Доступ к сайту по REST API WordPress + команда + сервисы. Одна форма для создания и правки. */
export function SiteAccessForm({ row, teams, projects }: Props) {
  const pr = (row?.projects as string[] | null) ?? [];
  return (
    <ActionForm action={saveSiteAccess} hidden={{ id: row?.id ?? "" }} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Название"><input name="name" className="input" defaultValue={row?.name ?? ""} placeholder="site.com" /></Field>
        <Field label="Адрес сайта"><input name="baseUrl" className="input" required defaultValue={row?.baseUrl ?? ""} placeholder="https://site.com" /></Field>
        <Field label="Домен для ссылок (необязательно)" hint="Если ссылки должны вести на другой домен."><input name="linkDomain" className="input" defaultValue={row?.linkDomain ?? ""} /></Field>
        <Field label="Логин WordPress"><input name="username" className="input" required defaultValue={row?.username ?? ""} /></Field>
        <Field label="Application Password" hint={row ? "Пусто — оставить прежний." : "WordPress → Пользователи → Профиль → Application Passwords"}><input name="appPassword" className="input font-mono" autoComplete="off" required={!row} /></Field>
        <Field label="Команда">
          <select name="teamId" className="input" defaultValue={row?.teamId ?? teams[0]?.id}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </Field>
      </div>
      <div className="rounded-xl border border-line p-3 sm:p-4">
        <div className="font-medium mb-1">Каким сервисам доступен сайт</div>
        <p className="help mb-3">Ничего не отмечено — доступен всем сервисам команды.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {projects.map((p) => <label key={p.id} className="flex items-center gap-1.5 text-[14px]"><input type="checkbox" name="projects" value={p.slug} defaultChecked={pr.includes(p.slug)} className="h-4 w-4" /> {p.name}</label>)}
          {projects.length === 0 && <p className="help">Сервисов пока нет.</p>}
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
      <SubmitButton className={row ? undefined : "btn-brand"} pendingText={row ? "Сохраняю…" : "Сохраняю и проверяю…"}>{row ? "Сохранить доступ" : "Добавить сайт"}</SubmitButton>
    </ActionForm>
  );
}
