import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { deleteSiteAccess, saveSiteAccess, testSiteAccess } from "@/actions/access";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const me = await requireUser();
  const isAdmin = me.role === "ADMIN";
  const [teams, projects] = await Promise.all([
    prisma.team.findMany({ where: isAdmin ? {} : { id: { in: me.teamIds } }, orderBy: { name: "asc" } }),
    prisma.project.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, slug: true, name: true } }),
  ]);
  const rows = await prisma.siteAccess.findMany({ where: { teamId: { in: teams.map((t) => t.id) } }, orderBy: [{ teamId: "asc" }, { name: "asc" }] });
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? "";
  const projName = (slug: string) => projects.find((p) => p.slug === slug)?.name ?? slug;

  const Form = ({ row }: { row?: (typeof rows)[number] }) => {
    const pr = (row?.projects as string[] | null) ?? [];
    return (
      <ActionForm action={saveSiteAccess} hidden={{ id: row?.id ?? "" }} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Команда">
            <select name="teamId" className="input" defaultValue={row?.teamId ?? teams[0]?.id}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </Field>
          <Field label="Название"><input name="name" className="input" defaultValue={row?.name ?? ""} placeholder="site.com" /></Field>
          <Field label="Адрес сайта"><input name="baseUrl" className="input" required defaultValue={row?.baseUrl ?? ""} placeholder="https://site.com" /></Field>
          <Field label="Логин WordPress"><input name="username" className="input" required defaultValue={row?.username ?? ""} /></Field>
          <Field label="Application Password" hint={row ? "Пусто — оставить прежний." : "Пользователи → Профиль → Application Passwords"}><input name="appPassword" className="input font-mono" autoComplete="off" required={!row} /></Field>
          <Field label="Домен для ссылок (необязательно)"><input name="linkDomain" className="input" defaultValue={row?.linkDomain ?? ""} /></Field>
        </div>
        <div>
          <span className="label">Каким сервисам доступен</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {projects.map((p) => <label key={p.id} className="flex items-center gap-1.5 text-[14px]"><input type="checkbox" name="projects" value={p.slug} defaultChecked={pr.includes(p.slug)} className="h-4 w-4" /> {p.name}</label>)}
          </div>
          <p className="help mt-1">Ничего не отмечено — доступен всем сервисам команды.</p>
        </div>
        <details><summary className="help cursor-pointer">Отдельный медиа-сайт и заметка</summary>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mt-2">
            <Field label="Адрес медиа-сайта"><input name="mediaBaseUrl" className="input" defaultValue={row?.mediaBaseUrl ?? ""} /></Field>
            <Field label="Логин медиа-сайта"><input name="mediaUsername" className="input" defaultValue={row?.mediaUsername ?? ""} /></Field>
            <Field label="Application Password медиа-сайта"><input name="mediaAppPassword" className="input font-mono" autoComplete="off" /></Field>
            <Field label="Домен медиа-ссылок"><input name="mediaDomain" className="input" defaultValue={row?.mediaDomain ?? ""} /></Field>
            <div className="sm:col-span-2 lg:col-span-4"><Field label="Заметка"><input name="notes" className="input" defaultValue={row?.notes ?? ""} placeholder="Чей сайт, где хостинг…" /></Field></div>
          </div>
        </details>
        <SubmitButton pendingText="Сохраняю…">{row ? "Сохранить" : "Добавить доступ"}</SubmitButton>
      </ActionForm>
    );
  };

  return (
    <>
      <PageHeader title="Доступы к сайтам" subtitle="Логины WordPress ваших сайтов. Вводятся один раз и назначаются сервисам и командам, как ключи ИИ." />
      <div className="space-y-4">
        <Card title={`Сайты: ${rows.length}`}>
          {rows.length === 0 ? <Empty title="Доступов пока нет" hint="Добавьте первый сайт формой ниже." /> : (
            <div className="space-y-2">
              {rows.map((w) => {
                const pr = (w.projects as string[] | null) ?? [];
                return (
                  <details key={w.id} className="rounded-xl border border-line p-3 sm:p-4 open:bg-surface-2/40">
                    <summary className="cursor-pointer list-none flex flex-wrap items-center gap-2">
                      <b>{w.name}</b>
                      <span className="help">{w.baseUrl} · {teamName(w.teamId)}</span>
                      <span className="flex flex-wrap gap-1 ml-1">{pr.length ? pr.map((s) => <Badge key={s} tone="neutral">{projName(s)}</Badge>) : <Badge tone="neutral">все сервисы</Badge>}</span>
                      {w.lastCheckedAt && <Badge tone={w.lastCheckOk ? "ok" : "danger"}>{w.lastCheckOk ? "работает" : "ошибка"}</Badge>}
                    </summary>
                    <div className="mt-3 space-y-3">
                      {w.lastCheckNote && <p className="help">{w.lastCheckNote} ({fmtDate(w.lastCheckedAt)})</p>}
                      <Form row={w} />
                      <div className="flex gap-2">
                        <ActionForm action={testSiteAccess} className="inline" hidden={{ id: w.id }}><SubmitButton className="btn-ghost btn-sm" pendingText="Проверяю…">Проверить подключение</SubmitButton></ActionForm>
                        <ActionForm action={deleteSiteAccess} className="inline" hidden={{ id: w.id }}><SubmitButton className="btn-danger btn-sm" confirm="Удалить доступ?" pendingText="…">Удалить</SubmitButton></ActionForm>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </Card>
        <Card title="Новый сайт"><Form /></Card>
      </div>
    </>
  );
}
